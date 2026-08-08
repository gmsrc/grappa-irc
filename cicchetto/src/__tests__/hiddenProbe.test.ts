import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import {
  expectedTicks,
  formatHiddenProbeLine,
  HIDDEN_TICK_MS,
  type HiddenCounters,
  installHiddenProbe,
} from "../lib/hiddenProbe";

// #1061 — the background-burn instrument. What is under test is the
// ATTRIBUTION: a line whose counters are wrong is worse than no line, because
// it would exonerate or convict the socket on a number nobody can check.

describe("expectedTicks", () => {
  it("floors, so an unthrottled run does not read as a throttled one", () => {
    expect(expectedTicks(2900)).toBe(2);
    expect(expectedTicks(3000)).toBe(3);
  });

  it("is zero for an episode shorter than one tick", () => {
    expect(expectedTicks(0)).toBe(0);
    expect(expectedTicks(HIDDEN_TICK_MS - 1)).toBe(0);
  });
});

describe("formatHiddenProbeLine", () => {
  it("reads left to right: duration, tick rate, then the two socket deltas", () => {
    expect(formatHiddenProbeLine({ hiddenMs: 42_300, ticks: 41, attempts: 0, errors: 0 })).toBe(
      "hidden 42.3s ticks=41/42 ws-attempts=+0 ws-errors=+0",
    );
  });

  it("shows a spinning native ladder as a non-zero error delta", () => {
    // The signature that would CONVICT the socket: phoenix's own reconnect
    // ladder running while hidden, one onError per failed attempt.
    expect(formatHiddenProbeLine({ hiddenMs: 10_000, ticks: 10, attempts: 0, errors: 137 })).toBe(
      "hidden 10.0s ticks=10/10 ws-attempts=+0 ws-errors=+137",
    );
  });
});

interface Harness {
  setVisible: (v: boolean) => void;
  lines: string[];
  tick: () => void;
  tickerRunning: () => boolean;
  advance: (ms: number) => void;
  setCounters: (c: HiddenCounters) => void;
}

function harness(opts: { enabled: boolean }): Harness {
  const [visible, setVisible] = createSignal(true);
  const lines: string[] = [];
  let clock = 0;
  let counters: HiddenCounters = { connectAttempts: 0, errorsTotal: 0 };
  let onTick: (() => void) | null = null;

  createRoot(() => {
    installHiddenProbe({
      isVisible: visible,
      enabled: () => opts.enabled,
      push: (line) => lines.push(line),
      now: () => clock,
      counters: () => counters,
      startTicker: (cb) => {
        onTick = cb;
        return () => {
          onTick = null;
        };
      },
    });
  });

  return {
    setVisible,
    lines,
    tick: () => onTick?.(),
    tickerRunning: () => onTick !== null,
    advance: (ms) => {
      clock += ms;
    },
    setCounters: (c) => {
      counters = c;
    },
  };
}

describe("installHiddenProbe", () => {
  it("reports one line per hidden episode, with the socket deltas over it", () => {
    const h = harness({ enabled: true });
    h.setVisible(false);
    h.advance(5000);
    for (let i = 0; i < 5; i++) h.tick();
    h.setCounters({ connectAttempts: 3, errorsTotal: 12 });
    h.setVisible(true);

    expect(h.lines).toEqual(["hidden 5.0s ticks=5/5 ws-attempts=+3 ws-errors=+12"]);
  });

  it("reports deltas, not absolutes — a counter that was already high is not this episode's fault", () => {
    // The tallies are monotonic across the whole session, so an episode that
    // opened at 900 errors and closed at 902 saw TWO, not 902. Reading the
    // absolute here would convict the socket on every episode after the first
    // bad one.
    const h = harness({ enabled: true });
    h.setCounters({ connectAttempts: 40, errorsTotal: 900 });
    h.setVisible(false);
    h.advance(1000);
    h.tick();
    h.setCounters({ connectAttempts: 40, errorsTotal: 902 });
    h.setVisible(true);

    expect(h.lines).toEqual(["hidden 1.0s ticks=1/1 ws-attempts=+0 ws-errors=+2"]);
  });

  it("stops the ticker when the episode ends, so the probe costs nothing while visible", () => {
    const h = harness({ enabled: true });
    expect(h.tickerRunning()).toBe(false);
    h.setVisible(false);
    expect(h.tickerRunning()).toBe(true);
    h.setVisible(true);
    expect(h.tickerRunning()).toBe(false);
  });

  it("records nothing at all when diagnostics are off", () => {
    const h = harness({ enabled: false });
    h.setVisible(false);
    h.advance(5000);
    h.setVisible(true);
    expect(h.lines).toEqual([]);
    expect(h.tickerRunning()).toBe(false);
  });

  it("emits one line per episode across repeated background/foreground cycles", () => {
    const h = harness({ enabled: true });
    h.setVisible(false);
    h.advance(2000);
    h.tick();
    h.tick();
    h.setVisible(true);
    h.advance(1000);
    h.setVisible(false);
    h.advance(3000);
    h.setCounters({ connectAttempts: 0, errorsTotal: 7 });
    h.setVisible(true);

    expect(h.lines).toEqual([
      "hidden 2.0s ticks=2/2 ws-attempts=+0 ws-errors=+0",
      "hidden 3.0s ticks=0/3 ws-attempts=+0 ws-errors=+7",
    ]);
  });
});
