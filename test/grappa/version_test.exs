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
    test "base/0 returns the canonical vsn from the release .app resource (not a mix.exs read)" do
      # The old design read @version from mix.exs at runtime via File.read!,
      # which raises in a package (no mix.exs beside the BEAM). base/0 now
      # returns the vsn OTP compiled into the .app from @version — the same
      # canonical source, with no runtime filesystem access. Also confirms
      # Application.spec(:grappa, :vsn) is populated for a started app.
      assert Version.base() == to_string(Application.spec(:grappa, :vsn))
      assert Version.base() =~ ~r/^\d+\.\d+\.\d+/
    end

    test "current/0 returns a non-empty string starting with the base version" do
      current = Version.current()

      assert is_binary(current) and current != ""
      assert String.starts_with?(current, Version.base())
    end
  end
end
