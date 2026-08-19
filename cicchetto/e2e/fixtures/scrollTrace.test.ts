// #1336 (row #1079) — the classifier is the instrument the row will be judged
// by, so it is provable without a testnet, like `scrollGesture.test.ts` and
// `whoisWait.test.ts`. Every trace below is hand-built from the numbers S2
// recorded in-page (reset 7, marker jump 1055, marker 1078, maxScroll 1415),
// so a case that passes here describes a pane that actually existed.
//
// What the row still needs is not another position recorder. #1079's number is
// 337 = 1415 - 1078, the pane sitting ON the marker after a send that should
// have taken it to the bottom; the candidate that leaves it there disarms the
// follow intent AFTER the send and writes no scrollTop at all. A recorder of
// positions is blind to that by construction, which is why the classifier's
// input carries follow transitions and rows recreations beside the geometry.

import { describe, expect, it } from "vitest";
import {
  assertTraceIsUsable,
  classifyPostSend,
  type TraceEvent,
  type TraceVerdict,
} from "./scrollTrace";

const MAX_SCROLL = 1415;
const MARKER_TOP = 1078;
const THRESHOLD = 50;

const scroll = (t: number, scrollTop: number): TraceEvent => ({
  kind: "scroll",
  t,
  scrollTop,
  maxScroll: MAX_SCROLL,
});
const follow = (t: number, state: "on" | "off"): TraceEvent => ({
  kind: "follow",
  t,
  follow: state,
});
const rows = (t: number): TraceEvent => ({ kind: "rows", t });
const mark = (t: number, name: string, value: number | null): TraceEvent => ({
  kind: "mark",
  t,
  name,
  value,
});

// The activation, as recorded: the rows recreation resets to the top, the
// marker jump passes through, the pane parks on the marker, and the rest
// barrier reports where it stopped. Every trace starts here.
const untilRest: readonly TraceEvent[] = [
  scroll(45, 7),
  follow(46, "off"),
  scroll(59, 1055),
  scroll(78, MARKER_TOP),
  follow(79, "off"),
  mark(80, "rest-exit", MARKER_TOP),
];

const classify = (events: readonly TraceEvent[]): TraceVerdict =>
  classifyPostSend(events, { thresholdPx: THRESHOLD });

describe("#1336/#1079 — classifyPostSend", () => {
  it("calls a pane that reached the bottom after the send OK", () => {
    const verdict = classify([
      ...untilRest,
      mark(100, "send", null),
      follow(101, "on"),
      scroll(140, MAX_SCROLL),
    ]);

    expect(verdict.kind).toBe("OK");
    expect(verdict.distance).toBe(0);
  });

  it("names FROZEN-AT-MARKER when follow is disarmed after the send with no movement", () => {
    // The candidate that explains the reported number: `scrollToActivation`'s
    // deferred `setFollowMode(near)` landing after the send's re-arm. Nothing
    // writes scrollTop afterwards — the pane simply never leaves the marker.
    const verdict = classify([
      ...untilRest,
      mark(100, "send", null),
      follow(101, "on"),
      follow(160, "off"),
    ]);

    expect(verdict.kind).toBe("FROZEN-AT-MARKER");
    expect(verdict.distance).toBe(337);
    expect(verdict.attributedTo).toBe("activation");
  });

  it("attributes a disarm that FOLLOWS a scrollTop decrease to the scroll-up arm", () => {
    const verdict = classify([
      ...untilRest,
      mark(100, "send", null),
      follow(101, "on"),
      scroll(150, MAX_SCROLL),
      scroll(180, MARKER_TOP),
      follow(181, "off"),
    ]);

    expect(verdict.kind).toBe("FROZEN-AT-MARKER");
    expect(verdict.attributedTo).toBe("scroll-up");
  });

  it("attributes a stranded pane with NO disarm to the rows recreation", () => {
    // `tailFollowWhenSettled` has a second silent exit: the list node it was
    // going to write is no longer connected. Follow stays armed and the pane
    // still never moves.
    const verdict = classify([...untilRest, mark(100, "send", null), follow(101, "on"), rows(150)]);

    expect(verdict.kind).toBe("FROZEN-AT-MARKER");
    expect(verdict.attributedTo).toBe("rows-recreation");
  });

  // MEASURED, not imagined: this is the tail of the trace an injected
  // post-send scroll-back produced in situ (2026-08-19, one run). The pane
  // reached the tail, the injected write took it back to the marker, and the
  // recorder logged the disarm BEFORE the decrease that caused it — the
  // MutationObserver microtask lands between two listeners on the same event.
  // A classifier that decides "still moving" from events ordered after the
  // disarm called this SLOW, and it is the frozen shape: 337px, terminal.
  it("calls the measured injected freeze FROZEN, though a scroll is recorded after the disarm", () => {
    const verdict = classify([
      ...untilRest,
      mark(920, "send", null),
      follow(940, "on"),
      rows(966),
      scroll(884, MAX_SCROLL),
      follow(884, "off"),
      scroll(884, MARKER_TOP),
    ]);

    expect(verdict.kind).toBe("FROZEN-AT-MARKER");
    expect(verdict.distance).toBe(337);
    // It reached the tail and left it: that is the `onScroll` decrease arm,
    // whatever order the two same-millisecond records arrived in.
    expect(verdict.attributedTo).toBe("scroll-up");
  });

  it("calls a pane still being written SLOW, not frozen", () => {
    // Slowness is not the defect: Playwright's poll absorbs it under its 5s
    // default, and the value it eventually reports VARIES. Only a terminal
    // state repeats a number byte for byte, which is what #1079 reported.
    const verdict = classify([
      ...untilRest,
      mark(100, "send", null),
      follow(101, "on"),
      scroll(150, 1200),
      scroll(180, 1300),
    ]);

    expect(verdict.kind).toBe("SLOW");
    expect(verdict.distance).toBe(115);
  });

  it("measures the distance from the LAST position, not from the rest exit", () => {
    const verdict = classify([
      ...untilRest,
      mark(100, "send", null),
      scroll(150, 1400),
      scroll(180, 1400),
      follow(181, "off"),
    ]);

    expect(verdict.distance).toBe(15);
    expect(verdict.kind).toBe("OK");
  });
});

describe("#1336/#1079 — assertTraceIsUsable", () => {
  // The whole point of the presence check: an instrument that recorded nothing
  // must not read as "no exploitation observed". That is the #1117 shape —
  // negative assertions passing against an empty recorder — and this row is
  // inside the epic that exists to refuse it.
  const usable: readonly TraceEvent[] = [...untilRest, mark(100, "send", null), follow(101, "on")];

  it("accepts a trace carrying all four mandatory markers", () => {
    expect(() => assertTraceIsUsable(usable)).not.toThrow();
  });

  it("rejects an EMPTY trace, naming what is missing", () => {
    expect(() => assertTraceIsUsable([])).toThrow(/rest-exit/);
  });

  it("rejects a trace with no follow transition at all", () => {
    const noFollow = usable.filter((e) => e.kind !== "follow");
    expect(() => assertTraceIsUsable(noFollow)).toThrow(/follow transition/);
  });

  it("rejects a trace with no scroll write BEFORE the send", () => {
    // The activation always writes scrollTop three times; a trace without one
    // means the recorder was installed too late, or not at all.
    const noPreSend = usable.filter((e) => e.kind !== "scroll");
    expect(() => assertTraceIsUsable(noPreSend)).toThrow(/before the send/);
  });

  it("rejects a trace with no send mark", () => {
    const noSend = usable.filter((e) => !(e.kind === "mark" && e.name === "send"));
    expect(() => assertTraceIsUsable(noSend)).toThrow(/send/);
  });

  // Deliberately NOT a mandatory marker, and the design comment on #1336 was
  // wrong to list it: "the send's own tail write" is absent exactly when the
  // defect fires. A presence check that trips on the phenomenon it is meant to
  // license would turn every real catch into an instrument failure.
  it("accepts a trace where NOTHING was written after the send", () => {
    expect(() => assertTraceIsUsable(usable)).not.toThrow();
    expect(usable.filter((e) => e.kind === "scroll" && e.t > 100)).toHaveLength(0);
  });
});
