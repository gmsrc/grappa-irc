// Dispatch-1 — text selection dead on desktop (keepKeyboard mousedown
// preventDefault) AND iOS (blanket -webkit-user-select: none). Full
// arc: docs/DESIGN_NOTES.md 2026-06-11.
//
// Test 1 (chromium) drives a real mouse drag over a scrollback row
// with compose focused — the exact gesture that was dead.
// Test 2 (@webkit, iPhone 15 emulation → is-ios class applies) asserts
// the CSS cascade outcome; real long-press selection isn't emulatable
// (same limitation class as feedback_playwright_webkit_not_ios_scroll),
// so computed style is the testable boundary. Real-device dogfood
// remains the final iOS verification.

import {
  composeSend,
  composeTextarea,
  loginAs,
  scrollbackLine,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// Date.now() suffix (house pattern, see ux-6-f spec): the e2e sqlite
// scrollback persists across suite re-runs against a KEEP_STACK=1
// stack — a static body would match two rows on the second run and
// trip Playwright strict mode.
const MESSAGE_BODY = `selection target: drag across me ${Date.now()}`;

test("desktop — scrollback text is selectable while compose has focus", async ({ page }) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  await composeSend(page, MESSAGE_BODY);
  const row = scrollbackLine(page, "privmsg", MESSAGE_BODY);
  await expect(row).toBeVisible({ timeout: 5_000 });

  // Pin the bug's precondition: compose focused (autofocus normally
  // guarantees this, but composeSend's submit path must not be relied
  // on to leave focus in place).
  await composeTextarea(page).focus();

  // Real selection drag across the message row — the gesture that the
  // keepKeyboard preventDefault killed.
  const box = await row.boundingBox();
  if (!box) throw new Error("scrollback row has no bounding box");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, y, { steps: 8 });
  await page.mouse.up();

  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected).toContain("drag across me");
});

// #1869 rewrote what this asserts, and the reason is worth stating: the
// scrollback is no longer selectable STANDING, it is selectable while the app
// says so. `-webkit-touch-callout` is WebKit-only, so on Blink the standing
// `user-select: text` this used to assert IS the platform's long-press
// selection — two menus for one gesture on Android. The row now defaults to
// `none` on any coarse pointer and #1067's `is-selecting` latch lifts it for
// the duration of one `Select…`.
//
// So the guard became two-state, which is strictly MORE than it checked
// before: standing `none`, latched `text`. Asserting only the first half would
// pass against a sheet that made the row permanently unselectable and broke
// Select… outright.
test("@webkit iOS — .scrollback is unselectable standing and selectable under the latch", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const read = () =>
    page.evaluate(() => {
      const scrollback = document.querySelector(".scrollback");
      if (!scrollback) return null;
      return {
        htmlIsIos: document.documentElement.classList.contains("is-ios"),
        htmlUserSelect: getComputedStyle(document.documentElement).webkitUserSelect,
        scrollbackUserSelect: getComputedStyle(scrollback).webkitUserSelect,
      };
    });

  const standing = await read();
  expect(standing).not.toBeNull();
  // iPhone 15 UA → applyIosClass marks the root. The blanket kill is unchanged;
  // what moved is where it is gated (`@media (pointer: coarse)`, #1869).
  expect(standing?.htmlIsIos).toBe(true);
  expect(standing?.htmlUserSelect).toBe("none");
  expect(standing?.scrollbackUserSelect).toBe("none");

  // The latch, applied the way `lib/messageMenu`'s Select… applies it.
  await page.evaluate(() => document.documentElement.classList.add("is-selecting"));

  const latched = await read();
  expect(latched?.scrollbackUserSelect).toBe("text");
});
