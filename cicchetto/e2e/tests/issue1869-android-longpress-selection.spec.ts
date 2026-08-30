// #1869 — one long-press on a message row opened TWO menus on Android:
// Chrome's native selection toolbar over a native selection of the row, plus
// cic's own message menu.
//
// The selection/callout policy was gated on `html.is-ios`, which
// `lib/platform.ts` applies only when `isIos()`, so Android received none of
// it. But re-parenting the block is NOT the fix, and this spec exists because
// that distinction is invisible in the source: `-webkit-touch-callout` is
// WebKit-only. On iOS the policy is a PAIR — `callout: none` suppresses the
// platform's long-press UI, `user-select: text` keeps the row selectable for
// `Select…`. Blink has only the second half, and there `user-select: text` IS
// the native long-press selection.
//
// So on a coarse pointer the row is `none` STANDING and `text` under #1067's
// `is-selecting` latch. This runs on `chromium-pixel-touch` because that is the
// project whose engine (Blink) and pointer (coarse) both match the reported
// device — `webkit-iphone-15` cannot see this class of defect at all, since the
// property that masks it there does not exist here.
//
// ⚠️ WIRING + SERIALISATION ONLY — NOT PROOF THE TOOLBAR IS GONE. ⚠️
// Playwright renders no platform selection UI, so nothing here can assert that
// Chrome's toolbar does not appear; that half was verified by hand on an
// Android 17 emulator (Chrome 151) with an OS-level `adb input swipe`, and the
// screenshots are on the PR. What IS deterministic in CI is the cascade the
// engine is asked to apply, and the selection TEXT that cascade produces —
// which is the half that would silently rot. See docs/DESIGN_NOTES.md
// 2026-08-30 (#1869) and the sibling limitation notes in
// issue250-android-nick-select.spec.ts.

import type { Page } from "@playwright/test";
import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// Date.now() suffix (house pattern): the e2e sqlite scrollback persists across
// re-runs against a KEEP_STACK=1 stack, and a static body would match two rows
// on the second run and trip Playwright strict mode.
const MESSAGE_BODY = `1869 long-press target ${Date.now()}`;

const SELECTING_CLASS = "is-selecting";

async function seedRow(page: Page) {
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await composeSend(page, MESSAGE_BODY);
  const row = scrollbackLine(page, "privmsg", MESSAGE_BODY);
  await expect(row).toBeVisible({ timeout: 5_000 });
  return row;
}

function readCascade(page: Page) {
  return page.evaluate(() => {
    const scrollback = document.querySelector(".scrollback");
    const nick = document.querySelector(".scrollback .nick-clickable");
    if (!scrollback || !nick) return null;
    return {
      coarse: matchMedia("(pointer: coarse)").matches,
      isIos: document.documentElement.classList.contains("is-ios"),
      html: getComputedStyle(document.documentElement).userSelect,
      scrollback: getComputedStyle(scrollback).userSelect,
      nick: getComputedStyle(nick).userSelect,
    };
  });
}

test("@touch #1869 — the row is unselectable standing and selectable under the latch", async ({
  page,
}) => {
  await seedRow(page);

  const standing = await readCascade(page);
  expect(standing).not.toBeNull();

  // The premise. If this project ever stopped reporting a coarse pointer the
  // assertions below would pass vacuously against the pre-fix sheet, so it is
  // asserted rather than assumed — and `isIos` false is what makes this a test
  // of the POINTER gate and not of the platform class.
  expect(standing?.coarse).toBe(true);
  expect(standing?.isIos).toBe(false);

  expect(standing?.html).toBe("none");
  // THE defect, stated as a value: `text` here is the native long-press
  // selection on Blink, i.e. the second menu.
  expect(standing?.scrollback).toBe("none");
  // The #250 token matches its element DIRECTLY and so beats the inherited
  // `none` — left to inherit, the bug survived on a press that landed on a nick.
  expect(standing?.nick).toBe("none");

  await page.evaluate((cls) => document.documentElement.classList.add(cls), SELECTING_CLASS);

  const latched = await readCascade(page);
  // Both lift together, or `Select…` yields a row without its author.
  expect(latched?.scrollback).toBe("text");
  expect(latched?.nick).toBe("text");
});

// The latch is load-bearing rather than belt-and-braces, and this is the half a
// cascade assertion cannot show: Blink omits `user-select: none` subtrees from
// a selection's TEXT. Without the lift, `Select…` installs a range over the row
// and gets a fragment back — measured by hand as `"<peluche>"` against the full
// `"14:24:42 <@vjt> ok quindi…"`. Asserting the serialisation pins the reason
// the latch has to carry `user-select` and not just the callout.
test("@touch #1869 — a range over the row serialises the whole row only when latched", async ({
  page,
}) => {
  const row = await seedRow(page);

  const select = () =>
    row.evaluate((el) => {
      const sel = window.getSelection();
      if (!sel) return "";
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.addRange(range);
      return sel.toString();
    });

  const unlatched = await select();
  expect(unlatched).not.toContain(MESSAGE_BODY);

  await page.evaluate((cls) => document.documentElement.classList.add(cls), SELECTING_CLASS);

  const latched = await select();
  expect(latched).toContain(MESSAGE_BODY);
  // #250's guarantee, delivered by the new route: the author rides inside the
  // selection because Select… takes the whole row, not because the token
  // carries a standing re-enable.
  expect(latched).toContain(specNick());
});
