// #1336 (row #1079) — what a post-send scrollback trace MEANS, decided in one
// place instead of by an anonymous number in a failing poll.
//
// #1079 reports `scroll-on-window-switch` settling 337px from the bottom
// against an expected 50, the same number twice on two trees. 337 is
// `1415 - 1078`: the pane sitting exactly ON the unread marker after a send
// that should have taken it to the tail. The S2 slice proved the pre-send
// barrier vacuous and cured it, but never observed the vacuity being
// EXPLOITED — eight recorded samples exited at the marker every time.
//
// The instrument that produced those eight samples recorded POSITIONS, and
// that is why it could not settle the question. In the candidate that explains
// the number — `scrollToActivation`'s deferred `setFollowMode(near)` landing
// after the send's own re-arm — nothing writes `scrollTop` at all: the pane
// simply never leaves the marker, and `tailFollowWhenSettled` yields on
// `!followMode()` without writing or rescheduling. A recorder of positions is
// blind to that BY CONSTRUCTION. So the input here carries three channels on
// one clock: geometry, follow transitions, and rows recreations (the second
// silent exit of the same wait, on a list node that is no longer connected).
//
// Playwright-free on purpose, for the reason `scrollGesture.ts` gives: the
// instrument a claim is judged by has to be provable itself, and that means
// unit-testable without a testnet.

export type TraceEvent =
  | {
      readonly kind: "scroll";
      readonly t: number;
      readonly scrollTop: number;
      readonly maxScroll: number;
    }
  | { readonly kind: "follow"; readonly t: number; readonly follow: "on" | "off" }
  | { readonly kind: "rows"; readonly t: number }
  | {
      readonly kind: "mark";
      readonly t: number;
      readonly name: string;
      readonly value: number | null;
    };

// Which arm of `ScrollbackPane` the freeze is attributed to. Read off the
// CROSSING of the three channels, never off the product: the component keeps
// no reason for a follow write (`setFollowMode(near)` carries none, and the
// `onScroll` path discards the one it passes to `nextFollowMode`), so making
// it publish one would mean making it REMEMBER one — new state, which is a
// second state model rather than instrumentation.
export type DisarmCause = "scroll-up" | "activation" | "rows-recreation";

export type TraceVerdict = {
  // FROZEN-AT-MARKER is the terminal state #1079 photographs; SLOW is a pane
  // still being written, which Playwright's 5s poll absorbs and which never
  // reports the same number twice.
  readonly kind: "OK" | "SLOW" | "FROZEN-AT-MARKER";
  readonly distance: number;
  readonly attributedTo: DisarmCause | null;
};

export type ClassifyOptions = {
  // The same threshold the spec asserts on, passed in rather than mirrored so
  // the classifier cannot drift away from the assertion it explains.
  readonly thresholdPx: number;
};

const isScroll = (e: TraceEvent): e is Extract<TraceEvent, { kind: "scroll" }> =>
  e.kind === "scroll";

const markIndex = (events: readonly TraceEvent[], name: string): number =>
  events.findIndex((e) => e.kind === "mark" && e.name === name);

// The position the pane ENDED on, which is not the position the rest barrier
// reported: the send is supposed to move it, and the whole question is whether
// it did. Falls back to nothing when no geometry was recorded at all — a trace
// in that state is what `assertTraceIsUsable` refuses, and callers run it
// first.
function lastGeometry(
  events: readonly TraceEvent[],
): Extract<TraceEvent, { kind: "scroll" }> | undefined {
  return [...events].reverse().find(isScroll);
}

// The LAST disarm, because a send re-arms and the question is what happened
// after that. Written as a reverse scan rather than `findLastIndex`, which the
// e2e tsconfig's lib target does not carry.
function lastDisarmIndex(events: readonly TraceEvent[]): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event !== undefined && event.kind === "follow" && event.follow === "off") return i;
  }
  return -1;
}

export function classifyPostSend(
  events: readonly TraceEvent[],
  opts: ClassifyOptions,
): TraceVerdict {
  const sendAt = markIndex(events, "send");
  const after = sendAt < 0 ? [] : events.slice(sendAt + 1);
  const last = lastGeometry(events);
  const distance = last === undefined ? Number.NaN : last.maxScroll - last.scrollTop;

  // The assertion the row is about would have passed: whatever the trace shows
  // on the way, the pane is at the tail.
  if (distance <= opts.thresholdPx) return { kind: "OK", distance, attributedTo: null };

  const disarmAt = lastDisarmIndex(after);
  if (disarmAt >= 0) {
    // Still being written AFTER the disarm is not the frozen shape — the pane
    // is going somewhere, and where it stops is not yet known.
    const movedSince = after.slice(disarmAt + 1).filter(isScroll);
    if (movedSince.length > 0) return { kind: "SLOW", distance, attributedTo: null };

    // `onScroll` disarms on ANY scrollTop decrease, so a decrease standing
    // immediately before the disarm names that arm; a disarm with no movement
    // in front of it can only have come from a direct write — the activation
    // class.
    const before = after.slice(0, disarmAt).filter(isScroll);
    const previous = before[before.length - 2];
    const latest = before[before.length - 1];
    const decreased =
      previous !== undefined && latest !== undefined && latest.scrollTop < previous.scrollTop;
    return {
      kind: "FROZEN-AT-MARKER",
      distance,
      attributedTo: decreased ? "scroll-up" : "activation",
    };
  }

  // No disarm, and yet the pane never reached the tail: the other silent exit,
  // where the list node the deferred tail-follow was going to write has been
  // recreated under it.
  if (after.some((e) => e.kind === "rows"))
    return { kind: "FROZEN-AT-MARKER", distance, attributedTo: "rows-recreation" };

  return { kind: "SLOW", distance, attributedTo: null };
}

// The presence check, and the reason it exists: an instrument that recorded
// nothing must never read as "no exploitation observed". That is #1117's shape
// — negative assertions passing against an empty recorder — and this row sits
// inside the epic that exists to refuse it.
//
// The four markers are the ones present in BOTH outcomes. "The send's own tail
// write" is deliberately NOT among them, though an earlier draft of the design
// listed it: it is absent exactly when the defect fires, so requiring it would
// turn every real catch into an instrument failure.
export function assertTraceIsUsable(events: readonly TraceEvent[]): void {
  const restExit = markIndex(events, "rest-exit");
  if (restExit < 0)
    throw new Error("scrollTrace: no rest-exit mark — the barrier never reported where it stopped");

  const sendAt = markIndex(events, "send");
  if (sendAt < 0) throw new Error("scrollTrace: no send mark — the trace cannot be split");

  if (!events.slice(0, sendAt).some(isScroll))
    throw new Error(
      "scrollTrace: no scroll write before the send — the activation writes three, " +
        "so the recorder was installed too late or not at all",
    );

  if (!events.some((e) => e.kind === "follow"))
    throw new Error(
      "scrollTrace: no follow transition anywhere — the `data-follow` observer never fired",
    );
}
