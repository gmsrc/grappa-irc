// issue 1831 — a modal opened from the compose line must survive the TAP that
// opened it.
//
// The claim under test is a PLATFORM one, which is why it cannot live in
// jsdom. `banlistCommand` has no `await` ahead of `openBanlistModal`, so the
// scrim is in the DOM before the browser dispatches the tap's compat mouse
// events. Those are synthesised after the touch ends and hit-tested against
// the layout as it stands THEN — so the click can land on a backdrop that did
// not exist when the finger went down, and a backdrop dismissing on any click
// dismisses in the gesture that opened it. The unit tests in
// BanlistModal.test.tsx DISPATCH that sequence; only an engine can be asked
// whether it PRODUCES it.
//
// It does. Measured here on chromium + touch, recording every event at the
// document in capture phase while tapping send with `/banlist` typed, against
// the PRE-CURE code:
//
//     pointerdown -> polygon              (the send button's arrow glyph)
//     touchstart  -> polygon
//     pointerup   -> polygon
//     mousedown   -> div.modal-backdrop   <- the scrim, mounted during pointerup
//     mouseup     -> div.modal-backdrop
//     click       -> div.modal-backdrop
//     …and the banlist modal count was 0.
//
// The press lands on the button and the click lands on the SCRIM. That is the
// defect, entire, on a real engine.
//
// 🔴 WHY THIS RUNS ON `chromium-pixel-touch` AND NOT ON `webkit-iphone-15`,
// which was tried first and is the wrong instrument. The same probe there
// records `pointerdown / touchstart / pointerup` and STOPS: no touchend, no
// mousedown, no mouseup, NO CLICK. Playwright's injected touch produces no
// compat mouse events on that engine at all, so a spec about what a
// synthesised click hits is unanswerable — and, measured, the pre-cure code
// went GREEN there on both arms. Do not "simplify" this back onto the webkit
// project: it passes without touching the defect.
//
// The pair below is deliberate, and the control is the load-bearing half:
//
//   * ENTER — the gesture the whole suite already uses (`composeSend` presses
//     Enter). A keydown synthesises no click, so this arm is green on both
//     sides of the cure; its job is to fail loudly if the STACK broke rather
//     than the mechanism.
//   * TAP — the same command through the send button. Red before the cure,
//     green after. Everything but the GESTURE is held fixed: same command,
//     same window, same bundle, same engine.
//
// That is also the local evidence bearing on the reporter's tab-vs-PWA
// asymmetry, which has never been shown to hold the gesture fixed. Here the
// gesture ALONE splits the outcome.
//
// PLATFORM LIMIT, stated rather than buried: the reported device is Android
// FIREFOX and this is Blink. Playwright's firefox does not support touch
// emulation, so Gecko is not reachable from this harness. This measures that
// an engine does it, and which gesture does it — not that Gecko does.

import { composeSend, composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("@touch issue 1831 — /banlist sent with Enter opens the ban list (gesture control)", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  await composeSend(page, "/banlist");

  // The modal itself is the assertion — its CONTENTS are not this spec's
  // business (#536 already pins that a queried ban renders). An empty or
  // still-loading list is a perfectly good open modal.
  await expect(page.getByTestId("banlist-modal")).toBeVisible({ timeout: 15_000 });
});

test("@touch issue 1831 — /banlist sent by TAPPING send opens the ban list and it stays", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const ta = composeTextarea(page);
  await expect(ta).toBeVisible();

  // Tap, never click. A `click()` synthesises a mouse sequence whose
  // `mousedown` PRECEDES the modal mount, so the click resolves to the common
  // ancestor of button and scrim instead of to the scrim — the case that never
  // reproduced, and the reason a mouse never saw this bug.
  await ta.tap();
  await ta.pressSequentially("/banlist", { delay: 20 });
  await page.getByRole("button", { name: /send message/i }).tap();

  // Dispatch signal first, so a red below is a MODAL failure and not a submit
  // that never happened.
  await expect(ta).toHaveValue("", { timeout: 5_000 });

  const modal = page.getByTestId("banlist-modal");
  await expect(modal).toBeVisible({ timeout: 15_000 });

  // …and still there once the gesture has fully settled. The defect dismissed
  // it within the same tap, so `toBeVisible` alone already catches it; this
  // second look separates "opened and stayed" from "the assertion won a race".
  await page.waitForTimeout(1_000);
  await expect(modal).toBeVisible();
});
