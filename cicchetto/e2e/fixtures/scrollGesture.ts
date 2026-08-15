// #1336 — a scroll gesture that has actually LANDED before the test moves on.
//
// The idiom this replaces read like a gesture and was not one:
//
//     await expect.poll(async () => { await page.mouse.wheel(0, -4000);
//                                     return distanceToBottom(page) })
//       .toBeGreaterThan(50);
//
// Two independent defects, both measured on `issue168-scroll-authority`
// (2026-08-15, dev host):
//
//   * `page.mouse.wheel()` RESOLVES BEFORE THE SCROLL IS APPLIED. The probe
//     read `scrollTop=1078` immediately after the wheel — byte-identical to
//     the pre-gesture read — and the pane was still at 1078 when the poll
//     returned. On a sibling spec the injected wheel landed ~250 ms later,
//     i.e. inside whatever the test did next.
//   * THE PREDICATE WAS ALREADY TRUE. The pane sat 339 px from the bottom on
//     the cold-mount marker, so `> 50` held before the wheel; the poll exited
//     on its first evaluation and the assertion said "the operator paged up"
//     about a pane nobody had touched. A gate satisfied by the pre-existing
//     state is not a gate — the same shape as #1117's negative assertions
//     passing on an empty recorder.
//
// The consequence is not cosmetic. The scroll lands late, and if it lands
// after a send, `ScrollbackPane`'s `onScroll` reads the scrollTop DECREASE as
// the operator leaving the tail, disarms the follow intent, and the deferred
// tail-follow yields — the pane freezes wherever the late scroll left it, for
// good. That is the whole of #1080 / #1079: a frozen pane's distance-to-bottom
// is invariant under later content growth, which is why both reported the SAME
// number every time they tripped (1417 = a pane at scrollTop 0; 337 = a pane
// still on the marker).
//
// So the contract here is: hover, wheel, then wait for the pane to MOVE and
// then HOLD, and REJECT if it never did either. Rejecting on "never moved" is
// the positive control the old idiom lacked: while building this, an injected
// wheel was silently inert for an entire run because the mouse was not over
// the pane, and every assertion downstream still passed.
//
// Free of Playwright by construction (the caller adapts a Page to `ScrollPane`)
// for the reason `whoisWait.ts` gives: the instrument a claim is judged by has
// to be provable itself, and that means unit-testable without a testnet.

export type ScrollPane = {
  hover(): Promise<void>;
  wheel(deltaY: number): Promise<void>;
  scrollTop(): Promise<number>;
};

export type ScrollGestureOptions = {
  // Wheel delta, in the sign the DOM uses: NEGATIVE scrolls up.
  readonly deltaY: number;
  // Budget for the whole gesture — dispatch, travel and settle.
  readonly timeoutMs: number;
  // Gap between scrollTop samples.
  readonly pollMs: number;
};

export type ScrollGestureResult = {
  readonly from: number;
  readonly to: number;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Perform the gesture and resolve only once the pane has moved AND come to
// rest. Rejects rather than resolving on either failure, because "it did not
// move" and "it is still moving" are both the wrong thing to tell a caller who
// is about to assert on the position.
//
// SETTLED means two consecutive samples agree at a value different from where
// the pane started. A single post-movement sample is not enough: chromium
// delivers a wheel as an animation, so the first changed value is mid-flight
// and reporting it would name a position the pane is about to leave.
//
// A gesture the pane cannot honour (already clamped at the requested end) is a
// REJECT, not a silent success: the caller asked for a displacement, and
// "already there" does not establish the operator-intent the wheel stands for.
export async function scrollByGesture(
  pane: ScrollPane,
  opts: ScrollGestureOptions,
): Promise<ScrollGestureResult> {
  const { deltaY, timeoutMs, pollMs } = opts;
  const from = await pane.scrollTop();

  await pane.hover();
  await pane.wheel(deltaY);

  const deadline = Date.now() + timeoutMs;
  let moved = false;
  let previous = from;

  while (Date.now() < deadline) {
    const current = await pane.scrollTop();
    if (current !== from) {
      if (moved && current === previous) return { from, to: current };
      moved = true;
    }
    previous = current;
    await sleep(pollMs);
  }

  throw new Error(
    moved
      ? `scrollByGesture: wheel(${deltaY}) never settled within ${timeoutMs}ms ` +
          `(from ${from}, last ${previous}) — the pane was still moving when the budget ran out`
      : `scrollByGesture: wheel(${deltaY}) never moved the pane within ${timeoutMs}ms ` +
          `(scrollTop stayed ${from}) — the gesture was not delivered, or the pane is already clamped`,
  );
}
