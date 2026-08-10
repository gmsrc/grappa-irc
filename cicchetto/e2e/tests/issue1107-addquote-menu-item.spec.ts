// #1107 — the message menu's `!addquote` item puts `!addquote ` plus the
// message text into the compose box, with the caret at the end and visible,
// and sends NOTHING. The command is for whatever bot is in the channel; cic
// only fills the box.
//
// Harness + limits:
//   * chromium, DESKTOP viewport, no `hasTouch` — the item is reached through
//     #1115's right-click door, which is the cheapest real opener. The touch
//     long-press reaches the SAME item list from the SAME store
//     (`openMessageMenu`), and duplicating it here would drift against
//     issue1067-swipe-reply-message-menu.spec.ts rather than add coverage.
//   * The caret arm reuses `expectEndCaretVisible`, the oracle #173 and #1105
//     already share. #1107's blocker was exactly that geometry: `!addquote `
//     plus a body overflows the rows=1 textarea nearly every time, and before
//     #1105/#1113 the operator would have been typing under the fold. A second
//     copy of the assertion would repeat, on the test side, the duplication
//     that let #1105 ship.
//   * "Sends nothing" is asserted as the ABSENCE of a second scrollback row
//     bearing the command, after the compose value has already settled — so
//     the wait is on a state that has arrived, not on a bare timeout.
import type { Page } from "@playwright/test";
import {
  composeCaretGeometry,
  composeSend,
  composeTextarea,
  expectEndCaretVisible,
  loginAs,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false });
test.setTimeout(90_000);

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Long enough to wrap the rows=1 compose box several times over once the
// command is prepended, so the caret arm's overflow is a wide margin rather
// than a coin toss on font metrics — and still one PRIVMSG, so the server-side
// split budget (#246) never turns it into two scrollback rows.
const FILLER =
  "una battuta abbastanza lunga da mandare a capo il compose piu' volte, " +
  "cosi' il caret finisce sotto la piega se nessuno lo va a ripescare";

// Unique per run: the e2e sqlite scrollback persists across KEEP_STACK=1
// re-runs, and a static string would match two rows on the second run and trip
// Playwright strict mode.
function uniqueBody(tag: string): string {
  return `issue1107 ${tag} ${Date.now()} ${FILLER}`;
}

const menu = (page: Page) => page.locator(".context-menu");
const menuItem = (page: Page, label: string) =>
  page.locator(".context-menu .context-menu-item", { hasText: label });
const rowWith = (page: Page, body: string) =>
  page.locator('[data-testid="scrollback-line"]', { hasText: body });

async function postMessage(page: Page, body: string): Promise<void> {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await composeSend(page, body);
  await expect(rowWith(page, body)).toBeVisible({ timeout: 5_000 });
}

// Right-click at mid-width of the row's OWN measured box. Measured rather than
// a pixel constant because the pane's width depends on the sidebar and members
// rail; a hardcoded x could land on the nick span, which owns its own
// right-click (#1115) and would open the wrong menu.
async function openMenuOnRow(page: Page, body: string): Promise<void> {
  const box = await rowWith(page, body).boundingBox();
  if (box === null) throw new Error("message row has no box");
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2, { button: "right" });
  await expect(menu(page)).toBeVisible();
}

test("issue1107 — !addquote fills the compose box with the command and the message", async ({
  page,
}) => {
  const body = uniqueBody("fill");
  await postMessage(page, body);

  // Pre-state: a non-empty or already-scrolled compose would make both
  // outcomes below true for the wrong reason.
  const ta = composeTextarea(page);
  await expect(ta).toHaveValue("");
  expect((await composeCaretGeometry(page)).scrollTop).toBe(0);

  await openMenuOnRow(page, body);
  await expect(menuItem(page, "!addquote")).toBeEnabled();
  await menuItem(page, "!addquote").click();

  // The payload ruling, at the only place it is observable end to end: the
  // command, one space, the body — and no `<nick>` head.
  await expect(ta).toHaveValue(`!addquote ${body}`, { timeout: 5_000 });

  // The #1105/#1113 dependency the issue names, on the real engine that jsdom
  // cannot stand in for.
  expectEndCaretVisible(await composeCaretGeometry(page), 40);
});

test("issue1107 — picking !addquote sends nothing", async ({ page }) => {
  const body = uniqueBody("nosend");
  await postMessage(page, body);

  await openMenuOnRow(page, body);
  await menuItem(page, "!addquote").click();

  // Barrier first: the compose value settling is the durable state that says
  // the item has fully run. Only then is the absence below an absence rather
  // than a race with an insertion still in flight.
  await expect(composeTextarea(page)).toHaveValue(`!addquote ${body}`, { timeout: 5_000 });

  // The original row is still the ONLY row carrying this text. A sent command
  // would echo back as a second scrollback line containing the same body.
  await expect(rowWith(page, body)).toHaveCount(1);
  await expect(
    page.locator('[data-testid="scrollback-line"]', { hasText: "!addquote" }),
  ).toHaveCount(0);
});

// NOT covered here, deliberately: the disabled-but-visible posture on a
// presence row. It is a pure item-list predicate with no geometry, no wire and
// no engine behaviour in it, and `src/__tests__/MessageContextMenu.test.tsx`
// pins it against a measured mutant. Reaching a presence row from here would
// need a locator that guesses which scrollback line is a JOIN, which is a
// fragile way to re-prove something already proven.
