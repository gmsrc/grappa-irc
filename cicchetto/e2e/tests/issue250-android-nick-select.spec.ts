// #250 — nick excluded from touch-selection on Android (follow-up to #179).
//
// On real Android (Chrome), a drag text-selection that starts at the
// timestamp and crosses the row EXCLUDES the author nick; iOS + desktop
// include it. The nick renders as `<button class="scrollback-sender
// nick-clickable">` (ScrollbackPane.tsx senderSpan) — an INTERACTIVE
// inline element. Android's native touch-selection engine skips an
// interactive `<button>`, so the nick token falls outside the captured
// range while timestamp + body stay in. Desktop mouse-selection keeps it
// (no touch-selection engine), and iOS keeps it via the
// `html.is-ios .scrollback { user-select: text }` cascade.
//
// Root cause: that selectable-text re-enable was scoped to `html.is-ios`
// ONLY (default.css), and there is no `is-android` class — so on Android
// `.nick-clickable` computes to the default `user-select: auto` and the
// interactive button is skipped. The fix sets `user-select: text`
// UNCONDITIONALLY on `.nick-clickable`, so the button's own text stays
// inside a drag selection on EVERY platform (keeping its tap handler).
//
// ⚠️ WIRING CHECK ONLY — THIS DOES NOT PROVE THE REAL ANDROID FIX. ⚠️
// Playwright/DOM can only assert the CSS computed-style wiring. It CANNOT
// exercise Android's native touch-selection handles — the very code path
// that fails. A `Range`/mouse-drag serialization includes the whole row
// subtree on every engine regardless of the touch-selection UI: that is
// exactly the false-negative that got #179 mis-closed. A green run here
// is NOT device verification. Real proof needs a physical Android device
// or emulator exercising the native selection handles (vjt post-ship,
// batchable with #245). See docs/DESIGN_NOTES.md 2026-07-15.
//
// Why chromium is the RED→GREEN surface: the chromium project runs the
// NON-`is-ios` path, so asserting `.nick-clickable` computes to
// `user-select: text` THERE directly proves the rule is UNCONDITIONAL
// (not gated behind `html.is-ios`). On unfixed code the button inherits
// the default `auto` and the assertion fails.
//
// #1869 SUPERSEDED the TOUCH half of the above, and the header is left standing
// because the reasoning is still how we got here. What changed: giving the
// scrollback a standing `user-select: text` on touch is what let Chrome raise
// its own long-press selection over cic's message menu, because Blink does not
// implement the `-webkit-touch-callout: none` that suppresses it on WebKit. So
// on a coarse pointer the row — and this token with it — is `none` standing and
// `text` under `is-selecting`, and #250's "nick inside the selection" is
// delivered by `Select…` taking the whole row instead. The chromium test below
// is UNCHANGED and still owns the desktop case, which never enters that gate.

import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// Date.now() suffix (house pattern): the e2e sqlite scrollback persists
// across KEEP_STACK=1 re-runs — a static body double-matches on rerun and
// trips Playwright strict mode.
const MESSAGE_BODY = `android-nick-select target ${Date.now()}`;

// Read the computed selection policy off the freshly-rendered sender
// button of a message we just sent (specNick() is vjt's own nick), so
// the `.nick-clickable` under test is guaranteed present and attributed.
async function nickSelectionStyles(page: import("@playwright/test").Page) {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  await composeSend(page, MESSAGE_BODY);
  const row = scrollbackLine(page, "privmsg", MESSAGE_BODY);
  await expect(row).toBeVisible({ timeout: 5_000 });

  const nick = row.locator(".scrollback-sender.nick-clickable");
  await expect(nick).toContainText(specNick());

  return nick.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      htmlIsIos: document.documentElement.classList.contains("is-ios"),
      userSelect: cs.userSelect,
      webkitUserSelect: cs.webkitUserSelect,
    };
  });
}

test("#250 desktop — .nick-clickable is user-select:text unconditionally (not is-ios-gated)", async ({
  page,
}) => {
  const styles = await nickSelectionStyles(page);

  // chromium project → NON-is-ios path: proving `text` here proves the
  // rule is unconditional. Fails (inherited `auto`) on unfixed code.
  expect(styles.htmlIsIos).toBe(false);
  expect(styles.userSelect).toBe("text");
  expect(styles.webkitUserSelect).toBe("text");
});

// #1869 SUPERSEDED the touch half of #250, deliberately, and this guard moved
// with it. #250 gave the token its own `user-select: text` so it would ride
// inside a native drag-selection — written when Android had no `.scrollback`
// re-enable at all. #1869 ends that state: there is no native drag-selection on
// the scrollback any more, on any coarse pointer, because that selection WAS
// the second menu. The token therefore follows the row — `none` standing,
// `text` under the `is-selecting` latch — and #250's guarantee arrives instead
// through `Select…`, which takes the whole row (`selectNodeContents`) with the
// token inside it.
//
// The token is named explicitly in the CSS rather than left to inherit: it
// matches its element DIRECTLY and so beats the inherited `none`. Without that
// the bug survived in a narrower place — a long-press landing on a nick.
// This asserting `text` under the latch is what proves the token was not simply
// killed. The desktop sibling above is untouched: `pointer: fine` never enters
// the gate, so #250's mouse-drag case still holds unconditionally.
test("@webkit #250/#1869 iOS — .nick-clickable follows the row, unselectable until latched", async ({
  page,
}) => {
  const styles = await nickSelectionStyles(page);

  // WebKit reflects only the PREFIXED `webkitUserSelect` in computed
  // style (the unprefixed `userSelect` reads `undefined` there) — same
  // property the sibling text-selection-restored.spec asserts on iOS.
  expect(styles.htmlIsIos).toBe(true);
  expect(styles.webkitUserSelect).toBe("none");

  await page.evaluate(() => document.documentElement.classList.add("is-selecting"));

  const latched = await nickSelectionStyles(page);
  expect(latched.webkitUserSelect).toBe("text");
});
