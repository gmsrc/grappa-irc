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

// The terminal distance is an INPUT, not something derived from the trace.
// Measured 2026-08-19 on a full suite: derived from the last recorded
// position, it accused a pane the live DOM said was at the tail. So every
// case below has to state what the DOM said, separately from what the
// recorder heard.
const classify = (events: readonly TraceEvent[], finalDistancePx: number): TraceVerdict =>
  classifyPostSend(events, { thresholdPx: THRESHOLD, finalDistancePx });

describe("#1336/#1079 — classifyPostSend", () => {
  it("calls a pane that reached the bottom after the send OK", () => {
    const verdict = classify(
      [...untilRest, mark(100, "send", null), follow(101, "on"), scroll(140, MAX_SCROLL)],
      0,
    );

    expect(verdict.kind).toBe("OK");
    expect(verdict.distance).toBe(0);
  });

  it("names FROZEN-AT-MARKER when follow is disarmed after the send with no movement", () => {
    // The candidate that explains the reported number: `scrollToActivation`'s
    // deferred `setFollowMode(near)` landing after the send's re-arm. Nothing
    // writes scrollTop afterwards — the pane simply never leaves the marker.
    const verdict = classify(
      [...untilRest, mark(100, "send", null), follow(101, "on"), follow(160, "off")],
      MAX_SCROLL - MARKER_TOP,
    );

    expect(verdict.kind).toBe("FROZEN-AT-MARKER");
    expect(verdict.distance).toBe(337);
    expect(verdict.attributedTo).toBe("activation");
  });

  it("attributes a disarm that FOLLOWS a scrollTop decrease to the scroll-up arm", () => {
    const verdict = classify(
      [
        ...untilRest,
        mark(100, "send", null),
        follow(101, "on"),
        scroll(150, MAX_SCROLL),
        scroll(180, MARKER_TOP),
        follow(181, "off"),
      ],
      MAX_SCROLL - MARKER_TOP,
    );

    expect(verdict.kind).toBe("FROZEN-AT-MARKER");
    expect(verdict.attributedTo).toBe("scroll-up");
  });

  it("attributes a stranded pane with NO disarm to the rows recreation", () => {
    // `tailFollowWhenSettled` has a second silent exit: the list node it was
    // going to write is no longer connected. Follow stays armed and the pane
    // still never moves.
    const verdict = classify(
      [...untilRest, mark(100, "send", null), follow(101, "on"), rows(150)],
      MAX_SCROLL - MARKER_TOP,
    );

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
    const verdict = classify(
      [
        ...untilRest,
        mark(920, "send", null),
        follow(940, "on"),
        rows(966),
        scroll(884, MAX_SCROLL),
        follow(884, "off"),
        scroll(884, MARKER_TOP),
      ],
      MAX_SCROLL - MARKER_TOP,
    );

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
    const verdict = classify(
      [
        ...untilRest,
        mark(100, "send", null),
        follow(101, "on"),
        scroll(150, 1200),
        scroll(180, 1300),
      ],
      MAX_SCROLL - 1300,
    );

    expect(verdict.kind).toBe("SLOW");
    expect(verdict.distance).toBe(115);
  });

  // REPLACES "measures the distance from the LAST position, not from the rest
  // exit". That test passed, and the rule its name pinned was wrong: the last
  // RECORDED position is not the terminal one. Deleted rather than kept
  // alongside, because two rules for one number is how the next reader picks
  // the wrong one.
  it("takes the distance from the LIVE read, not from the last recorded position", () => {
    const staleTrace = [
      ...untilRest,
      mark(100, "send", null),
      follow(101, "on"),
      rows(150),
      rows(154),
    ];

    // The recorder's last position is the marker — 337 away. The DOM says the
    // pane is at the tail. The DOM wins, and nothing is accused.
    expect(classify(staleTrace, 0).kind).toBe("OK");
    expect(classify(staleTrace, 0).distance).toBe(0);
  });

  // The general rule, not the one incident: whatever the three channels show —
  // here the STRONGEST frozen signal there is, a disarm after the send with no
  // movement — a live read at the tail forbids an accusation. The instrument
  // may only name the arm of a failure that actually happened.
  it("never accuses when the live read says the pane is at the tail", () => {
    const frozenShape = [
      ...untilRest,
      mark(100, "send", null),
      follow(101, "on"),
      follow(160, "off"),
    ];

    expect(classify(frozenShape, MAX_SCROLL - MARKER_TOP).kind).toBe("FROZEN-AT-MARKER");
    expect(classify(frozenShape, THRESHOLD).kind).toBe("OK");
    expect(classify(frozenShape, 0).attributedTo).toBeNull();
  });

  // THE MIRROR of the incident, and the direction that would never have
  // announced itself. The trace-derived rule could go stale in BOTH senses,
  // because `maxScroll` is sampled as `scrollHeight - clientHeight` inside the
  // scroll handler: content growing under a pane that is not following changes
  // the distance to the bottom while `scrollTop` never moves, so no scroll
  // event fires and the last record keeps saying "at the tail".
  //
  // Under the old rule that read OK and the instrument fell silent. It could
  // not turn a red into a green — the spec always rethrows the poll failure —
  // but it degraded a NAMED red into the anonymous one the instrument exists
  // to replace. Silence was the dangerous direction, so it gets the assertion.
  it("still accuses when the last recorded position says tail but the live read does not", () => {
    const grewUnderneath = [
      ...untilRest,
      mark(100, "send", null),
      follow(101, "on"),
      // The last geometry the recorder ever heard: the pane AT the tail.
      scroll(150, MAX_SCROLL),
      // Then a burst rebuilds the list. Content grows, scrollTop does not
      // move, and a passive listener is told nothing at all.
      rows(190),
      rows(240),
    ];

    // The mutant, made explicit rather than asserted in prose: the OLD rule
    // read the distance off the last recorded position, and that arithmetic
    // yields 0 here — under the threshold, so it returned OK and said nothing.
    const lastRecorded = [...grewUnderneath].reverse().find((e) => e.kind === "scroll");
    if (lastRecorded === undefined || lastRecorded.kind !== "scroll")
      throw new Error("fixture must carry a geometry record");
    expect(lastRecorded.maxScroll - lastRecorded.scrollTop).toBe(0);

    const verdict = classify(grewUnderneath, 585);

    expect(verdict.kind).toBe("FROZEN-AT-MARKER");
    expect(verdict.attributedTo).toBe("rows-recreation");
    // The number comes from the live read, not from the record that says 0.
    expect(verdict.distance).toBe(585);
  });
});

// The incident this fixture comes from, 2026-08-19, full suite run 1 of 2.
// The classifier accused a pane that was NOT frozen: the poll asserting
// `distance <= 50` had already PASSED (the test took 1.3s against a 5s expect
// timeout) and the failure screenshot shows the sent line at the bottom of the
// pane. Run 2, identical and cold, was green — 756/756 — and its trace differs
// from this one by exactly ONE record: a post-send `scroll` to 1415/1415
// arriving 11 ms after the last rows recreation. So the pane always moved;
// what varied was whether the scroll event had been DELIVERED to the recorder
// before the trace was read. A passive listener's silence is not evidence of
// stillness, and this trace is the proof, kept rather than retold.
const runOneFalseAccusation: readonly TraceEvent[] = [
  rows(183),
  { kind: "scroll", t: 197, scrollTop: 354, maxScroll: 361 },
  rows(342),
  follow(347, "off"),
  { kind: "scroll", t: 347, scrollTop: 7, maxScroll: 369 },
  rows(359),
  { kind: "scroll", t: 364, scrollTop: 1055, maxScroll: 1417 },
  { kind: "scroll", t: 380, scrollTop: 1078, maxScroll: 1417 },
  mark(538, "rest-exit", 1078),
  mark(557, "send", null),
  follow(572, "on"),
  rows(582),
  rows(586),
];

describe("#1336/#1079 — the trace that produced a false accusation", () => {
  it("is a usable trace: the presence check was never the defect", () => {
    expect(() => assertTraceIsUsable(runOneFalseAccusation)).not.toThrow();
  });

  it("is called OK, because the live read said the pane was at the tail", () => {
    // The exact live distance was not recorded — only that the poll accepted
    // it, so it was <= 50. That omission is itself part of the cure: the
    // verdict now carries the live number, so a future incident has it.
    const verdict = classify(runOneFalseAccusation, 0);

    expect(verdict.kind).toBe("OK");
    expect(verdict.attributedTo).toBeNull();
  });

  it("would still be accused if the live read agreed with the stale record", () => {
    // The cure must not blunt the instrument: hand it the number the stale
    // record implied — 1417 - 1078 — and the accusation stands, with the arm
    // named. Only the DISTANCE moved to a live source; attribution did not.
    const verdict = classify(runOneFalseAccusation, 1417 - 1078);

    expect(verdict.kind).toBe("FROZEN-AT-MARKER");
    expect(verdict.distance).toBe(339);
    expect(verdict.attributedTo).toBe("rows-recreation");
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
