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

    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      mountDisplayPrefsSync();
    });
    setToken(TOKEN);
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

    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      mountDisplayPrefsSync();
    });
    setToken(TOKEN);
    await flush();

    // Boot-cached local values survive the failed refresh.
    expect(getTimeFormat()).toBe("hm");
    expect(getChannelPresencePref(KEY_A)).toBe("hide");
    dispose();
  });

  it("does nothing on logout (no fetch, cache kept)", async () => {
    setTimeFormat("hm");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      mountDisplayPrefsSync();
    });
    // token is already null (resetLocal) — logout path.
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getTimeFormat()).toBe("hm");
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
