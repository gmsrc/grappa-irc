defmodule Grappa.PresenceFilterTest do
  use ExUnit.Case, async: true

  alias Grappa.PresenceFilter

  # #458 — the server-side twin of cic's `resolvePresenceVisible`
  # (`cicchetto/src/lib/presenceFilter.ts`), INVERTED: cic asks "is presence
  # VISIBLE?", the server asks "should the fetch HIDE presence?". An explicit
  # per-channel pref wins; unset follows the live member-count size default
  # against the shared `LARGE_CHANNEL_THRESHOLD`.
  describe "hidden?/2 — presence-hide decision (mirror of resolvePresenceVisible, inverted)" do
    test "explicit \"hide\" hides regardless of member count" do
      assert PresenceFilter.hidden?("hide", 0)
      assert PresenceFilter.hidden?("hide", 10_000)
      assert PresenceFilter.hidden?("hide", nil)
    end

    test "explicit \"show\" shows regardless of member count" do
      refute PresenceFilter.hidden?("show", 0)
      refute PresenceFilter.hidden?("show", 10_000)
      refute PresenceFilter.hidden?("show", nil)
    end

    test "unset follows the size default: hides at or above the threshold" do
      threshold = PresenceFilter.large_channel_threshold()
      assert PresenceFilter.hidden?(nil, threshold)
      assert PresenceFilter.hidden?(nil, threshold + 1)
    end

    test "unset follows the size default: shows below the threshold" do
      threshold = PresenceFilter.large_channel_threshold()
      refute PresenceFilter.hidden?(nil, threshold - 1)
      refute PresenceFilter.hidden?(nil, 0)
    end

    test "unset with an unavailable member count defaults to show (decision D — never hide on a guess)" do
      refute PresenceFilter.hidden?(nil, nil)
    end
  end
end
