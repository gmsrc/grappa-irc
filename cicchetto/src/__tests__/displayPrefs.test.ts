import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setToken } from "../lib/auth";
import { channelKey } from "../lib/channelKey";
import { getColoredNicklist, setColoredNicklist } from "../lib/colorNicklist";
import {
  applyServerPrefs,
  buildWireMap,
  mountDisplayPrefsSync,
  syncedSetChannelPresencePref,
  syncedSetColoredNicklist,
  syncedSetTimeFormat,
} from "../lib/displayPrefs";
import {
  getAllPresencePrefs,
  getChannelPresencePref,
  replacePresencePrefs,
} from "../lib/presenceFilter";
import { getTimeFormat, setTimeFormat } from "../lib/timeFormat";
import type { DisplayPrefs } from "../lib/userSettings";

// #449 — server-backed display prefs coordinator. The three localStorage-only
// prefs (presence filter #222, time format #217, colored nicklist #443) never
// converged across one account's devices; this coordinator mirrors the theme
// sync (boot-cached apply + login reconcile) so they do. Seed-up-once (Fork B):
// a server that never persisted gets the local values PUSHED up (never wiped);
// otherwise the server wins. `persisted` is the discriminator.

const TOKEN = "test-bearer";
const KEY_A = channelKey("n", "#a");
const KEY_B = channelKey("n", "#b");

// Reset the three module singletons to defaults + drop the token so every test
// starts from a known local baseline (the signals persist across the suite).
function resetLocal(): void {
  localStorage.clear();
  setTimeFormat("hms");
  setColoredNicklist(false);
  replacePresencePrefs({});
  setToken(null);
}

// Flush Solid's effect queue + any chained microtasks (GET → then → PUT).
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// A fetch stub that answers GET vs PUT distinctly and mints a FRESH Response
// per call (a Response body can only be read once — a shared instance would
// throw "body already read" on the second call).
function stubFetch(getBody: unknown, putBody: unknown): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((_url, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = method === "GET" ? getBody : putBody;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
}

beforeEach(() => {
  resetLocal();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetLocal();
});

describe("buildWireMap", () => {
  it("reads the three module getters into the wire shape", () => {
    setTimeFormat("hm");
    setColoredNicklist(true);
    replacePresencePrefs({ [KEY_A]: "hide" });

    expect(buildWireMap()).toEqual({
      time_format: "hm",
      colored_nicklist: true,
      presence_filter: { [KEY_A]: "hide" },
    });
  });

  it("emits an empty presence_filter when no channel is pinned", () => {
    expect(buildWireMap().presence_filter).toEqual({});
  });
});

describe("applyServerPrefs", () => {
  it("distributes server prefs into the three local setters", () => {
    applyServerPrefs({
      time_format: "hm",
      colored_nicklist: true,
      presence_filter: { [KEY_A]: "hide" },
    });

    expect(getTimeFormat()).toBe("hm");
    expect(getColoredNicklist()).toBe(true);
    expect(getChannelPresencePref(KEY_A)).toBe("hide");
  });

  it("tri-state: an unset channel stays ABSENT after apply (never coerced)", () => {
    // Server carries only #a. #b must not appear in the local map.
    applyServerPrefs({
      time_format: "hms",
      colored_nicklist: false,
      presence_filter: { [KEY_A]: "hide" },
    });

    const map = getAllPresencePrefs();
    expect(map[KEY_A]).toBe("hide");
    expect(KEY_B in map).toBe(false);
  });

  it("replaces the whole presence map (a full-map apply clears stale pins)", () => {
    replacePresencePrefs({ [KEY_A]: "hide", [KEY_B]: "show" });
    applyServerPrefs({
      time_format: "hms",
      colored_nicklist: false,
      presence_filter: { [KEY_A]: "show" },
    });

    expect(getAllPresencePrefs()).toEqual({ [KEY_A]: "show" });
  });
});

describe("mountDisplayPrefsSync — login reconcile", () => {
  it("server wins when the server has persisted prefs", async () => {
    const server: DisplayPrefs = {
      time_format: "hm",
      colored_nicklist: true,
      presence_filter: { [KEY_A]: "hide" },
    };
    stubFetch(
      { display_prefs: server, persisted: true },
      { display_prefs: server, persisted: true },
    );

    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      mountDisplayPrefsSync();
    });
    setToken(TOKEN);
    await flush();

    expect(getTimeFormat()).toBe("hm");
    expect(getColoredNicklist()).toBe(true);
    expect(getChannelPresencePref(KEY_A)).toBe("hide");
    dispose();
  });

  it("seeds up the local values when the server has NEVER persisted", async () => {
    // Local state the operator built on this device — must survive + push up.
    setTimeFormat("hm");
    setColoredNicklist(true);
    replacePresencePrefs({ [KEY_A]: "hide" });

    const serverDefaults: DisplayPrefs = {
      time_format: "hms",
      colored_nicklist: false,
      presence_filter: {},
    };
    stubFetch(
      { display_prefs: serverDefaults, persisted: false },
      { display_prefs: serverDefaults, persisted: true },
    );

    // Real logged-in-boot order: the auth signal already holds the token before
    // the effect first runs, so the logout-clear branch never fires and the
    // boot-seeded local values are what seed up.
    setToken(TOKEN);
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      mountDisplayPrefsSync();
    });
    await flush();

    // A seed-up PUT fired carrying the LOCAL values (never the server default).
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const putCall = fetchMock.mock.calls.find(
      (c) => ((c[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "PUT",
    );
    expect(putCall).toBeDefined();
    const putInit = putCall?.[1] as RequestInit;
    expect(JSON.parse(putInit.body as string)).toEqual({
      display_prefs: {
        time_format: "hm",
        colored_nicklist: true,
        presence_filter: { [KEY_A]: "hide" },
      },
    });

    // Local values are untouched by the seed-up (no clobber to server default).
    expect(getTimeFormat()).toBe("hm");
    expect(getColoredNicklist()).toBe(true);
    dispose();
  });

  it("keeps the boot cache on an offline GET failure (never throws)", async () => {
    setTimeFormat("hm");
    replacePresencePrefs({ [KEY_A]: "hide" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    // Real logged-in-boot order: token present before the effect first runs, so
    // the failed GET falls through to the keep-boot-cache catch (not the clear).
    setToken(TOKEN);
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      mountDisplayPrefsSync();
    });
    await flush();

    // Boot-cached local values survive the failed refresh.
    expect(getTimeFormat()).toBe("hm");
    expect(getChannelPresencePref(KEY_A)).toBe("hide");
    dispose();
  });

  it("mounted logged-out: no fetch, and the cache is cleared to defaults", async () => {
    setTimeFormat("hm");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      mountDisplayPrefsSync();
    });
    // token is already null (resetLocal) — the logged-out branch: no server
    // round-trip, and the cache resets to defaults (no residual to seed up).
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getTimeFormat()).toBe("hms");
    dispose();
  });
});

describe("syncedSet* — optimistic local + full-map PUT", () => {
  it("syncedSetTimeFormat sets local and PUTs the full wire map when logged in", async () => {
    setColoredNicklist(true);
    replacePresencePrefs({ [KEY_A]: "hide" });
    setToken(TOKEN);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ display_prefs: buildWireMap(), persisted: true }), {
        status: 200,
      }),
    );

    syncedSetTimeFormat("hm");
    await flush();

    expect(getTimeFormat()).toBe("hm"); // optimistic local applied
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/me/settings/display-prefs");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      display_prefs: {
        time_format: "hm",
        colored_nicklist: true,
        presence_filter: { [KEY_A]: "hide" },
      },
    });
  });

  it("syncedSetColoredNicklist + syncedSetChannelPresencePref set local without a PUT when logged out", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    syncedSetColoredNicklist(true);
    syncedSetChannelPresencePref(KEY_A, "hide");
    await flush();

    expect(getColoredNicklist()).toBe(true);
    expect(getChannelPresencePref(KEY_A)).toBe("hide");
    expect(fetchMock).not.toHaveBeenCalled(); // no token → local-only
  });
});

// S1 (review) — clear-on-logout so a shared browser / visitor→user upgrade can
// NOT bleed subject A's residual local prefs into subject B's server account.
// Keep-cache-on-logout was safe while the cache was read-only display state; the
// seed-up made it a WRITE source, so a never-persisted next login would PUT the
// prior subject's residual values. Parity with mountCustomThemeSync's clear.
describe("mountDisplayPrefsSync — clear-on-logout (no cross-account bleed)", () => {
  const DEFAULTS = { time_format: "hms", colored_nicklist: false, presence_filter: {} };

  // Phase-mutable fetch stub: the GET body changes across A-login / B-login.
  let getBody: unknown;
  function installPhaseFetch(): ReturnType<typeof vi.fn> {
    return vi.spyOn(globalThis, "fetch").mockImplementation((_url, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      // The PUT body is echoed back persisted:true; the coordinator ignores it.
      const body = method === "GET" ? getBody : { display_prefs: DEFAULTS, persisted: true };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as unknown as ReturnType<typeof vi.fn>;
  }

  it("resets local prefs to defaults on logout", async () => {
    const aPrefs = {
      time_format: "hm",
      colored_nicklist: true,
      presence_filter: { [KEY_A]: "hide" },
    };
    getBody = { display_prefs: aPrefs, persisted: true };
    installPhaseFetch();

    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      mountDisplayPrefsSync();
    });

    setToken(TOKEN); // A logs in — server wins, A's prefs applied locally
    await flush();
    expect(getTimeFormat()).toBe("hm");

    setToken(null); // A logs out
    await flush();

    expect(getTimeFormat()).toBe("hms");
    expect(getColoredNicklist()).toBe(false);
    expect(getAllPresencePrefs()).toEqual({});
    dispose();
  });

  it("does NOT seed a prior subject's prefs into a never-persisted next login", async () => {
    const aPrefs = {
      time_format: "hm",
      colored_nicklist: true,
      presence_filter: { [KEY_A]: "hide" },
    };
    getBody = { display_prefs: aPrefs, persisted: true };
    const fetchMock = installPhaseFetch();

    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      mountDisplayPrefsSync();
    });

    setToken(TOKEN); // A logs in
    await flush();
    setToken(null); // A logs out — cache MUST clear
    await flush();

    // B is a never-persisted subject: GET → persisted:false → seed-up.
    getBody = { display_prefs: DEFAULTS, persisted: false };
    fetchMock.mockClear();
    setToken("B-bearer");
    await flush();

    const putCall = fetchMock.mock.calls.find(
      (c) => ((c[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "PUT",
    );
    expect(putCall).toBeDefined();
    // The seed-up carries DEFAULTS, never A's residual "hm"/true/{#a:hide}.
    expect(JSON.parse((putCall?.[1] as RequestInit).body as string)).toEqual({
      display_prefs: DEFAULTS,
    });
    dispose();
  });
});
