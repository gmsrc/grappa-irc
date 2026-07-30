defmodule Grappa.VersionTest do
  @moduledoc """
  #391 — git tag ≡ CTCP VERSION. A source build that is HEAD on a clean tag
  matching the base version reports the bare version; a source build with
  git history that is untagged / dirty reports a `-<shortsha>` (or `-dev`)
  suffix so an operator reading CTCP VERSION tells released-vs-unreleased at
  a glance.

  #419 R3 — the base version comes from the release `.app` metadata
  (`Application.spec(:grappa, :vsn)`), NOT a runtime `mix.exs` read (a
  package ships no mix.exs — the source never enters the CI-built artifact —
  and the old `File.read!/1` raised there). A packaged build has no `.git`
  at build, so its git snapshot is `nil` and it reports the bare package
  version.

  `derive/2` is the pure kernel: base version + a git snapshot (or `nil`) →
  the honest version string. It is tested here with explicit inputs — the
  compile-time git state of the test build itself is unstable (untagged
  worktree, maybe dirty) and can't be asserted against a fixed literal.

  These are PURE-KERNEL contract tests. The authoritative end-to-end proof
  that a package built in CI reports the bare `X.Y.Z` lives in the release
  workflow (`.github/workflows/release.yml`), which builds the real artifact
  and queries its reported version — not a filesystem fake that would only
  prove a mock works.
  """
  use ExUnit.Case, async: true

  alias Grappa.Version

  describe "derive/2 — source build (git history present): #391 git-tag suffix" do
    test "clean release tag matching the base version → bare version" do
      facts = %{exact_tag: "v1.2.3", short_sha: "abc1234", dirty?: false}

      assert Version.derive("1.2.3", facts) == "1.2.3"

      # The CTCP VERSION wire string an operator sees for a released build.
      assert "VERSION grappa #{Version.derive("1.2.3", facts)}" ==
               "VERSION grappa 1.2.3"
    end

    test "untagged build → -<shortsha> suffix" do
      facts = %{exact_tag: nil, short_sha: "abc1234", dirty?: false}

      assert Version.derive("1.2.3", facts) == "1.2.3-abc1234"

      # The CTCP VERSION wire string an operator sees for an unreleased build.
      assert "VERSION grappa #{Version.derive("1.2.3", facts)}" ==
               "VERSION grappa 1.2.3-abc1234"
    end

    test "dirty working tree on a matching tag → -<shortsha> suffix (uncommitted ≠ released)" do
      facts = %{exact_tag: "v1.2.3", short_sha: "abc1234", dirty?: true}

      assert Version.derive("1.2.3", facts) == "1.2.3-abc1234"
    end

    test "tag present but mismatched with the base version → -<shortsha> suffix" do
      facts = %{exact_tag: "v1.2.2", short_sha: "abc1234", dirty?: false}

      assert Version.derive("1.2.3", facts) == "1.2.3-abc1234"
    end

    test "git present but describe/rev-parse failed (no tag, no sha) → -dev suffix" do
      facts = %{exact_tag: nil, short_sha: nil, dirty?: false}

      assert Version.derive("1.2.3", facts) == "1.2.3-dev"
    end
  end

  describe "derive/2 — packaged build (no .git at build → nil facts): bare base (#419 R3)" do
    test "nil git facts → bare base, no suffix (canonical package version)" do
      # A package built in CI has no `.git` in the source it compiles (the
      # source tarball carries none), so the build-time snapshot is nil. The
      # reported version is the bare `base` (the `.app` vsn = the cut tag
      # `vX.Y.Z`) — never `-dev`, and the git-suffix path is never entered.
      # (End-to-end proof on the real artifact: release.yml.)
      assert Version.derive("1.2.3", nil) == "1.2.3"
      refute String.contains?(Version.derive("1.2.3", nil), "-")
    end
  end

  describe "base/0 + current/0 — version from the .app metadata (#419 R3)" do
    test "base/0 returns the .app vsn, which tracks the canonical @version in mix.exs" do
      # base/0 returns the vsn OTP compiled into the .app from mix.exs
      # @version at build — no runtime mix.exs read (that raised in a package).
      # Cross-check the built metadata against the source declaration: reading
      # mix.exs HERE is a build↔source verification in the test, not the
      # runtime read the seam removed. Proves the .app vsn IS the declared
      # @version (and that Application.spec/2 is populated for a started app).
      source_version =
        "mix.exs"
        |> File.read!()
        |> then(&Regex.run(~r/@version\s+"([^"]+)"/, &1))
        |> List.last()

      assert Version.base() == source_version
      assert Version.base() =~ ~r/^\d+\.\d+\.\d+/
    end

    test "current/0 returns a non-empty string starting with the base version" do
      current = Version.current()

      assert is_binary(current) and current != ""
      assert String.starts_with?(current, Version.base())
    end
  end

  describe "verify_build_sha/2 — deploy-time drift guard (#542): compiled sha ≡ HEAD or the build fails" do
    # The runtime CTCP-VERSION path (derive/2) degrades a broken snapshot to
    # `-dev` so a RUNNING node never crashes its VERSION reply. The DEPLOY guard
    # is the opposite posture: at `mix release` assembly it REFUSES to ship a
    # version it cannot prove, because "a version string that can be stale is
    # worse than no version string, because it is trusted" (#542). Same facts,
    # stricter verdict — build-time, not runtime.

    test "compiled sha equals HEAD → :ok (the honest source build)" do
      facts = %{exact_tag: nil, short_sha: "a40ad10", dirty?: false}

      assert Version.verify_build_sha(facts, "a40ad10") == :ok
    end

    test "compiled sha differs from HEAD → {:error, {:stale, compiled, head}} (the #542 drift)" do
      # The exact production reproduction: the node reported 0.6.0-6ba1235a
      # while running a40ad10e — Version.beam kept the previous build's sha
      # because the @external_resource watch set missed the loose branch ref.
      facts = %{exact_tag: nil, short_sha: "6ba1235a", dirty?: false}

      assert Version.verify_build_sha(facts, "a40ad10e") ==
               {:error, {:stale, "6ba1235a", "a40ad10e"}}
    end

    test "git present at build but snapshot degraded (short_sha nil) → {:error, :sha_snapshot_degraded}" do
      # This is the case that must NOT collapse into a silent skip: a source
      # build (git WAS present, @git_facts is a map) whose sha snapshot failed
      # reports `-dev` — a trusted-but-unverifiable version. That IS the #542
      # failure the issue names, so the deploy must FAIL, not skip.
      facts = %{exact_tag: nil, short_sha: nil, dirty?: false}

      assert Version.verify_build_sha(facts, "a40ad10") == {:error, :sha_snapshot_degraded}
    end

    test "snapshot degraded AND HEAD unresolvable → :sha_snapshot_degraded (clause 2 beats clause 3)" do
      # Pins the clause ordering the design hinges on: a git build with no
      # snapshotted sha must report the degraded-snapshot drift even when HEAD is
      # ALSO unresolvable — it must never fall through to :head_unresolved.
      facts = %{exact_tag: nil, short_sha: nil, dirty?: false}

      assert Version.verify_build_sha(facts, nil) == {:error, :sha_snapshot_degraded}
    end

    test "compiled sha present but HEAD unresolvable now → {:error, :head_unresolved}" do
      # git was present at build (we hold a compiled sha) but the deploy cannot
      # resolve HEAD to compare against — don't ship a version we can't verify.
      facts = %{exact_tag: nil, short_sha: "a40ad10", dirty?: false}

      assert Version.verify_build_sha(facts, nil) == {:error, :head_unresolved}
    end

    test "a dirty tree does not change the guard — the committed sha still governs" do
      facts = %{exact_tag: "v1.2.3", short_sha: "a40ad10", dirty?: true}

      assert Version.verify_build_sha(facts, "a40ad10") == :ok

      assert Version.verify_build_sha(facts, "beefca7") ==
               {:error, {:stale, "a40ad10", "beefca7"}}
    end
  end

  describe "verify_build_sha/2 — no git at build (package/tarball): skip, but the caller logs the observation" do
    test "nil git facts → {:skip, :no_git} (nothing to verify; release.yml's tag-proof covers packages)" do
      # A package built from the source tarball has no `.git` → @git_facts is
      # nil → the artifact honestly reports the bare base. There is genuinely no
      # HEAD to compare, so the guard skips — but the release step LOGS what it
      # observed (log-honesty: a fast path states what it saw, never a silent
      # no-op). This is the ONLY non-error outcome without a sha comparison, and
      # it is a positively-identified package, not an anomalous fall-through.
      assert Version.verify_build_sha(nil, nil) == {:skip, :no_git}
    end

    test "nil git facts skips regardless of a HEAD that happens to resolve" do
      # The beam's own claim (built without git → bare version) is
      # authoritative; a HEAD appearing at deploy time does not retro-make a
      # tarball build into a source build.
      assert Version.verify_build_sha(nil, "a40ad10") == {:skip, :no_git}
    end
  end

  describe "verify_build_sha/1 — reads the compiled @git_facts snapshot, delegates to /2" do
    test "returns a valid tagged verdict for the build's own snapshot" do
      # Like current/0, the compile-time git state of the test build is unstable
      # (untagged worktree, possibly dirty), so we assert the CONTRACT SHAPE, not
      # a fixed literal. A head that cannot equal any real short sha exercises
      # the delegation without coupling the test to the build's actual sha.
      result = Version.verify_build_sha("0000000")

      # `:ok` is impossible — the build's real short-sha can't be "0000000" — so a
      # git build (every real env) yields `{:error, {:stale, <real>, "0000000"}}`;
      # the "0000000" we passed appearing in the verdict proves `/1` threads its
      # argument into `/2` rather than ignoring it. A git-less build env degrades
      # to `{:skip, :no_git}` / `:sha_snapshot_degraded`.
      assert match?({:error, {:stale, _, "0000000"}}, result) or
               match?({:skip, :no_git}, result) or
               match?({:error, :sha_snapshot_degraded}, result)
    end
  end
end
