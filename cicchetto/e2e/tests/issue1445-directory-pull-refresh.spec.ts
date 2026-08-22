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
//      says the TRACK has moved by exactly the finger's travel and by nothing
//      else. The reading is taken mid-gesture, which is only a stable number
//      because `pull-gesture-active` drops the snap-back transition — without
//      it getComputedStyle returns wherever the ease happened to be.
//      #1658 point 3 moved this reading off the slot and onto the track. The
//      slot no longer carries a transform of its own beyond the parked
//      `translateY(-100%)` in the stylesheet; what moves it is its ancestor.
//   2b. THE ROWS FOLLOW THE FINGER, AND THE SPINNER RIDES ABOVE THEM (#1658
//      point 3, chromium). Two assertions, and the first is the defect vjt
//      kept reporting: at a travel of 400px the first row's top edge sits well
//      below the list's top edge — the CONTENT moved, not just the spinner.
//      #1669 turned that reading from "by exactly 400px" into the pair of
//      inequalities its own section below sets out (past the commit distance,
//      short of the finger's 400), because the travel is damped now and an
//      equality with the finger's distance IS the defect #1669 removes.
//      Until point 3 only the slot moved, and because rows start at y=0 too,
//      every position where the spinner was visible was a position where it
//      covered the first row's top band; the strongest true statement
//      available then was the weaker "the slot never travels PAST the top
//      edge", and this file used to assert exactly that.
//      The second is the STRONG invariant that replaces it: the slot's bottom
//      edge lands ON the first row's top edge, never below it. It holds because
//      the two are one rigid body under one transform — an identity, not a
//      bound — so what this measures is that the ENGINE agrees with that
//      geometry once real layout exists, which jsdom cannot say.
//      Asserted at THREE root font sizes, with the slot height read alongside:
//      the slot is `2.5rem` against a size the user picks, and without the
//      height control three identical readings from a `--font-size` write that
//      silently failed would look like proof.
//   2c. NO PAINT AFTER THE COMMIT (#1658, chromium): the committing release
//      leaves no inline transform on the track and no inline opacity on the
//      slot. The binder does not call `onRelease` on that path, so the pane
//      clears the paint from `onCommit` — before that fix the spinner stayed
//      exactly where the finger left it, at full opacity, for the life of the
//      pane. Point 3 raised the stakes on it: the travel is on the TRACK now,
//      so the same omission would strand the whole channel list a hundred-odd
//      pixels down the pane, not just a spinner. Both elements are asserted,
//      and so is the slot's own transform staying empty — the pane must not
//      write one.
//   3. CSS CONTRACT (@webkit, iPhone 15): on the real target browser the row
//      container refuses its own overscroll (so the iOS rubber-band does not
//      fight the slot at the one scroll position the pull lives at) while
//      still declaring the ONE axis it can be panned on. Three POSITIVE
//      assertions, not one absence: `overscroll-behavior: none` alone would
//      also be satisfied by a container that had stopped scrolling
//      altogether, and the scroller's own `pan-y` alone would leave the ROW
//      — the hit-test target across nearly the whole list — still reading
//      `auto`, which is the shape #913 measured as insufficient.
//   3b. THE INVARIANT, RESOLVED BY THE ENGINE THE BUG CAME FROM (#1658 point
//      3, @webkit): a track translate of the SHAPE the pane writes — since
//      #1669 a fractional px value, see that test's own note — is
//      applied straight to the track and the engine's own geometry is read
//      back — did the ROWS move by it, and did the slot's bottom still land on
//      the first row's top?
//      The question is not the same one chromium answers, and that is why the
//      arm exists. The invariant is an identity only if the engine composes an
//      ancestor's px translate with the slot's OWN `translateY(-100%)` — a
//      PERCENTAGE that resolves against the slot's own height, not the
//      track's. Chromium composing it correctly says nothing about WebKit, and
//      a WebKit that resolved that percentage against the wrong box would put
//      the spinner back on top of the first row: the exact defect, on the only
//      engine the reporter has, with every chromium gate here GREEN. That is
//      the empty-green class — a gate that passes because it does not look
//      where the defect lives.
//      It used to ask a different question — whether WebKit resolved
//      `translateY(min(<px>, 100%))`, the mixed-unit cap. Point 3 deleted that
//      declaration from production, so the test was re-aimed rather than
//      dropped: the engine half is still worth a witness, only the geometry it
//      witnesses changed.
//      NO GESTURE, deliberately and not for convenience: `new Touch(...)` is
//      an `Illegal constructor` on Playwright's WebKit (measured; issue230's
//      header records the same limit for its own drag), so the production
//      gesture cannot be synthesized on that project at all. What 3b buys is
//      the ENGINE half; the PANE half — that the pane writes this declaration
//      from a real finger — is 2b's, on chromium. Each is honest about which
//      half it owns, and neither pretends to the other.
//      It carries a plain-px ARITHMETIC CONTROL ahead of the real reading,
//      because the first draft of it had none and measured the 150ms
//      snap-back transition instead of the resolved transform: every
//      declaration read as "parked" on BOTH engines and it looked like a
//      total WebKit failure. The control fails loudly in that state.
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
//   * That Playwright's WebKit IS iOS Safari. Test 3b measures the same engine
//     family under a phone viewport, which is the closest thing reachable from
//     CI and strictly more than a chromium-only reading — it answers "does
//     WebKit compose an ancestor's px translate with a descendant's own
//     percentage offset such that the invariant holds", a question chromium
//     cannot answer at all. It does not answer "does it resolve the same way on
//     vjt's phone", and no assertion here claims it does.
//   * The TWO FEEL NUMBERS #1669 added — the damping factor and the ceiling.
//     They are declared provisional in `DirectoryPane.tsx` and vjt calibrates
//     them on a device; nothing in this file names either one, and nothing here
//     says the resistance feels like an iOS scroller. What test 3 asserts is
//     the visible PROPERTY: 400px of finger moves the rows by more than the
//     commit distance and by strictly LESS than 400 — damped, still following.
//     The curve's own guarantees (strictly increasing, gain never rising,
//     bounded by the ceiling) are properties of a number and are pinned over a
//     dense sweep in src/__tests__/DirectoryPane.test.tsx, where changing them
//     costs no testnet.
//     🔴 IOS PARITY, which the issue names as the acceptance bar, IS PROVEN
//     NOWHERE AND IS NOT CLAIMED. Playwright's webkit does not reproduce real
//     iOS scroll physics (the bullet above), so no reading in this file can
//     speak to it. That call is vjt's, on the phone.
//   * The GESTURE on WebKit, by anything here. `new Touch(...)` throws
//     `Illegal constructor` there, so no test in this file drives the binder
//     on that project. MEASURED while looking for a way round it, and recorded
//     because the next person will look too: `document.createTouch` DOES
//     exist and returns a usable Touch, `document.createEvent("TouchEvent")`
//     succeeds but has no `initTouchEvent`, and `new TouchEvent(type, {...})`
//     accepts a `document.createTouchList(...)` for its touch sequences while
//     rejecting a plain array with `TypeError: Type error`. So a WebKit drag
//     is reachable — nobody has built it, and whether the wiring half is worth
//     proving twice is a product call, not this file's.
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

// PULL_COMMIT_PX from src/lib/pullGesture.ts. Hardcoded for the same reason as
// the window name above.
//
// #1658 — and unlike the window name this copy stopped CHECKING ITSELF for a
// while. It used to: test 2 dragged half of it against a paint capped at the
// real constant, so lowering the real one made this spec read the cap instead
// of the drag and go red. Point 3 removed that cap outright — with the rows
// carried by the same transform as the spinner there was no collision left to
// bound — and the only use left was a drag MAGNITUDE (`PULL_COMMIT_PX * 3` in
// test 1), which reds only if the real constant grows past 240 and says
// nothing at all if it shrinks.
//
// #1669 gives it a witness again, of a different kind. The commit distance is
// now the SEAM of the travel curve: below it the finger goes through 1:1,
// above it the offset is damped. Test 3 reads that the rows moved MORE than
// this number and LESS than the finger's own 400, so a copy that drifted above
// the real constant's damped offset reds — a genuine reading, not a magnitude.
// It is still one-sided (drifting DOWN stays quiet), which is why the static
// witness below remains the pin that matters.
//
// What pins it is #1646's static witness, which needs no testnet:
// src/__tests__/e2eConstantMirrors.test.ts imports the production constant and
// compares it to this literal. #1671 measured this distance on a phone and
// doubled it, and that pin is exactly what caught this copy sitting at the old
// 80 — a red naming this line, not a silent drift. What the pin no longer
// watches is a THIRD module: production stopped being `SWIPE_MIN_PX * 2` in the
// same change, deliberately, so moving the swipe floor no longer moves the
// commit distance and there is nothing left here to be moved from behind.
const PULL_COMMIT_PX = 160;

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

// A row to measure against, MADE rather than waited for.
//
// 🔴 MEASURED, not reasoned from the source: with only this spec in the run the
// directory renders "0 channels", "never", and an EMPTY `<ul>` — the Playwright
// failure snapshot says exactly that. No capture has ever happened on the
// network, and `openDirectory` names that state in its own comment ("the pane's
// own mount GET is what produces that page, EMPTY SNAPSHOT OR NOT"). So no
// timeout and no polling can help: waiting longer for a row that nothing is
// producing waits forever.
//
// What made this pass in CI at all is shard ORDER — the directory snapshot is
// SERVER-side and per-network, so any earlier spec that captured one leaves it
// populated for everything after. That is the flake, and the cure is to stop
// depending on a neighbour: force the capture here, through the same door
// `channel-directory.spec.ts` uses.
//
// The 15s is that spec's number and it is a ROUND-TRIP BUDGET, not a guess at a
// slow machine: LIST → the session's 322 capture → 323 → progress ping → cic's
// re-GET. Settling the button back to "Refresh" afterwards restores the quiet
// pre-state `openDirectory` establishes, so a "Refreshing…" seen later is the
// pull's doing and not this capture still in flight.
async function seedOneRow(page: Page, refresh: Locator): Promise<void> {
  await refresh.click();
  await expect(page.locator(".directory-row-join").first()).toBeVisible({ timeout: 15_000 });
  await expect(refresh).toHaveText("Refresh", { timeout: 15_000 });
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
      // #1658 point 3 — the TRACK, not the slot. The travel is painted on the
      // element that carries both the spinner and the rows; the slot's own
      // computed transform is the constant parked `translateY(-100%)` and
      // would read the same at every distance.
      const track = el.querySelector<HTMLElement>(".directory-pull-track");
      if (track === null) throw new Error("no pull track inside the directory list");
      // The vertical component of the computed matrix — what the browser
      // actually resolved, not the inline string we wrote.
      const verticalOffset = (): number =>
        new DOMMatrixReadOnly(getComputedStyle(track).transform).f;
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

// The whole of the paint, which since #1658 point 3 spans TWO elements on two
// axes: the TRACK carries the travel, the SLOT carries the opacity ramp.
// Empty strings mean the pane handed both back to the stylesheet.
//
// `slotTransform` is read as well and must ALWAYS be empty, at rest and
// mid-pull alike: the parked `translateY(-100%)` lives in default.css and the
// pane writes no transform on that element at any point. A non-empty reading
// is the #1438 trap coming back — an inline transform replacing the rule.
async function pullInlinePaint(
  list: Locator,
): Promise<{ trackTransform: string; slotOpacity: string; slotTransform: string }> {
  return list.evaluate((el) => {
    const track = el.querySelector<HTMLElement>(".directory-pull-track");
    if (track === null) throw new Error("no pull track inside the directory list");
    const slot = el.querySelector<HTMLElement>(".directory-pull-slot");
    if (slot === null) throw new Error("no pull slot inside the directory list");
    return {
      trackTransform: track.style.transform,
      slotOpacity: slot.style.opacity,
      slotTransform: slot.style.transform,
    };
  });
}

// One pull driven far past the commit point, at a chosen root font size,
// measured with the finger still down — the only moment the paint exists.
//
// The font size is written as the CSS var on <html>, which is exactly what
// `lib/fontSize.ts`'s `writeCssVar` does; set here rather than imported to
// keep src VALUES out of the e2e runtime graph, the same call as
// LIST_WINDOW_NAME above. The gesture ends on a touchCANCEL, not a touchend:
// cancel puts the slot back without committing, so measuring three sizes in
// one test does not spend three upstream LIST captures.
//
// `transform` comes back as the INLINE string, not a computed one: setting an
// unparseable value on a CSSStyleDeclaration is a silent no-op, so an engine
// that refused the declaration leaves this empty while the geometry merely
// reads "parked". Empty means refused; non-empty with a moved row means
// accepted and resolved.
const FULL_TRAVEL_PX = 400;

async function measureAtFullTravel(
  list: Locator,
  rootFontSize: string,
): Promise<{
  slotBottom: number;
  rowTop: number;
  listTop: number;
  slotHeight: number;
  transform: string;
}> {
  return list.evaluate(
    (el, opts) => {
      document.documentElement.style.setProperty("--font-size", opts.size);
      const slot = el.querySelector<HTMLElement>(".directory-pull-slot");
      if (slot === null) throw new Error("no pull slot inside the directory list");
      const track = el.querySelector<HTMLElement>(".directory-pull-track");
      if (track === null) throw new Error("no pull track inside the directory list");
      const row = el.querySelector<HTMLElement>(".directory-row-join");
      if (row === null) throw new Error("no directory row to measure the gap against");
      const at = (y: number): Touch =>
        new Touch({ identifier: 1, target: el, clientX: 200, clientY: y });
      const fire = (type: string, touch: Touch): void => {
        const points = type === "touchend" || type === "touchcancel" ? [] : [touch];
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
      el.scrollTop = 0;
      const y0 = 200;
      fire("touchstart", at(y0));
      fire("touchmove", at(y0 + 20));
      // Far past every distance in play — the commit point (160 since #1671)
      // and the slot at its largest (50). Whatever bounds the pull, it is not
      // the finger
      // running out. Since #1669 the reading below is NOT the finger's own
      // distance any more: the travel past the commit point is damped towards
      // a ceiling, so what comes back is a damped offset and the test asserts
      // it as one.
      fire("touchmove", at(y0 + opts.travel));
      const slotRect = slot.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const listRect = el.getBoundingClientRect();
      const transform = track.style.transform;
      fire("touchcancel", at(y0 + opts.travel));
      return {
        slotBottom: slotRect.bottom,
        rowTop: rowRect.top,
        listTop: listRect.top,
        slotHeight: slotRect.height,
        transform,
      };
    },
    { size: rootFontSize, travel: FULL_TRAVEL_PX },
  );
}

// The three root font sizes that bracket cic's range, and the slot height each
// produces. From lib/fontSize.ts's SIZES; the slot is `2.5rem`.
const FONT_SIZES = [
  ["12px", 30],
  ["14px", 35],
  ["20px", 50],
] as const;

// One paint applied DIRECTLY to the track, with no gesture in front of it, and
// the geometry the engine resolves it to. This is how the @webkit arm reaches
// the invariant at all: `new Touch(...)` is an `Illegal constructor` on
// Playwright's WebKit (measured, and issue230's header records the same for
// its own drag), so the production gesture cannot be synthesized there and the
// question "does THIS ENGINE resolve THIS GEOMETRY" has to be asked directly.
//
// It returns both halves of the invariant because they fail differently: `gap`
// is how far the ROWS moved (the engine applied the ancestor translate at all)
// and `overlap` is slot-bottom minus row-top (the engine composed that
// translate with the slot's own PERCENTAGE offset against the right box).
//
// 🔴 `pull-gesture-active` is not decoration. The track carries
// `transition: transform 150ms ease-out`, which production drops through that
// exact class for the length of a claimed pull. Without it every reading here
// is the ease at t=0 — MEASURED on the cap this test used to check: all eight
// candidate declarations, on BOTH engines, read as the parked position and the
// table looked like a total engine failure. Killing the transition the way
// production kills it is what turned that into a table with distinct answers.
async function resolveTrackTravel(
  list: Locator,
  rootFontSize: string,
  declaration: string,
): Promise<{ gap: number; overlap: number; slotHeight: number; computed: string }> {
  return list.evaluate(
    (el, opts) => {
      document.documentElement.style.setProperty("--font-size", opts.rootFontSize);
      const slot = el.querySelector<HTMLElement>(".directory-pull-slot");
      if (slot === null) throw new Error("no pull slot inside the directory list");
      const track = el.querySelector<HTMLElement>(".directory-pull-track");
      if (track === null) throw new Error("no pull track inside the directory list");
      const row = el.querySelector<HTMLElement>(".directory-row-join");
      if (row === null) throw new Error("no directory row to measure the gap against");
      el.classList.add("pull-gesture-active");
      track.style.transform = opts.declaration;
      const computed = getComputedStyle(track).transform;
      const slotRect = slot.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const gap = rowRect.top - el.getBoundingClientRect().top;
      track.style.removeProperty("transform");
      el.classList.remove("pull-gesture-active");
      return { gap, overlap: slotRect.bottom - rowRect.top, slotHeight: slotRect.height, computed };
    },
    { rootFontSize, declaration },
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

  // #1658 — and the committing release cleaned up after itself. The binder
  // reports a commit through `onCommit` and returns WITHOUT calling
  // `onRelease`, so a pane that hangs its cleanup off `onRelease` alone leaves
  // the paint where the finger left it, forever. The two assertions above are
  // the pre-state that makes this one evidence: the gesture really did take
  // the committing path.
  //
  // Point 3 spread the paint over two elements, so this checks both — and the
  // stranded-track case is the worse of the two: not a hung spinner but the
  // whole channel list sitting a hundred-odd pixels down the pane (#1669's
  // ceiling bounds how far, and does not make it any less stranded).
  // `slotTransform` is the
  // third reading and it must be empty here for a different reason: the pane
  // never writes one at all, at any point in the gesture.
  expect(await pullInlinePaint(list)).toEqual({
    trackTransform: "",
    slotOpacity: "",
    slotTransform: "",
  });
});

test("#1445 — mid-pull the track moves by exactly the finger's travel (chromium)", async ({
  page,
}) => {
  test.slow();
  const { list } = await openDirectory(page, "sidebar");

  // 20px. It used to be half the commit distance, then a literal 20 chosen to
  // stay under the #1658 slot-height cap at every font size. Point 3 removed
  // that cap, and the literal survived only because it kept this test's
  // arithmetic a small, obvious number.
  //
  // 🔴 #1669 makes it load-bearing again, for a THIRD reason: 20 is below the
  // commit point, which is where the travel is still 1:1. This test's title —
  // "by EXACTLY the finger's travel" — is now true only in that stretch, and it
  // is the browser-side witness that #1669 left the deciding stretch alone.
  // Raise this past `PULL_COMMIT_PX` and the equality is simply false.
  //
  // The track rests at NO transform, so this reading is the whole of the
  // paint: `after - before` is the finger's travel or the paint is wrong. The
  // parked offset that used to complicate it belongs to the slot and stays in
  // the stylesheet, on an element this no longer reads.
  const travel = 20;
  const { before, after } = await pullList(list, travel, false);

  expect(after - before).toBeCloseTo(travel, 0);
});

test("#1658 — the rows follow the finger and the slot rides above them, at every font size (chromium)", async ({
  page,
}) => {
  test.slow();
  const { list, refresh } = await openDirectory(page, "sidebar");
  // A row must EXIST to measure the gap against it, and nothing else in this
  // run produces one — see `seedOneRow`.
  await seedOneRow(page, refresh);

  // S, M (the default) and XXL — three DIFFERENT slot heights, and that is the
  // point: the invariant is an identity only if it survives all three. A
  // spinner placed by any arithmetic on the slot's height instead of by being
  // carried in the same box would read three different overlaps here.
  for (const [size, expectedSlotHeight] of FONT_SIZES) {
    const { slotBottom, rowTop, listTop, slotHeight, transform } = await measureAtFullTravel(
      list,
      size,
    );

    // Known-answer control, and without it this whole test is theatre: if the
    // `--font-size` write did not take, all three iterations would measure the
    // same slot and three identical readings would look like proof.
    expect(slotHeight, `slot height at --font-size: ${size}`).toBeCloseTo(expectedSlotHeight, 0);
    // Read this one FIRST when the rest goes red: an EMPTY inline transform is
    // the engine refusing the declaration outright (the CSSOM setter drops an
    // unparseable value silently), which is a different defect and a different
    // fix from an engine that accepted it and resolved it somewhere else.
    expect(transform, `inline transform at --font-size: ${size}`).not.toBe("");

    // POINT 3 ITSELF, and the assertion this file did not have: the CONTENT
    // moved. Before point 3 this read 0 at every size — the rows never moved
    // at all, which is the defect vjt kept seeing.
    //
    // #1669 turned the reading from an equality into the two inequalities that
    // bracket it, because the equality was `toBeCloseTo(400, 0)`: the finger's
    // own distance, going through whole, which is exactly the unbounded 1:1
    // drag this issue removes. What survives is the pair that says the same
    // thing without naming a feel number the pane no longer promises:
    const moved = rowTop - listTop;
    // Still FOLLOWING, well past the commit point — not the hard cap #1658
    // deleted, and not a pane that stopped painting.
    expect(moved, `rows followed the finger at --font-size: ${size}`).toBeGreaterThan(
      PULL_COMMIT_PX,
    );
    // And DAMPED: 400px of finger bought strictly less than 400px of list.
    // This is #1669's visible outcome, read off real layout in a real engine.
    expect(moved, `travel damped at --font-size: ${size}`).toBeLessThan(FULL_TRAVEL_PX);

    // THE STRONG INVARIANT. The slot's bottom edge lands ON the first row's
    // top edge — the spinner sits in the space the rows opened, touching them
    // and never over them. A positive number here is the spinner back on top
    // of the row, which is exactly the 1.3.0 defect.
    expect(slotBottom - rowTop, `slot/row overlap at --font-size: ${size}`).toBeCloseTo(0, 0);
    expect(slotBottom, `slot bottom must not pass the first row at ${size}`).toBeLessThanOrEqual(
      rowTop + 0.5,
    );
  }
});

test("@webkit #1658 — WebKit carries the rows AND keeps the slot off them (iPhone 15)", async ({
  page,
}) => {
  test.slow();
  // The mobile door, for the reason `openDirectory` states: the $list window
  // has no BottomBar tab, so `selectChannel` cannot reach it on this layout.
  const { list, refresh } = await openDirectory(page, "list-command");
  await seedOneRow(page, refresh);

  for (const [size, expectedSlotHeight] of FONT_SIZES) {
    // The ARITHMETIC CONTROL, and it runs first because everything below is
    // worthless without it. A small plain-px translate on the track must move
    // the first row by exactly that much. If this reads 0 instead, the harness
    // is measuring a transition or a stale layout and the reading beneath it
    // means nothing — which is the exact hole the first draft of this test
    // fell into, back when it measured a cap.
    const control = await resolveTrackTravel(list, size, "translateY(20px)");
    expect(control.slotHeight, `slot height at --font-size: ${size}`).toBeCloseTo(
      expectedSlotHeight,
      0,
    );
    expect(control.gap, `plain-px control at --font-size: ${size}`).toBeCloseTo(20, 0);

    // A declaration of the shape the pane writes deep into the pull, resolved
    // by the engine the bug was reported from — and the two halves fail
    // differently.
    //
    // `gap` is the plain half: WebKit applied the ancestor translate, so the
    // rows moved. `overlap` is the half chromium cannot answer: the slot's own
    // parked offset is a PERCENTAGE (`translateY(-100%)`) that resolves against
    // the SLOT's box, not the track's, and the invariant is an identity only if
    // the engine composes those two correctly. An engine that resolved the
    // percentage against the wrong box puts the spinner straight back on top of
    // the first row — the 1.3.0 defect, on the only engine vjt has, with every
    // chromium gate in this repo green. That is the empty-green class.
    //
    // Coupled BY HAND to `pulledTransform` in src/DirectoryPane.tsx: this is an
    // ENGINE contract, so it names the declaration rather than importing it,
    // exactly as the CSS-contract test below names `pan-y`. Change the travel's
    // FORM in the pane and this string must move with it — the chromium arm
    // above is what keeps the pane honest about producing it.
    //
    // #1669 changed that form in a way worth probing: the damped offset is
    // FRACTIONAL (`pulledOffset` divides), where every declaration this file
    // ever measured was a whole number. An engine that rounds or refuses a
    // sub-pixel translate would put the spinner back over the first row by half
    // a pixel and nothing else here would see it — so the probe is fractional
    // now, and deliberately.
    //
    // The VALUE is not a mirror of the ceiling constant and must not become
    // one: it is a representative translate from the pane's range, chosen so
    // this stays a pure engine question (does WebKit compose an ancestor px
    // translate with a descendant percentage) rather than a second, unpinnable
    // copy of a feel number vjt is expected to retune. The composition is
    // linear, so any value answers it.
    const full = await resolveTrackTravel(list, size, "translateY(152.5px)");
    expect(full.gap, `rows carried at --font-size: ${size} (${full.computed})`).toBeCloseTo(
      152.5,
      1,
    );
    expect(full.overlap, `slot/row overlap at --font-size: ${size}`).toBeCloseTo(0, 0);
  }
});

test("@webkit #1445 — the directory list refuses its own overscroll and declares its one pan axis (iPhone 15)", async ({
  page,
}) => {
  test.slow();
  const { list, refresh } = await openDirectory(page, "list-command");
  // NOT this test's defect, but the same latent one: it hit-tests a row and
  // has only ever found one because some earlier spec in the shard left a
  // server-side snapshot behind. Seeded here too — leaving one call site
  // order-dependent while curing its two neighbours would put two patterns in
  // one file.
  await seedOneRow(page, refresh);

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
