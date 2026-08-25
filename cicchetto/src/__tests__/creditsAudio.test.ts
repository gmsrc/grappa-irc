import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCreditsArpeggio } from "../lib/creditsAudio";

// #1773 — the credit roll's synthesised soundtrack.
//
// Two things are worth proving here and neither is the music. The first is
// that it can be SILENCED, because the modal autoplays: it opens on a click,
// so the browser lets it, which means the mute control is the only thing
// standing between an easter egg and someone's open-plan office. The second
// is that it LEAVES NOTHING BEHIND — a scheduler still arming oscillators
// behind a dismissed dialog is the same battery bug as an orphaned rAF loop,
// and it is completely inaudible, so nothing but a test would ever catch it.
//
// jsdom has no WebAudio at all. The AudioContext is handed in rather than
// constructed by the module precisely so this file can supply one; the
// component does the feature test.

type StubParam = {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  setTargetAtTime: ReturnType<typeof vi.fn>;
};

type StubOscillator = {
  type: string;
  frequency: StubParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
};

function stubParam(): StubParam {
  return {
    value: 0,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
  };
}

function makeCtx() {
  const oscillators: StubOscillator[] = [];
  const gains: { gain: StubParam; connect: ReturnType<typeof vi.fn> }[] = [];
  const close = vi.fn();
  const resume = vi.fn();

  const ctx = {
    currentTime: 0,
    state: "running" as AudioContextState,
    destination: {} as AudioDestinationNode,
    close,
    resume,
    createGain: () => {
      const node = { gain: stubParam(), connect: vi.fn(), disconnect: vi.fn() };
      gains.push(node);
      return node;
    },
    createOscillator: () => {
      const node: StubOscillator = {
        type: "",
        frequency: stubParam(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      oscillators.push(node);
      return node;
    },
  };

  return { ctx: ctx as unknown as AudioContext, oscillators, gains, close, resume };
}

describe("startCreditsArpeggio (#1773)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("opens silent when the reader has already muted it", () => {
    // Not "mutes shortly after starting": the modal remembers the mute across
    // a close and reopen within a session, and a ramp-down from full volume
    // would play the first note anyway — which is the whole thing the reader
    // asked not to happen.
    const { ctx, gains } = makeCtx();

    startCreditsArpeggio(ctx, true);

    expect(gains[0]?.gain.value).toBe(0);
  });

  it("opens audible when it has not been muted", () => {
    // The positive control for the case above: without it, a master gain
    // hard-wired to zero would pass that one and ship a silent easter egg.
    const { ctx, gains } = makeCtx();

    startCreditsArpeggio(ctx, false);

    expect(gains[0]?.gain.value).toBeGreaterThan(0);
  });

  it("ramps to silence and back on the mute toggle", () => {
    const { ctx, gains } = makeCtx();
    const arpeggio = startCreditsArpeggio(ctx, false);
    const master = gains[0];

    arpeggio.setMuted(true);
    expect(master?.gain.setTargetAtTime).toHaveBeenCalledWith(0, 0, expect.any(Number));

    arpeggio.setMuted(false);
    // A RAMP back to an AUDIBLE target, not to whatever happened to be
    // there: asserting only that setTargetAtTime was called again would pass
    // on an unmute that ramps to zero.
    const calls = master?.gain.setTargetAtTime.mock.calls ?? [];
    expect(calls[calls.length - 1]?.[0]).toBeGreaterThan(0);
  });

  it("arms the next bar while it is running", () => {
    // The positive control for the teardown case below. Without it, a
    // scheduler that never re-armed at all would pass "no new voices after
    // stop" while being broken in the opposite direction.
    const { ctx, oscillators } = makeCtx();
    startCreditsArpeggio(ctx, false);
    const firstBar = oscillators.length;

    vi.advanceTimersByTime(5_000);

    expect(oscillators.length).toBeGreaterThan(firstBar);
  });

  it("stops scheduling, silences every voice and closes the context", () => {
    const { ctx, oscillators, close } = makeCtx();
    const arpeggio = startCreditsArpeggio(ctx, false);
    const armed = oscillators.length;
    expect(armed).toBeGreaterThan(0);

    arpeggio.stop();

    // Every voice already scheduled — including a note whose start time is
    // still in the future, which `onended` can never reach because a note
    // that has not begun never ends.
    for (const osc of oscillators) {
      expect(osc.stop).toHaveBeenCalled();
      expect(osc.disconnect).toHaveBeenCalled();
    }
    expect(close).toHaveBeenCalled();

    // And nothing re-arms. This is the leak: inaudible, because the context
    // is closed, and permanent, because the timer would keep re-arming for
    // as long as the tab lives.
    vi.advanceTimersByTime(30_000);
    expect(oscillators.length).toBe(armed);
  });

  it("survives a second stop and a mute after teardown", () => {
    // The component calls stop() from an effect AND from onCleanup, so the
    // double call is the normal path, not a defensive hypothetical.
    const { ctx, close } = makeCtx();
    const arpeggio = startCreditsArpeggio(ctx, false);

    arpeggio.stop();
    arpeggio.stop();
    arpeggio.setMuted(true);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("resumes a context the browser handed back suspended", () => {
    // Safari does this more often than Chromium, and a suspended context
    // schedules everything correctly while making no sound at all.
    const { ctx, resume } = makeCtx();
    (ctx as unknown as { state: AudioContextState }).state = "suspended";

    startCreditsArpeggio(ctx, false);

    expect(resume).toHaveBeenCalled();
  });
});
