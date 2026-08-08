// #775 — the notice that survives the reload that causes it.
//
// The auto-refresh (#674) throws this document away, so the announcement
// cannot be made by the document that decided to refresh: it has to be handed
// across the navigation. The marker is written just before the reload is
// requested and read-and-cleared by the document that boots next.
//
// TWO WAYS TO LIE, hence two guards, and neither predicate covers the other:
//
//   * the reload NEVER LANDS — a blocked navigation, the e2e `__refreshProbe`,
//     an operator who kills the tab. The marker then sits in storage and the
//     next boot of that window, an hour later for reasons of its own, would
//     announce an auto-refresh that never happened. TIME fences this.
//   * the reload LANDS AND CHANGES NOTHING — `performRefresh`'s own header
//     documents the reload that keeps serving the old precached index.html.
//     That one is seconds old and on the same bytes, so time waves it through.
//     The DEPARTING HASH fences it.
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
  requestBundleRefresh,
} from "../lib/bundleRefreshNotice";
import { _setScheduleExpiryForTest } from "../lib/toasts";

const t0 = 1_700_000_000_000;
const SECOND = 1_000;

// Vite asset-hash shapes, so the 7-char label slice is exercised for real.
const OLD_BUNDLE = "Tsa4Tfom";
const NEW_BUNDLE = "CiYQNUz0";

// setupTests.ts installs a fresh localStorage per test but leaves jsdom's
// sessionStorage — where the marker lives — untouched.
beforeEach(() => {
  sessionStorage.clear();
  _setScheduleExpiryForTest(() => {});
  for (const t of bundleRefreshToasts()) dismissBundleRefreshToast(t.id);
});

describe("the cross-reload marker", () => {
  it("lives in sessionStorage — a sibling tab must not announce this window's refresh", () => {
    markBundleRefreshApplied(t0, OLD_BUNDLE, "auto");

    expect(sessionStorage.getItem(BUNDLE_REFRESH_NOTICE_KEY)).toBe(
      JSON.stringify({ at: t0, from: OLD_BUNDLE, origin: "auto" }),
    );
    expect(localStorage.getItem(BUNDLE_REFRESH_NOTICE_KEY)).toBeNull();
  });

  it("announces for the boot that immediately follows, on a different bundle", () => {
    markBundleRefreshApplied(t0, OLD_BUNDLE, "auto");

    expect(consumeBundleRefreshNotice(t0 + 2 * SECOND, NEW_BUNDLE)).toBe("changed");
  });

  // The reload landed on the OLD precached index.html — the three-presses-to-
  // update class `performRefresh` exists to mitigate and explicitly does not
  // guarantee against. Seconds old, so time waves it through; nothing changed,
  // so there is nothing to announce.
  it("SAYS NOTHING when the reload landed back on the same bundle", () => {
    markBundleRefreshApplied(t0, OLD_BUNDLE, "auto");

    expect(consumeBundleRefreshNotice(t0 + 2 * SECOND, OLD_BUNDLE)).toBe("none");
  });

  // Storing the DEPARTING hash rather than the target is what keeps this case:
  // a second deploy landing mid-reload still leaves the bundle we asked to
  // replace, which is the thing being announced.
  it("still announces when a second deploy landed during the reload", () => {
    markBundleRefreshApplied(t0, OLD_BUNDLE, "auto");

    expect(consumeBundleRefreshNotice(t0 + 3 * SECOND, "Xy9zAbC1")).toBe("changed");
  });

  it("is fresh exactly at the window edge", () => {
    markBundleRefreshApplied(t0, OLD_BUNDLE, "auto");

    expect(consumeBundleRefreshNotice(t0 + BUNDLE_REFRESH_NOTICE_WINDOW_MS, NEW_BUNDLE)).toBe(
      "changed",
    );
  });

  it("STRANDS SAFELY: a marker whose reload never landed does not announce later", () => {
    markBundleRefreshApplied(t0, OLD_BUNDLE, "auto");

    expect(consumeBundleRefreshNotice(t0 + BUNDLE_REFRESH_NOTICE_WINDOW_MS + 1, NEW_BUNDLE)).toBe(
      "none",
    );
  });

  it("clears the marker even when it was unusable, so it cannot resurface", () => {
    markBundleRefreshApplied(t0, OLD_BUNDLE, "auto");
    consumeBundleRefreshNotice(t0 + 6 * BUNDLE_REFRESH_NOTICE_WINDOW_MS, NEW_BUNDLE);

    expect(sessionStorage.getItem(BUNDLE_REFRESH_NOTICE_KEY)).toBeNull();
  });

  it("is consumed exactly once — a second boot in the same window stays quiet", () => {
    markBundleRefreshApplied(t0, OLD_BUNDLE, "auto");

    expect(consumeBundleRefreshNotice(t0 + SECOND, NEW_BUNDLE)).toBe("changed");
    expect(consumeBundleRefreshNotice(t0 + 2 * SECOND, NEW_BUNDLE)).toBe("none");
  });

  it("is false with no marker at all — an ordinary boot announces nothing", () => {
    expect(consumeBundleRefreshNotice(t0, NEW_BUNDLE)).toBe("none");
  });

  it("is false on a corrupt marker, and clears it", () => {
    sessionStorage.setItem(BUNDLE_REFRESH_NOTICE_KEY, "just now");

    expect(consumeBundleRefreshNotice(t0, NEW_BUNDLE)).toBe("none");
    expect(sessionStorage.getItem(BUNDLE_REFRESH_NOTICE_KEY)).toBeNull();
  });

  it("is false on a marker missing its fields — an older format must not throw", () => {
    sessionStorage.setItem(BUNDLE_REFRESH_NOTICE_KEY, String(t0));

    expect(consumeBundleRefreshNotice(t0 + SECOND, NEW_BUNDLE)).toBe("none");
  });

  it("is false on a future-dated marker — a backwards clock step must not announce", () => {
    markBundleRefreshApplied(t0 + 10 * SECOND, OLD_BUNDLE, "auto");

    expect(consumeBundleRefreshNotice(t0, NEW_BUNDLE)).toBe("none");
  });

  // An announcement is a claim; an unknown hash on either side is not proof of
  // a change. No honest case is lost — the branch that writes the marker only
  // fires when both hashes are known and differ.
  it("is false when either bundle identity is unknown", () => {
    markBundleRefreshApplied(t0, null, "auto");
    expect(consumeBundleRefreshNotice(t0 + SECOND, NEW_BUNDLE)).toBe("none");

    markBundleRefreshApplied(t0, OLD_BUNDLE, "auto");
    expect(consumeBundleRefreshNotice(t0 + SECOND, null)).toBe("none");
  });
});

describe("formatBundleRefreshToast", () => {
  // Through #292's `versionLabel`: a bundle-only rebuild reuses the semver, so
  // without the hash suffix "Updated to 0.10.0" cannot be told from "nothing
  // happened" — and a trivial rebuild is exactly what most often triggers this.
  it("names the bundle now running, semver plus build", () => {
    expect(formatBundleRefreshToast("0.10.1", NEW_BUNDLE)).toBe("Updated to 0.10.1 (CiYQNUz)");
  });

  it("degrades to the build alone when no version is baked in", () => {
    expect(formatBundleRefreshToast(null, NEW_BUNDLE)).toBe("Updated to CiYQNUz");
  });
});

describe("announceAppliedBundleRefresh", () => {
  it("shows exactly one toast when the refresh landed", () => {
    markBundleRefreshApplied(t0, OLD_BUNDLE, "auto");

    announceAppliedBundleRefresh(t0 + 2 * SECOND, NEW_BUNDLE, "0.10.1");

    expect(bundleRefreshToasts().map((t) => t.text)).toEqual(["Updated to 0.10.1 (CiYQNUz)"]);
  });

  it("shows nothing on an ordinary boot", () => {
    announceAppliedBundleRefresh(t0, NEW_BUNDLE, "0.10.1");

    expect(bundleRefreshToasts()).toEqual([]);
  });

  it("shows nothing for a stranded marker", () => {
    markBundleRefreshApplied(t0, OLD_BUNDLE, "auto");

    announceAppliedBundleRefresh(t0 + BUNDLE_REFRESH_NOTICE_WINDOW_MS + 1, NEW_BUNDLE, "0.10.1");

    expect(bundleRefreshToasts()).toEqual([]);
  });

  // #1063 narrowed this claim to the AUTO origin, which is what it always
  // meant: a reload nobody asked for that moved nothing is a non-event. The
  // same reload asked for by a HUMAN is the case below, and it does speak.
  it("shows nothing when an auto reload changed nothing", () => {
    markBundleRefreshApplied(t0, OLD_BUNDLE, "auto");

    announceAppliedBundleRefresh(t0 + 2 * SECOND, OLD_BUNDLE, "0.10.1");

    expect(bundleRefreshToasts()).toEqual([]);
  });

  it("auto-dismisses — nothing is left for the operator to close", () => {
    const scheduled: Array<() => void> = [];
    _setScheduleExpiryForTest((fn) => {
      scheduled.push(fn);
    });
    markBundleRefreshApplied(t0, OLD_BUNDLE, "auto");

    announceAppliedBundleRefresh(t0 + SECOND, NEW_BUNDLE, "0.10.1");
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
    notice.markBundleRefreshApplied(t0, OLD_BUNDLE, "auto");
    notice.announceAppliedBundleRefresh(t0 + SECOND, NEW_BUNDLE, "0.10.1");

    expect(nw.presenceToasts()).toHaveLength(1);
    expect(notice.bundleRefreshToasts()).toHaveLength(1);

    auth.setToken("tokB");

    await vi.waitFor(() => {
      expect(nw.presenceToasts()).toEqual([]);
    });
    expect(notice.bundleRefreshToasts()).toHaveLength(1);
  });
});

// #1063 — the half #775 did not have: an answer when the refresh a HUMAN asked
// for lands on the same bundle.
//
// D5 is why this is not cosmetic. `performRefresh` bounds every step, and when
// a ceiling fires the cache purge is SKIPPED — the reload happens and the old
// precached `index.html` is served again. The operator sees the page blink and
// come back identical, with the same banner on it. Today that is
// indistinguishable from "I did not press hard enough", so they press again.
describe("#1063 — a refresh the operator asked for", () => {
  it("says what it is still running when the reload moved nothing", () => {
    markBundleRefreshApplied(t0, OLD_BUNDLE, "user");

    announceAppliedBundleRefresh(t0 + 2 * SECOND, OLD_BUNDLE, "0.10.1");

    expect(bundleRefreshToasts().map((t) => t.text)).toEqual(["Still on 0.10.1 (Tsa4Tfo)"]);
  });

  // The #775 BEHAVIOUR CHANGE, asserted rather than left to the diff: pressing
  // Refresh used to be silent on success too. It now toasts, and that is the
  // ruling — after you press a button, silence is the surprise.
  it("announces the new bundle on a successful manual refresh", () => {
    markBundleRefreshApplied(t0, OLD_BUNDLE, "user");

    announceAppliedBundleRefresh(t0 + 2 * SECOND, NEW_BUNDLE, "0.10.1");

    expect(bundleRefreshToasts().map((t) => t.text)).toEqual(["Updated to 0.10.1 (CiYQNUz)"]);
  });

  it("still respects the time fence — a marker too old claims nothing", () => {
    markBundleRefreshApplied(t0, OLD_BUNDLE, "user");

    announceAppliedBundleRefresh(t0 + BUNDLE_REFRESH_NOTICE_WINDOW_MS + 1, OLD_BUNDLE, "0.10.1");

    expect(bundleRefreshToasts()).toEqual([]);
  });

  // An unknown hash on either side is not evidence the bundle stayed the same
  // any more than it is evidence it changed. Silence, like every other guard
  // in this module.
  it("claims nothing when a hash is unknown", () => {
    markBundleRefreshApplied(t0, null, "user");
    expect(consumeBundleRefreshNotice(t0 + SECOND, OLD_BUNDLE)).toBe("none");

    markBundleRefreshApplied(t0, OLD_BUNDLE, "user");
    expect(consumeBundleRefreshNotice(t0 + SECOND, null)).toBe("none");
  });
});

// The marker crosses a DEPLOY, not just a reload: the document that writes it
// is running the OLD bundle and the document that reads it is running the new
// one. On the deploy that ships #1063 the writer therefore has no `origin`
// field at all, and reading that as anything but "auto" would drop #775's
// toast on the very deploy that introduces the feature.
describe("#1063 — a marker written by the previous bundle", () => {
  it("is read as the auto deploy branch, the only writer that existed", () => {
    sessionStorage.setItem(BUNDLE_REFRESH_NOTICE_KEY, JSON.stringify({ at: t0, from: OLD_BUNDLE }));

    expect(consumeBundleRefreshNotice(t0 + SECOND, NEW_BUNDLE)).toBe("changed");
  });

  it("and therefore stays silent when it moved nothing", () => {
    sessionStorage.setItem(BUNDLE_REFRESH_NOTICE_KEY, JSON.stringify({ at: t0, from: OLD_BUNDLE }));

    expect(consumeBundleRefreshNotice(t0 + SECOND, OLD_BUNDLE)).toBe("none");
  });

  it("rejects an origin outside the closed set rather than guessing", () => {
    sessionStorage.setItem(
      BUNDLE_REFRESH_NOTICE_KEY,
      JSON.stringify({ at: t0, from: OLD_BUNDLE, origin: "banana" }),
    );

    expect(consumeBundleRefreshNotice(t0 + SECOND, NEW_BUNDLE)).toBe("none");
  });
});

// One writer of the marker. Before #1063 the composition root wrote it and the
// two Refresh buttons did not, so the manual press was silent by omission.
describe("#1063 — requestBundleRefresh is the single writer", () => {
  const withProbe = async (origin: "user" | "auto" | "silent"): Promise<boolean> => {
    let reloaded = false;
    const hook = window.__cic_bundleHash;
    if (hook) {
      hook.__refreshProbe = () => {
        reloaded = true;
      };
    }
    await requestBundleRefresh(t0, OLD_BUNDLE, origin);
    if (hook) hook.__refreshProbe = undefined;
    return reloaded;
  };

  it("marks with the origin it was given, and reloads", async () => {
    expect(await withProbe("user")).toBe(true);

    expect(JSON.parse(sessionStorage.getItem(BUNDLE_REFRESH_NOTICE_KEY) ?? "null")).toEqual({
      at: t0,
      from: OLD_BUNDLE,
      origin: "user",
    });
  });

  // #695 throws a document away for AGE. It reloads like the others and has
  // nothing whatsoever to tell anyone — not even "still on X", because nobody
  // asked it anything.
  it("writes no marker at all when silent, and still reloads", async () => {
    expect(await withProbe("silent")).toBe(true);

    expect(sessionStorage.getItem(BUNDLE_REFRESH_NOTICE_KEY)).toBeNull();
  });
});
