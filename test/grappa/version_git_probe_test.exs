defmodule Grappa.Version.GitProbeTest do
  @moduledoc """
  #533 / #542 — the build-time git introspection that keeps `CTCP VERSION`
  honest.

  The bug these tests lock down: `Grappa.Version` used to re-trigger its
  compile snapshot off `<gitdir>/HEAD` + `<gitdir>/packed-refs`. Neither
  moves on a `git pull --ff-only` of an ALREADY-checked-out branch — the
  advanced commit lands in the LOOSE ref `<gitdir>/refs/heads/<branch>`,
  which was unwatched. So an incremental `mix compile` (every production
  deploy is one) left `Grappa.Version.beam` untouched and shipped the
  previous build's sha. Live: the node reported `0.6.0-6ba1235a` while
  running `a40ad10e`, the sole `.beam` still carrying the old mtime.

  These run against throwaway git repos (created per-test under
  `System.tmp_dir!()`) so the assertions are deterministic — the test build's
  own git state (untagged worktree, maybe packed, maybe dirty) can't be
  pinned to a literal.
  """
  use ExUnit.Case, async: true

  alias Grappa.Version.GitProbe

  # A unique repo dir under System.tmp_dir!() — NOT ExUnit's `:tmp_dir` tag,
  # which lives under `<project>/tmp` (the `./:/app` bind mount). On macOS
  # Docker the bind mount has consistency lag: a just-created dir isn't always
  # visible to the `git` subprocess yet, so `git` fails getcwd() ("unable to
  # get current working directory") intermittently. `/tmp` is container-local
  # (no bind mount) → consistent and fast.
  setup do
    dir = Path.join(System.tmp_dir!(), "grappa-gitprobe-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)
    %{dir: dir}
  end

  # Explicit, deterministic env (Credo UnsafeExec is satisfied by an
  # overwriting env — same pattern as version_single_source_test): PATH so
  # git resolves, committer identity via GIT_* so `commit` never depends on
  # ambient/global config, and NO grappa secrets inherited.
  @git_env [
    {"PATH", System.get_env("PATH") || "/usr/bin:/bin"},
    {"GIT_AUTHOR_NAME", "grappa test"},
    {"GIT_AUTHOR_EMAIL", "test@grappa"},
    {"GIT_COMMITTER_NAME", "grappa test"},
    {"GIT_COMMITTER_EMAIL", "test@grappa"}
  ]

  # Set up a real, minimal git repo with one commit on `main`. `-b main` is
  # the same flag the deploy bats fixtures rely on, so the container's git
  # supports it.
  defp init_repo!(dir) do
    git!(dir, ["init", "-q", "-b", "main"])
    File.write!(Path.join(dir, "a.txt"), "one\n")
    git!(dir, ["add", "-A"])
    git!(dir, ["commit", "-qm", "one"])
  end

  defp git!(dir, args) do
    {out, 0} = System.cmd("git", args, cd: dir, env: @git_env, stderr_to_stdout: true)
    String.trim(out)
  end

  describe "resource_paths/1 — the files that must dirty the version snapshot (#533/#542)" do
    test "includes the current branch's LOOSE ref, the file a same-branch fast-forward moves",
         %{dir: dir} do
      init_repo!(dir)

      loose_ref = Path.join(dir, ".git/refs/heads/main")
      # Sanity: a fresh repo keeps the branch tip loose (not yet packed), so
      # this is exactly the file `pull --ff-only` rewrites — the #533 gap.
      assert File.exists?(loose_ref)

      paths = GitProbe.resource_paths(dir)

      assert loose_ref in paths,
             "the loose current-branch ref must be watched or a same-branch FF goes unseen"
    end

    test "also includes HEAD (branch switch / detached HEAD moves this one)", %{dir: dir} do
      init_repo!(dir)
      assert Path.join(dir, ".git/HEAD") in GitProbe.resource_paths(dir)
    end

    test "returns a watch-set member that does NOT exist yet — its appearance is the signal (#1797)",
         %{dir: dir} do
      init_repo!(dir)

      packed_refs = Path.join(dir, ".git/packed-refs")
      # A fresh `git init` + commit writes no packed-refs file at all; it
      # appears the first time refs are packed. That is precisely a watch-set
      # member whose EXISTENCE is the thing that changes.
      refute File.exists?(packed_refs)

      assert packed_refs in GitProbe.resource_paths(dir),
             "a not-yet-existing watch path must still be registered: Mix records it as " <>
               "{0, 0} and reports it stale the moment it appears with a non-zero size"
    end

    test "is [] when there is no .git (a release tarball / package)", %{dir: dir} do
      # A fresh dir with no `git init`.
      assert GitProbe.resource_paths(dir) == []
    end
  end

  describe "resource_paths/1 — a PACKED branch ref is still watched (#1797)" do
    test "a commit on a packed branch rewrites ONLY the loose ref — HEAD and packed-refs are byte-identical",
         %{dir: dir} do
      init_repo!(dir)
      git!(dir, ["pack-refs", "--all"])

      head = Path.join(dir, ".git/HEAD")
      packed_refs = Path.join(dir, ".git/packed-refs")
      loose_ref = Path.join(dir, ".git/refs/heads/main")

      refute File.exists?(loose_ref), "pack-refs --all removes the loose ref"
      head_before = File.read!(head)
      packed_before = File.read!(packed_refs)
      sha_before = git!(dir, ["rev-parse", "--short", "HEAD"])

      # The production shape: the branch tip advances (a `git pull --ff-only`
      # of an already-checked-out branch does exactly this write).
      File.write!(Path.join(dir, "a.txt"), "two\n")
      git!(dir, ["add", "-A"])
      git!(dir, ["commit", "-qm", "two"])

      assert git!(dir, ["rev-parse", "--short", "HEAD"]) != sha_before
      assert File.exists?(loose_ref), "the advanced tip lands in the LOOSE ref"

      assert File.read!(head) == head_before,
             "HEAD does not move on a same-branch advance — it cannot carry the signal"

      assert File.read!(packed_refs) == packed_before,
             "packed-refs keeps the STALE tip — it cannot carry the signal either"
    end

    test "the loose ref is in the watch set even while it is currently packed away", %{dir: dir} do
      init_repo!(dir)
      git!(dir, ["pack-refs", "--all"])

      loose_ref = Path.join(dir, ".git/refs/heads/main")
      refute File.exists?(loose_ref)

      assert loose_ref in GitProbe.resource_paths(dir),
             "the ref layout is MUTABLE at runtime (`git gc --auto` packs, `update-ref` " <>
               "unpacks), so a watch set conditioned on the CURRENT layout goes blind: a " <>
               "build taken while packed never sees the next fast-forward (#1797)"
    end
  end

  describe "facts/1 — the build-time snapshot folded into the reported version" do
    test "reflects THIS repo's HEAD sha, untagged and clean", %{dir: dir} do
      init_repo!(dir)
      sha = git!(dir, ["rev-parse", "--short", "HEAD"])

      facts = GitProbe.facts(dir)

      assert facts.short_sha == sha
      assert facts.exact_tag == nil
      assert facts.dirty? == false
    end

    test "reports dirty? = true with an uncommitted change", %{dir: dir} do
      init_repo!(dir)
      File.write!(Path.join(dir, "a.txt"), "two\n")

      assert GitProbe.facts(dir).dirty? == true
    end

    test "reports the exact tag when HEAD is on one", %{dir: dir} do
      init_repo!(dir)
      git!(dir, ["tag", "v9.9.9"])

      assert GitProbe.facts(dir).exact_tag == "v9.9.9"
    end

    test "is nil when there is no .git (a release tarball / package)", %{dir: dir} do
      assert GitProbe.facts(dir) == nil
    end
  end
end
