defmodule Grappa.Version.GitProbe do
  @moduledoc """
  Build-time git introspection for `Grappa.Version` — resolves BOTH the
  compile snapshot of the git state (`facts/1`) AND the set of git files
  whose change must re-trigger compilation so the snapshot never goes stale
  (`resource_paths/1`; #533 / #542).

  Lives beside `Grappa.Version` (same `Boundary`) rather than inside it
  because the module body of `Grappa.Version` calls these functions AT
  COMPILE TIME — to fold the snapshot into `@git_facts` and to register
  `@external_resource` paths — and a module cannot call its own
  not-yet-compiled functions. A sibling module compiled first can, and the
  split makes the git logic unit-testable against throwaway repos instead of
  only the unstable git state of the build itself.

  ## Why `resource_paths/1` is not just `HEAD` + `packed-refs` (#533 / #542)

  `Grappa.Version` used to re-trigger its snapshot off `<gitdir>/HEAD` +
  `<gitdir>/packed-refs`. Neither moves on a `git pull --ff-only` of an
  ALREADY-checked-out branch: `HEAD` stays `ref: refs/heads/<branch>` and
  the advanced commit lands in the LOOSE ref `<gitdir>/refs/heads/<branch>`,
  which was unwatched. Every production deploy is an INCREMENTAL `mix
  compile` over a warm `_build` (the jail does NOT wipe it — `git pull → mix
  compile → mix release --overwrite`), so the version `.beam` was never
  recompiled and the release shipped the previous build's sha. Observed live
  (#542, 2026-07-29): the node reported `0.6.0-6ba1235a` while running
  `a40ad10e`; the sole `.beam` still carrying the previous compile's mtime
  was `Elixir.Grappa.Version.beam`. The moduledoc's old claim that "a cold
  deploy recompiles from scratch" was simply false — the jail cold path is
  an incremental compile too.

  So `resource_paths/1` watches the current branch's LOOSE ref (the file a
  same-branch fast-forward moves) plus `HEAD` (branch switch / detached
  HEAD) plus `packed-refs` (a packed ref layout). We ask `git` itself for
  the paths (`rev-parse --git-path`) so the answer is correct across a
  normal checkout, a packed ref, a detached HEAD, and a `git worktree`
  (where `.git` is a FILE and refs live in a shared common dir) — no
  hand-parsing of `.git` internals.
  """

  # No `use Boundary` — this module belongs to the `Grappa.Version` boundary
  # (nearest ancestor with `use Boundary`); intra-boundary calls are allowed.

  @typedoc """
  Build-time snapshot of the git state, folded into the reported version by
  `Grappa.Version.derive/2`. `nil` when there was no `.git` at build (a
  package built from a release tarball) — `derive/2` then reports the bare
  base version.

    * `:exact_tag` — the tag `HEAD` points at exactly (`git describe
      --tags --exact-match`), or `nil` when `HEAD` is not on a tag.
    * `:short_sha` — the abbreviated `HEAD` commit, or `nil` when the `git`
      binary was unavailable / failed.
    * `:dirty?` — whether the working tree had uncommitted changes at build
      time.
  """
  @type git_facts :: %{
          exact_tag: String.t() | nil,
          short_sha: String.t() | nil,
          dirty?: boolean()
        }

  @doc """
  Absolute paths of the git files whose change must re-trigger compilation of
  the version snapshot so an incremental build stays honest (#533 / #542):

    * the current branch's LOOSE ref (`refs/heads/<branch>`) — the file a
      `git pull --ff-only` of an already-checked-out branch rewrites; the
      gap that made the sha go stale on production;
    * `HEAD` — moves on a branch switch or a checkout to a detached HEAD;
    * `packed-refs` — moves when the ref is stored packed.

  Only paths that exist on disk are returned (callers register each as an
  `@external_resource`). `[]` when there is no git at build (a release
  tarball / package) — nothing to watch and nothing to keep fresh.
  """
  @spec resource_paths(String.t()) :: [String.t()]
  def resource_paths(root) do
    if git?(root) do
      ["HEAD", current_ref_name(root), "packed-refs"]
      |> Enum.reject(&is_nil/1)
      |> Enum.map(&git_path(root, &1))
      |> Enum.reject(&is_nil/1)
      |> Enum.uniq()
      |> Enum.filter(&File.exists?/1)
    else
      []
    end
  end

  @doc """
  Build-time snapshot of the git state at `root`, or `nil` when there is no
  `.git` (a release tarball / package). See `t:git_facts/0`.

  A single failed `git` call degrades the affected field to `nil`/`false`,
  never raises — `Grappa.Version.derive/2` folds a sha-less snapshot down to
  the `-dev` suffix rather than crashing the `CTCP VERSION` reply.
  """
  @spec facts(String.t()) :: git_facts() | nil
  def facts(root) do
    if git?(root) do
      %{
        exact_tag: presence(git(root, ["describe", "--tags", "--exact-match"])),
        short_sha: presence(git(root, ["rev-parse", "--short", "HEAD"])),
        dirty?: dirty?(root)
      }
    else
      nil
    end
  end

  # `.git` is a directory in a normal checkout and a FILE in a `git worktree`
  # (it points at the shared gitdir); either is a source build that must keep
  # the #391 suffix. Absent entirely = a release tarball / package.
  defp git?(root), do: File.exists?(Path.join(root, ".git"))

  # The current branch's full ref name (`refs/heads/<branch>`), or `nil` on a
  # detached HEAD — then HEAD itself is the file that moves and is already in
  # the watch set.
  defp current_ref_name(root), do: presence(git(root, ["symbolic-ref", "-q", "HEAD"]))

  # Resolve a git file to an ABSOLUTE path via git itself so worktree /
  # packed / normal layouts all answer correctly. `--git-path` constructs the
  # path without requiring it to exist (callers `File.exists?`-filter); git
  # returns it relative to the process cwd (`root`), so expand against `root`.
  defp git_path(root, name) do
    case git(root, ["rev-parse", "--git-path", name]) do
      nil -> nil
      path -> Path.expand(path, root)
    end
  end

  defp dirty?(root) do
    status = git(root, ["status", "--porcelain"])
    is_binary(status) and status != ""
  end

  defp presence(nil), do: nil
  defp presence(""), do: nil
  defp presence(str) when is_binary(str), do: str

  # Shell out to git, env-stripped. git introspection needs none of grappa's
  # secrets (SECRET_KEY_BASE, CLOAK_KEY, …); a cleared env keeps them out of
  # the subprocess (Credo UnsafeExec) and plain rev-parse/describe/status/
  # symbolic-ref need no HOME. Any failure (non-zero exit, missing binary) →
  # `nil` so the caller degrades gracefully.
  @spec git(String.t(), [String.t()]) :: String.t() | nil
  defp git(root, args) do
    case System.cmd("git", args, cd: root, env: [], stderr_to_stdout: true) do
      {out, 0} -> String.trim(out)
      {_, _} -> nil
    end
  rescue
    _ -> nil
  catch
    _, _ -> nil
  end
end
