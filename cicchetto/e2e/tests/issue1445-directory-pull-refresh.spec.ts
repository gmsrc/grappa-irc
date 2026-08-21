// #1445 — pulling the channel directory's row list down asks for a re-capture,
// and the spinner slot follows the finger on the way.
//
// WHAT THESE PROVE, and what they deliberately do not:
//
//   1. THE DOOR (chromium): a synthesized downward drag past the commit
//      distance puts the Refresh button into its "Refreshing…" state. The
//      outcome asserted is the visible one, not that a callback fired — and it
//      is visible precisely BECAUSE the pull goes through the same
//      `triggerRefresh` the button goes through, so it raises the same store
//      latch (F1). A gesture wired to a second refresh path would leave the
//      button reading "Refresh" and turn this red.
//   2. DISPLACEMENT (chromium): mid-drag, the browser's own computed matrix
//      says the slot has moved by exactly the finger's travel and by nothing
//      else. Two things ride on that "and nothing else": the slot rests at
//      `translateY(-100%)`, which an inline transform REPLACES, so a paint
//      that forgot to re-state it would read +slotHeight instead of 0 for the
//      parked term; and the reading is taken mid-gesture, which is only a
//      stable number because `pull-gesture-active` drops the slot's snap-back
//      transition — without it getComputedStyle returns wherever the ease
//      happened to be.
//   3. CSS CONTRACT (@webkit, iPhone 15): on the real target browser the row
//      container refuses its own overscroll (so the iOS rubber-band does not
//      fight the slot at the one scroll position the pull lives at) while
//      still declaring the ONE axis it can be panned on. Three POSITIVE
//      assertions, not one absence: `overscroll-behavior: none` alone would
//      also be satisfied by a container that had stopped scrolling
//      altogether, and the scroller's own `pan-y` alone would leave the ROW
//      — the hit-test target across nearly the whole list — still reading
//      `auto`, which is the shape #913 measured as insufficient.
//
// NOT PROVEN ANYWHERE, on purpose rather than by omission:
//
//   * The FEEL, and with it the whole iOS question. A synthesized TouchEvent
//     drives no compositor and Playwright's webkit does not reproduce real iOS
//     scroll physics (feedback_playwright_webkit_not_ios_scroll). Nothing here
//     says the follow is smooth, that PULL_COMMIT_PX is the right distance, or
//     — the one that matters most — that iOS elects OUR gesture rather than
//     its own overscroll in the first place. The binder claims LATE, on a
//     touchmove, and on a real device the engine may have committed to a pan
//     before that claim lands. Test 3 asserts the CSS that is supposed to
//     prevent it; only a phone can say whether it does. That is a vjt call, as
//     it was for #213 and #1438.
//   * Interaction with the pane's scroll preservation. A progress ping that
//     lands WHILE a finger is down rewrites `scrollTop` from a queueMicrotask
//     (DirectoryPane's entry-count effect). Nothing here holds a finger across
//     a ping, and nothing here says what happens if one does.
//   * That the pull is DISCOVERABLE. The gesture is an addition; the button
//     and the stale CTA remain the discoverable paths, and no assertion here
//     is about a user finding it.
//
// The binder's decision table — which drags claim, which commit, which are
// left to native scroll — is unit-tested against a bare element in
// src/__tests__/pullGesture.test.ts, and the pane's wiring in jsdom in
// src/__tests__/DirectoryPane.test.tsx. These are the end-to-end doors.

import type { Locator, Page } from "@playwright/test";
import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

// "$list" — LIST_WINDOW_NAME from src/lib/windowKinds.ts, mirrored rather than
// imported to keep src VALUES out of the e2e runtime graph (fixtures/grappaApi.ts).
// NOT because the e2e tsconfig cannot resolve src/ — it can, and that fixture
// proves it (#1646). Pinned by src/__tests__/e2eConstantMirrors.test.ts.
const LIST_WINDOW_NAME = "$list";

// PULL_COMMIT_PX from src/lib/pullGesture.ts (SWIPE_MIN_PX * 2). Hardcoded for
// the same reason — but unlike the window name this copy CHECKS itself: test 2
// drags half of it and asserts the paint moved by that much, and the paint is
// capped at the real constant. Lower the real one and this spec reads the cap
// instead of the drag and goes red, naming the drift.
//
// #1646 adds a static second witness that needs no testnet, and it watches the
// number this comment does NOT name: the production side is DERIVED, so moving
// `SWIPE_MIN_PX` in src/lib/swipe.ts moves the cap while leaving 80 here.
const PULL_COMMIT_PX = 80;

// Open the directory pane and hand back its two moving parts.
//
// The door is per-layout and there is no layout-agnostic one: on mobile the
// $list window has NO BottomBar tab and lives behind compose `/list`
// (issue244's MOBILE arm carries the same note), so `selectChannel` — which is
// otherwise layout-aware — cannot reach it there. MEASURED, not assumed: the
// first draft of this spec used it for all three tests and the webkit arm sat
// 90s on a `.bottom-bar-tab[data-window-name="$list"]` that does not exist.
//
// No Refresh click here: `.directory-list` renders inside <Show when={page()}>
// and the pane's own mount GET is what produces that page, empty snapshot or
// not. Waiting for the button to read "Refresh" is the load-bearing part — it
// makes the pane's quiet state the PRE-STATE of every test below, so a
// "Refreshing…" seen later is the pull's doing and not a capture already in
// flight from a neighbouring spec.
async function openDirectory(
  page: Page,
  door: "sidebar" | "list-command",
): Promise<{ list: Locator; refresh: Locator }> {
  await loginAs(page, specUser());
  if (door === "sidebar") {
    await selectChannel(page, NETWORK_SLUG, LIST_WINDOW_NAME);
  } else {
    // Focus a channel to get a compose box, then open the directory from it.
    // expectUnmount: selecting the list window unmounts the ComposeBox (Shell
    // renders it only for kindHasScrollback kinds), so wait for the unmount
    // rather than the textarea-empty signal, which races it.
    const channel = AUTOJOIN_CHANNELS[0];
    if (channel === undefined) throw new Error("AUTOJOIN_CHANNELS empty");
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });
    await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toHaveClass(/selected/, {
      timeout: 10_000,
    });
    await composeSend(page, "/list", { expectUnmount: true });
  }

  const refresh = page.locator(".directory-refresh");
  await expect(refresh).toBeVisible({ timeout: 10_000 });
  const list = page.locator(".directory-list");
  await expect(list).toBeVisible({ timeout: 30_000 });
  await expect(refresh).toHaveText("Refresh", { timeout: 60_000 });
  return { list, refresh };
}

// One downward drag on the row list, plus the browser's own reading of where
// the slot sat before and during it. Body inlined in the page rather than
// passed as a stringified function: `new Function` in page context is eval,
// and cic serves a CSP with no `unsafe-eval` — the drag would throw where it
// matters and nowhere else.
//
// `dy` is applied in TWO moves because the binder claims LATE: it decides on a
// touchmove, never on the touchstart. `lift` is optional so a caller can read
// the paint with the finger still down, which is the only moment it exists.
async function pullList(
  list: Locator,
  dy: number,
  lift: boolean,
): Promise<{ before: number; after: number }> {
  return list.evaluate(
    (el, opts) => {
      const slot = el.querySelector<HTMLElement>(".directory-pull-slot");
      if (slot === null) throw new Error("no pull slot inside the directory list");
      // The vertical component of the computed matrix — what the browser
      // actually resolved, not the inline string we wrote.
      const verticalOffset = (): number =>
        new DOMMatrixReadOnly(getComputedStyle(slot).transform).f;
      const at = (y: number): Touch =>
        new Touch({ identifier: 1, target: el, clientX: 200, clientY: y });
      const fire = (type: string, touch: Touch): void => {
        const points = type === "touchend" ? [] : [touch];
        el.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: points,
            targetTouches: points,
            changedTouches: [touch],
          }),
        );
      };
      // The binder arms only at the top of the scroller, which is where a
      // freshly opened directory already is. Stated rather than assumed: a
      // neighbouring assertion that scrolled the list would otherwise turn
      // this into a silent no-op drag.
      el.scrollTop = 0;
      const y0 = 200;
      const before = verticalOffset();
      fire("touchstart", at(y0));
      fire("touchmove", at(y0 + 20));
      fire("touchmove", at(y0 + opts.dy));
      const after = verticalOffset();
      if (opts.lift) fire("touchend", at(y0 + opts.dy));
      return { before, after };
    },
    { dy, lift },
  );
}

test("#1445 — a downward pull on the directory asks for the refresh (chromium)", async ({
  page,
}) => {
  test.slow();
  const { list, refresh } = await openDirectory(page, "sidebar");

  // Comfortably past the commit distance whatever it is exactly, so this spec
  // asserts the door and not the calibration of a constant it does not own.
  await pullList(list, PULL_COMMIT_PX * 3, true);

  // The store latch raised by `triggerRefresh` is what makes this immediate
  // and what makes it evidence: it spans the POST→first-page-GET gap, so the
  // button flips before any server reply could have arrived. A pull wired
  // anywhere else would leave it reading "Refresh".
  await expect(refresh).toHaveText(/^Refreshing/, { timeout: 5_000 });
  await expect(refresh).toBeDisabled();
});

test("#1445 — mid-pull the slot moves by the finger's travel, parked offset intact (chromium)", async ({
  page,
}) => {
  test.slow();
  const { list } = await openDirectory(page, "sidebar");

  // Half the commit distance: under the cap, so a correct paint moves the slot
  // by exactly what the finger did. The rest position contributes -slotHeight
  // to this same component, so a paint that dropped it would read
  // +slotHeight + travel instead. The two failure modes are far apart and the
  // browser does the arithmetic.
  const travel = PULL_COMMIT_PX / 2;
  const { before, after } = await pullList(list, travel, false);

  expect(after - before).toBeCloseTo(travel, 0);
});

test("@webkit #1445 — the directory list refuses its own overscroll and declares its one pan axis (iPhone 15)", async ({
  page,
}) => {
  test.slow();
  const { list } = await openDirectory(page, "list-command");

  const contract = await list.evaluate((el) => {
    const row = el.querySelector<HTMLElement>(".directory-row-join");
    if (row === null) throw new Error("no directory row to hit-test against");
    const s = getComputedStyle(el);
    return {
      overscroll: s.overscrollBehaviorY,
      touchAction: s.touchAction,
      rowTouchAction: getComputedStyle(row).touchAction,
    };
  });

  // `none`, not `contain`: both stop a scroll chaining out of the list, only
  // `none` also suppresses the element's OWN overscroll affordance — the iOS
  // rubber-band that would fight the slot at scrollTop 0, which is the one
  // position the pull exists at.
  expect(contract.overscroll).toBe("none");
  // `pan-y`, not `none` and not `auto`. `none` would kill the native scroll
  // outright — which is why the pull cancels the pan from JS after a claim
  // rather than by declaration — and `auto` was still advertising a
  // horizontal pan and a pinch on a list that `overflow-x: hidden` says
  // never scrolls sideways.
  expect(contract.touchAction).toBe("pan-y");
  // The half that actually decides it. iOS elects the gesture consumer from
  // the hit-test target's own value and `touch-action` does not inherit, so a
  // row left at `auto` under a `pan-y` scroller is the exact shape #913
  // measured as not working. Reverting the descendant rule turns THIS red and
  // leaves the assertion above green — which is why they are two.
  expect(contract.rowTouchAction).toBe("pan-y");
});
