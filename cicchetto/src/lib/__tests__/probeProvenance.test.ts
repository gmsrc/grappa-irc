// #769 — provenance for the `/messages/count` gap probe.
//
// The account-switch e2e (issue281) caught that request firing for the
// PREVIOUS identity's channel at roughly 1-in-20, and the URL is all it could
// report. Two things the wire cannot say are what the investigation needs:
// WHICH of the three probe sites emitted it, and whether the bearer it carried
// was still the current one. `scrollback.ts` now stamps both into
// `window.__cic_scrollbackProbes`, interleaved with the identity purge, so the
// ordering can be read off a failing run.
//
// These tests pin the recorder, and in doing so answer the ordering question
// deterministically for one path: the reconnect refresh CAN carry a bearer
// across a rotation (it awaits a page before probing), which is exactly the
// shape #769 hypothesised. They do NOT claim that is what the e2e caught —
// that needs the STACK lane and a failing run to read the ring on.

import { createSignal } from "solid-js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../api";
import type { ProbeTraceEntry } from "../scrollback";

// Mirror of loadInitialScrollback.test.ts: keep scrollback's transitive graph
// from opening a real WebSocket against jsdom's about:blank base URL.
vi.mock("../socket", () => ({
  joinUser: vi.fn(() => ({ on: vi.fn(), push: vi.fn().mockReturnValue({ receive: vi.fn() }) })),
  joinChannel: vi.fn(() => ({
    join: vi.fn(() => ({ receive: vi.fn().mockReturnValue({ receive: vi.fn() }) })),
    on: vi.fn(),
  })),
  pushCloseQueryWindow: vi.fn(),
  pushOpenQueryWindow: vi.fn(),
  notifyClientClosing: vi.fn(),
  pushAwaySet: vi.fn(),
  pushAwayUnset: vi.fn(),
}));

// A REAL Solid signal, unlike the flat `() => value` stub the sibling suites
// use: the whole subject here is the identity TRANSITION, and only a tracked
// source makes `identityScopedStore`'s `createEffect(on(token))` — and thus
// the purge — actually fire.
const [mockToken, setMockToken] = createSignal<string | null>("tok-a");
vi.mock("../auth", () => ({
  token: () => mockToken(),
  setToken: (v: string | null) => setMockToken(v),
}));

const listMessagesSpy = vi.fn<(...a: unknown[]) => Promise<ScrollbackMessage[]>>();
const listMessagesAfterSpy = vi.fn<(...a: unknown[]) => Promise<ScrollbackMessage[]>>();
const countMessagesAfterSpy = vi.fn<(...a: unknown[]) => Promise<number>>();
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    listMessages: (...args: unknown[]) => listMessagesSpy(...args),
    listMessagesAfter: (...args: unknown[]) => listMessagesAfterSpy(...args),
    countMessagesAfter: (...args: unknown[]) => countMessagesAfterSpy(...args),
  };
});

const setReadCursorSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../readCursor", async () => {
  const actual = await vi.importActual<typeof import("../readCursor")>("../readCursor");
  return {
    ...actual,
    setReadCursor: (...args: Parameters<typeof actual.setReadCursor>) => setReadCursorSpy(...args),
  };
});

const row = (id: number): ScrollbackMessage => ({
  id,
  network: "net",
  channel: "#bofh",
  server_time: 1_700_000_000 + id,
  kind: "privmsg",
  sender: "peer",
  body: `line ${id}`,
  meta: {},
});

const fullPage = (from: number): ScrollbackMessage[] =>
  Array.from({ length: 200 }, (_, i) => row(from + i));

const trace = (): ProbeTraceEntry[] =>
  (window as Window & { __cic_scrollbackProbes?: ProbeTraceEntry[] }).__cic_scrollbackProbes ?? [];

const probes = (): Extract<ProbeTraceEntry, { event: "probe" }>[] =>
  trace().filter((e): e is Extract<ProbeTraceEntry, { event: "probe" }> => e.event === "probe");

describe("#769 gap-probe provenance", () => {
  // #781 — a file whose first `await import()` of a heavy module happens
  // INSIDE a test pays vite's transform (seconds under worker contention) on
  // that test's 5s budget, and an overrun leaves the module evaluating in the
  // NEXT test. Paying it in a hook keeps the failure attributable.
  beforeAll(async () => {
    await import("../scrollback");
  });

  beforeEach(async () => {
    const { clearReadCursors } = await import("../readCursor");
    clearReadCursors();
    setReadCursorSpy.mockClear();
    listMessagesSpy.mockReset();
    listMessagesSpy.mockResolvedValue([]);
    listMessagesAfterSpy.mockReset();
    listMessagesAfterSpy.mockResolvedValue([]);
    countMessagesAfterSpy.mockReset();
    countMessagesAfterSpy.mockResolvedValue(0);
    // Restore the identity FIRST — coming back from a rotated/detached token is
    // itself a transition, and it would stamp a purge into the ring we are
    // about to read. Clear the ring after it has settled.
    setMockToken("tok-a");
    await Promise.resolve();
    (window as Window & { __cic_scrollbackProbes?: ProbeTraceEntry[] }).__cic_scrollbackProbes = [];
  });

  it("names the cold-open probe site and records the anchor it measured", async () => {
    const { loadInitialScrollback } = await import("../scrollback");
    const { applyJoinReply } = await import("../readCursor");
    const { channelKey } = await import("../channelKey");
    applyJoinReply("net", "#p-initial", 100);
    countMessagesAfterSpy.mockResolvedValue(5);

    await loadInitialScrollback("net", "#p-initial");

    // No `staleBearer` assertion here on purpose: this path has NO await
    // between its `token()` capture and the probe, so the flag is
    // structurally false and asserting it would prove nothing.
    expect(probes()).toHaveLength(1);
    expect(probes()[0]).toMatchObject({
      site: "initial-load",
      key: channelKey("net", "#p-initial"),
      anchor: 100,
    });
  });

  it("distinguishes the two reconnect probes, which the wire cannot", async () => {
    // Both fire under the same URL shape within one `refreshScrollback`, and
    // the second re-measures at the read cursor — so "which one leaked?" is
    // unanswerable from the request alone.
    const { refreshScrollback } = await import("../scrollback");
    const { applyJoinReply } = await import("../readCursor");
    applyJoinReply("net", "#p-refresh", 500);
    listMessagesAfterSpy.mockResolvedValue(fullPage(501));
    countMessagesAfterSpy.mockResolvedValueOnce(2000).mockResolvedValueOnce(2200);
    listMessagesSpy.mockResolvedValue([row(2900)]);

    await refreshScrollback("net", "#p-refresh");

    expect(probes().map((p) => [p.site, p.anchor])).toEqual([
      ["reconnect-refresh", 700],
      ["resolve-jump-target", 500],
    ]);
  });

  it("flags a probe that outlived the identity purge, in order", async () => {
    // The ordering #769 hypothesised, made deterministic: the verb captures
    // the bearer, awaits a page, the identity rotates mid-flight, and the
    // probe still goes out under the bearer it captured. The purge entry
    // sitting BEFORE the probe entry is the proof — no reasoning required.
    const { refreshScrollback } = await import("../scrollback");
    const { applyJoinReply } = await import("../readCursor");
    applyJoinReply("net", "#p-stale", 500);
    let releasePage: (rows: ScrollbackMessage[]) => void = () => {};
    listMessagesAfterSpy.mockImplementation(
      () =>
        new Promise<ScrollbackMessage[]>((resolve) => {
          releasePage = resolve;
        }),
    );
    // A small remaining gap, so the far-behind arm (and its second probe)
    // stays out of the way of what this test is about.
    countMessagesAfterSpy.mockResolvedValue(10);

    const pending = refreshScrollback("net", "#p-stale");
    setMockToken("tok-b");
    await Promise.resolve();
    releasePage(fullPage(501));
    await pending;

    // The recorder's subject, not the leak's: that a continuation resuming
    // past the purge is VISIBLE as one. Deliberately no assertion that the
    // request reached the wire under the revoked bearer — that is the defect
    // #769 exists to remove, and pinning it here would hand its fixer a red
    // test to argue with.
    expect(trace().map((e) => e.event)).toEqual(["identity-purge", "probe"]);
    expect(probes()[0]).toMatchObject({ site: "reconnect-refresh", staleBearer: true });
  });

  it("records a detach as a purge with no surviving token", async () => {
    // The shape the account-switch spec drives: A → detach → B. The factory
    // filters `null → tokB` (prev is null), so the switch leaves exactly ONE
    // purge entry, at the detach — anything stamped after it belongs to the
    // next identity's timeline.
    setMockToken(null);
    await Promise.resolve();
    setMockToken("tok-b");
    await Promise.resolve();

    expect(trace()).toEqual([{ event: "identity-purge", hasToken: false, at: expect.any(Number) }]);
  });
});
