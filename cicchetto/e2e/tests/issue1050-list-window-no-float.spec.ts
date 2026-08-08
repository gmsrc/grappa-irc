// @webkit — #1050. On the mobile /list window the floating ☰ sat on top of the
// directory pane's own close ✕, and the ☰ won: the tap that should leave the
// directory opened the rail instead.
//
// Two independent controls, one corner. `.directory-close` is the LAST child of
// `.directory-pane-header` (#125), so it lands top-right in normal flow; since
// #985 `.shell-chrome` is a zero-height row whose lone ☰ overflows into that
// same corner at `z-index: 41`. #1039 is what brought them together — it
// retargeted the float's margin onto the topic bar's `--pane-chrome-inset-*`
// tokens, moving the glyph off the very corner and straight onto the ✕. The
// admin window paid this first and was given an inline mount in its own header;
// the owner's call for the directory is the opposite one, that this window does
// not want the rail at all, so the whole row goes.
//
// WHY A NEW SPEC. Nothing existing covers it: all seven specs that assert
// `shell-chrome-rail-opener` (issue1039-hamburger-corner,
// issue71-inc2-mobile-rail-openers, issue985-mobile-floating-opener,
// ux-4-z-cluster-journey, ux-5-a-hamburger-dedupe, ux-5-bm-mobile-hamburger,
// ux-5-bt-narrow-chrome-compression) run on a channel, query, home or admin
// window. The suppression therefore breaks no assertion — and without this one
// it would come back unnoticed.
//
// WHY THE OUTCOME IS "THE ✕ CLOSES", not "the ✕ is visible. Visibility is
// exactly what the bug already satisfied: the float painted OVER a perfectly
// visible button. Only the click distinguishes the two.
//
// Mobile-only shape — `ShellChrome` has a single mount, inside Shell's
// `isMobile()` branch — so this runs on webkit-iphone-15 alone via @webkit; the
// chromium project grepInverts the tag.
//
// Parity per `feedback_e2e_user_class_parity_matrix`: a UI shape contract, no
// subject-shaped branch. The registered seed suffices.

import { loginAs, openRailMenu, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(90_000);

test("@webkit #1050 — the /list window drops the floating ☰, and its ✕ actually closes the directory", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Reach the directory the way a phone does: the rail's rooms button. This
  // also proves the rail is still reachable from the window we START on — the
  // suppression is scoped to `list`, not a general retreat from bucket L.
  await openRailMenu(page);
  await page.getByTestId("mobile-panel-list").tap();

  const pane = page.locator(".directory-pane");
  await expect(pane).toBeVisible({ timeout: 15_000 });

  // THE SUPPRESSION. Whole row, not a hidden glyph: a `display: none` on the
  // button would leave `.shell-chrome` in the tree carrying its `z-index: 41`
  // and its zero-height box over the pane header, so the row's ABSENCE is the
  // thing worth asserting.
  await expect(page.getByTestId("shell-chrome")).toHaveCount(0);
  await expect(page.getByTestId("shell-chrome-rail-opener")).toHaveCount(0);
  await expect(page.locator(".shell-chrome")).toHaveCount(0);

  // THE MECHANISM, measured rather than argued: the element under the finger at
  // the ✕'s own centre IS the ✕. Pre-fix this resolved to the floated ☰.
  const closeBtn = pane.locator(".directory-close");
  await expect(closeBtn).toBeVisible();
  const hit = await closeBtn.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return top === el || el.contains(top);
  });
  expect(hit, "#1050 — nothing may paint over the directory's close ✕").toBe(true);

  // THE OUTCOME. Not "the ✕ is visible" — the bug satisfied that. The tap has
  // to LEAVE the directory. Playwright's hit-target check would already fail
  // here if something intercepted the pointer, and the pane going away is the
  // user-visible half.
  await closeBtn.tap();
  await expect(pane).toHaveCount(0, { timeout: 10_000 });

  // …and #125's contract holds: closing restores the previous window rather
  // than dropping the operator on a blank pane. Back on a channel, the ☰ is
  // hosted in the TopicBar again, which is also the proof that the row's
  // absence above was scoped to `list` and not a global regression.
  await expect(page.locator(".topic-bar")).toHaveCount(1, { timeout: 10_000 });
});
