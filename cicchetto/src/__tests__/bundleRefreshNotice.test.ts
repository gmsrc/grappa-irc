// #775 — the notice that survives the reload that causes it.
//
// The auto-refresh (#674) throws this document away, so the announcement
// cannot be made by the document that decided to refresh: it has to be handed
// across the navigation. The marker is written just before the reload is
// requested and read-and-cleared by the document that boots next.
//
// THE STRAND MODE this suite exists for: the reload may never land (a blocked
// navigation, the e2e `__refreshProbe`, an operator who kills the tab). The
// marker then sits in storage, and the next boot of that window — an hour
// later, for reasons of its own — would announce an auto-refresh that never
// happened. A reload lands in seconds or not at all, so the marker is only
// honest for the boot that immediately follows it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  announceAppliedBundleRefresh,
  BUNDLE_REFRESH_NOTICE_KEY,
  BUNDLE_REFRESH_NOTICE_WINDOW_MS,
  bundleRefreshToasts,
  consumeBundleRefreshNotice,
  dismissBundleRefreshToast,
  formatBundleRefreshToast,
  markBundleRefreshApplied,
} from "../lib/bundleRefreshNotice";
import { _setScheduleExpiryForTest } from "../lib/toasts";

const t0 = 1_700_000_000_000;
const SECOND = 1_000;

// setupTests.ts installs a fresh localStorage per test but leaves jsdom's
// sessionStorage — where the marker lives — untouched.
beforeEach(() => {
  sessionStorage.clear();
  _setScheduleExpiryForTest(() => {});
  for (const t of bundleRefreshToasts()) dismissBundleRefreshToast(t.id);
});

describe("the cross-reload marker", () => {
  it("lives in sessionStorage — a sibling tab must not announce this window's refresh", () => {
    markBundleRefreshApplied(t0);

    expect(sessionStorage.getItem(BUNDLE_REFRESH_NOTICE_KEY)).toBe(String(t0));
    expect(localStorage.getItem(BUNDLE_REFRESH_NOTICE_KEY)).toBeNull();
  });

  it("is fresh for the boot that immediately follows the reload", () => {
    markBundleRefreshApplied(t0);

    expect(consumeBundleRefreshNotice(t0 + 2 * SECOND)).toBe(true);
  });

  it("is fresh exactly at the window edge", () => {
    markBundleRefreshApplied(t0);

    expect(consumeBundleRefreshNotice(t0 + BUNDLE_REFRESH_NOTICE_WINDOW_MS)).toBe(true);
  });

  it("STRANDS SAFELY: a marker whose reload never landed does not announce later", () => {
    markBundleRefreshApplied(t0);

    expect(consumeBundleRefreshNotice(t0 + BUNDLE_REFRESH_NOTICE_WINDOW_MS + 1)).toBe(false);
  });

  it("clears the marker even when it was too old to use, so it cannot resurface", () => {
    markBundleRefreshApplied(t0);
    consumeBundleRefreshNotice(t0 + 6 * BUNDLE_REFRESH_NOTICE_WINDOW_MS);

    expect(sessionStorage.getItem(BUNDLE_REFRESH_NOTICE_KEY)).toBeNull();
  });

  it("is consumed exactly once — a second boot in the same window stays quiet", () => {
    markBundleRefreshApplied(t0);

    expect(consumeBundleRefreshNotice(t0 + SECOND)).toBe(true);
    expect(consumeBundleRefreshNotice(t0 + 2 * SECOND)).toBe(false);
  });

  it("is false with no marker at all — an ordinary boot announces nothing", () => {
    expect(consumeBundleRefreshNotice(t0)).toBe(false);
  });

  it("is false on a corrupt marker, and clears it", () => {
    sessionStorage.setItem(BUNDLE_REFRESH_NOTICE_KEY, "just now");

    expect(consumeBundleRefreshNotice(t0)).toBe(false);
    expect(sessionStorage.getItem(BUNDLE_REFRESH_NOTICE_KEY)).toBeNull();
  });

  it("is false on a future-dated marker — a backwards clock step must not announce", () => {
    markBundleRefreshApplied(t0 + 10 * SECOND);

    expect(consumeBundleRefreshNotice(t0)).toBe(false);
  });
});

describe("formatBundleRefreshToast", () => {
  it("names the version now running", () => {
    expect(formatBundleRefreshToast("0.10.1")).toBe("Updated to 0.10.1");
  });

  it("degrades without a version rather than printing a hole", () => {
    expect(formatBundleRefreshToast(null)).toBe("Updated to the latest version");
  });
});

describe("announceAppliedBundleRefresh", () => {
  it("shows exactly one toast when the refresh landed", () => {
    markBundleRefreshApplied(t0);

    announceAppliedBundleRefresh(t0 + 2 * SECOND, "0.10.1");

    expect(bundleRefreshToasts().map((t) => t.text)).toEqual(["Updated to 0.10.1"]);
  });

  it("shows nothing on an ordinary boot", () => {
    announceAppliedBundleRefresh(t0, "0.10.1");

    expect(bundleRefreshToasts()).toEqual([]);
  });

  it("shows nothing for a stranded marker", () => {
    markBundleRefreshApplied(t0);

    announceAppliedBundleRefresh(t0 + BUNDLE_REFRESH_NOTICE_WINDOW_MS + 1, "0.10.1");

    expect(bundleRefreshToasts()).toEqual([]);
  });

  it("auto-dismisses — nothing is left for the operator to close", () => {
    const scheduled: Array<() => void> = [];
    _setScheduleExpiryForTest((fn) => {
      scheduled.push(fn);
    });
    markBundleRefreshApplied(t0);

    announceAppliedBundleRefresh(t0 + SECOND, "0.10.1");
    expect(bundleRefreshToasts()).toHaveLength(1);

    scheduled[0]!();
    expect(bundleRefreshToasts()).toEqual([]);
  });
});

// The reason this notice got its own queue instead of a `bundle` variant of
// #247's `PresenceToast`: that union is cleared alongside the watch list on an
// identity switch, which would make the update notice vanish for a reason that
// has nothing to do with bundles.
describe("the update notice is not identity-scoped", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("survives an account switch that clears the presence toasts", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const toasts = await import("../lib/toasts");
    const nw = await import("../lib/notifyWatch");
    const notice = await import("../lib/bundleRefreshNotice");
    toasts._setScheduleExpiryForTest(() => {});

    nw.applyPresenceError({ network_id: 42, detail: "Monitor list is full" });
    notice.markBundleRefreshApplied(t0);
    notice.announceAppliedBundleRefresh(t0 + SECOND, "0.10.1");

    expect(nw.presenceToasts()).toHaveLength(1);
    expect(notice.bundleRefreshToasts()).toHaveLength(1);

    auth.setToken("tokB");

    await vi.waitFor(() => {
      expect(nw.presenceToasts()).toEqual([]);
    });
    expect(notice.bundleRefreshToasts()).toHaveLength(1);
  });
});
