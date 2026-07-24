defmodule Grappa.VersionTest do
  @moduledoc """
  #391 — git tag ≡ CTCP VERSION. A released build (HEAD on a clean tag
  matching the mix version) reports the bare version; any other build
  reports a `-<shortsha>` (or `-dev` when git is unavailable) suffix so
  an operator reading CTCP VERSION tells released-vs-unreleased at a
  glance.

  `derive/2` is the pure kernel: it takes the base version + a snapshot
  of the build's git state and returns the honest version string. It is
  tested here with synthetic git facts because the compile-time git
  state of the test build itself is unstable (untagged worktree, maybe
  dirty) and can't be asserted against a fixed literal.
  """
  use ExUnit.Case, async: true

  alias Grappa.Version

  describe "derive/2 — git-tag-honest version" do
    test "clean release tag matching the mix version → bare version" do
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

    test "tag present but mismatched with the mix version → -<shortsha> suffix" do
      facts = %{exact_tag: "v1.2.2", short_sha: "abc1234", dirty?: false}

      assert Version.derive("1.2.3", facts) == "1.2.3-abc1234"
    end

    test "git unavailable (no tag, no sha) → -dev suffix" do
      facts = %{exact_tag: nil, short_sha: nil, dirty?: false}

      assert Version.derive("1.2.3", facts) == "1.2.3-dev"
    end
  end

  describe "base/0 + current/0 — live mix.exs read wired through derive/2" do
    test "base/0 reads the canonical @version from mix.exs" do
      assert Version.base() =~ ~r/^\d+\.\d+\.\d+/
    end

    test "current/0 returns a non-empty string starting with the base version" do
      current = Version.current()

      assert is_binary(current) and current != ""
      assert String.starts_with?(current, Version.base())
    end
  end
end
