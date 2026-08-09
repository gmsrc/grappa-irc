// #173 — after a compose HISTORY RECALL the caret must be VISIBLE. Recall
// (swipe up/down OR keydown ArrowUp/ArrowDown) swaps the controlled textarea
// `value` to a recalled line; the pure compose store (recallPrev/recallNext)
// only mutates the draft — it never touches the caret or the native scroll.
// So on a recalled line that OVERFLOWS the rows=1 textarea, the browser leaves
// scrollTop at 0 with the end-caret below the fold: you recall a long line and
// can't see where you're typing (the dogfood symptom, most reliably reached by
// a down-gesture, which by the #123 boundary mapping fires only while the
// textarea is atTop === scrollTop 0).
//
// The fix is the GENERAL rule "after any recall the caret is visible", routed
// through ONE ComposeBox helper from BOTH entry points: place the caret
// deterministically at the END of the recalled line (irssi history semantics)
// and scroll the textarea so that caret is in view. It is NOT a gesture-only
// band-aid — the keydown path shares the exact defect and the exact fix.
//
// GATE REALITY (feedback_playwright_webkit_not_ios_scroll): webkit playwright
// can't reproduce real iOS touch/scroll physics, so this is NOT the device
// gate — vjt dogfoods post-ship. What it CAN prove deterministically in
// chromium is the scroll-to-cursor GEOMETRY: after a recall the end-caret's
// line sits within [scrollTop, scrollTop+clientHeight]. The keydown case needs
// no touch synthesis at all (a real ArrowUp keydown), so it is the load-bearing
// deterministic guard; the gesture case reuses the #123 synthSwipe to prove the
// second call site is wired through the same helper. No hollow green: reverting
// the caret-scroll turns both red (scrollTop stays 0).

import {
  composeCaretGeometry,
  composeSend,
  composeTextarea,
  expectEndCaretVisible,
  loginAs,
  selectChannel,
  synthSwipe,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// A recalled line long enough to overflow the rows=1 textarea several times
// over, so an end-caret left at scrollTop 0 is unambiguously off-screen.
const LONG_BODY = Array.from({ length: 12 }, (_, i) => `recall line ${i}`).join("\n");

// #1105 lifted `caretGeometry` + `expectEndCaretVisible` into the shared
// fixture: the reply quote is a second door onto the very same "end-caret must
// be visible" rule, and two copies of the oracle would be the test-side twin
// of the production duplication that let #1105 through. LONG_BODY is 12 lines,
// so 40px of required overflow is a wide margin here.
const MIN_OVERFLOW_PX = 40;

test("issue173 — keydown ArrowUp recall scrolls the end-caret into view", async ({ page }) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Seed history with a long multi-line message (one history entry; the
  // original draft, newlines intact, is what recallPrev pulls back).
  await composeSend(page, LONG_BODY);

  const ta = composeTextarea(page);
  await expect(ta).toHaveValue("");

  // Empty draft → caret on the first line → ArrowUp walks history (recallPrev).
  // A real keydown, no touch synthesis: the deterministic, physics-free guard.
  await ta.focus();
  await ta.press("ArrowUp");
  await expect(ta).toHaveValue(LONG_BODY, { timeout: 2_000 });

  expectEndCaretVisible(await composeCaretGeometry(page), MIN_OVERFLOW_PX);
});

test("issue173 — gesture (fast up-flick) recall scrolls the end-caret into view", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  await composeSend(page, LONG_BODY);

  const ta = composeTextarea(page);
  await expect(ta).toHaveValue("");

  // #178: gesture recall now fires ONLY on a NON-empty draft (an empty
  // compose + flick is scroll/look-at-history, not recall). Seed a short
  // in-progress draft so the fast up-flick is allowed to recall; a short
  // non-overflowing draft is still at both scroll edges, so the flick
  // still claims + classifies "up" → recallPrev (which stashes the draft
  // and pulls LONG_BODY). Proves the touchend entry point routes through
  // the same caret-scroll helper as keydown.
  await ta.fill("wip");
  await expect(ta).toHaveValue("wip");
  await synthSwipe(page, { startX: 100, startY: 300, endX: 100, endY: 220, slowMs: 0 });
  await expect(ta).toHaveValue(LONG_BODY, { timeout: 2_000 });

  expectEndCaretVisible(await composeCaretGeometry(page), MIN_OVERFLOW_PX);
});
