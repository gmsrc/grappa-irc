// #1765 — `»N` on the only unread window, when that window is far behind.
//
// Two cures that are each right cancel out. #1178 made the jump verb
// short-circuit to `requestScrollToBottom()` when the cycle resolves back to
// the window the operator is already in; #693/#1019 freeze the read cursor
// while a window is far behind, deliberately, so that scroll cannot advance
// it. With both in force the tap moved nothing at all: the bar stayed, the
// frozen seed stayed, and the button kept advertising a count.
//
// The cure routes that arm to the bar's PRIMARY exit — the jump BACK into the
// unread region — and not to its `×`. What that difference LOOKS like is
// exactly what this spec measures, because the two are indistinguishable from
// "the bar went away":
//
//   * the bar goes away AND the pane lands on the unread divider, carrying the
//     server-measured count. A dismiss also clears the bar, and re-latches the
//     divider away, so the marker is the discriminator between the two;
//   * the SERVER cursor has NOT crossed the abandoned region. This is the
//     product claim, not a mechanism: a tap on an unlabelled `»` that reads
//     `1` (it counts WINDOWS) must not accept thousands of messages as read on
//     every device. #1062 already removed a second dismiss surface from the
//     float stack this button lives in, for the neighbouring reason.
//
// NOT asserted: that the button hides. It should not, and that is the honest
// outcome rather than a gap — after the jump the unread is local, real, and on
// screen, so the count it renders is true for the first time. Reading to the
// tail clears it, or a second tap now takes #1178's exit with the freeze gone.
// The issue's Expected clause asked for the button to hide; that followed from
// its dismiss proposal, which the fix declines.
//
// Seeding mirrors `issue1062-far-behind-float-stack.spec.ts` and
// `issue1019-farbehind-leave-dismiss.spec.ts` (same bar, same precondition):
// the shared seeder plants 200 rows in #spec-wN and this needs a gap ABOVE the
// 200-row page cap, so it re-seeds via the admin `resetSubject(baselineSeed)`
// surface. Nothing has to be undone afterwards: #1078 destroys the whole
// subject at teardown, rows and cursor with it. Seeding ONE channel is also
// what makes it the ONLY unread window, which is the state the bug needs.
//
// No sleep is used as synchronisation: every step waits on an observable
// condition. The timeouts are WAIT BUDGETS on those conditions, never the
// thing being measured.
//
// Desktop viewport, as both sibling far-behind specs: the sidebar badge is the
// clearer read of "the count is no longer the frozen one".

import { loginAs, selectChannel, sidebarMessageBadge } from "../fixtures/cicchettoPage";
import {
  fetchAllMessagesAsc,
  getReadCursor,
  resetSubject,
  setReadCursorToId,
} from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededAdmin, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Larger than the 200-row server cap, so a cursor planted early leaves a gap
// the resume cannot drain in one page — the far-behind precondition.
const LARGE_SEED_COUNT = 260;
const SEED_SENDER = "seed-bot";

// The server's `@max_http_limit` and the client's `PAGE_LIMIT`. A gap above
// this is what "far behind" means.
const MAX_HTTP_LIMIT = 200;

// Rows left after the planted cursor — above the cap, so the pane anchors at
// the tail and freezes.
const UNREAD_TARGET = 240;

// Wait budget for the resume probe, the jump's two fetches, and the settle
// writes. Not a sleep: it bounds `expect` CONDITIONS.
const OUTCOME_TIMEOUT_MS = 10_000;

const NEXT_ACTIVE_BTN = '[data-testid="next-active-btn"]';
const NEXT_ACTIVE_COUNT = '[data-testid="next-active-btn"] .next-active-count';

const countIn = (label: string, what: string): number => {
  const match = label.match(/(\d+)/);
  if (!match?.[1]) {
    throw new Error(`#1765 spec: ${what} carries no count: ${JSON.stringify(label)}`);
  }
  return Number(match[1]);
};

test.describe("#1765 — »N on a far-behind window jumps back instead of doing nothing", () => {
  test("the tap clears the bar, lands on the unread divider, and reads nothing for you", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = specUser();
    const admin = getSeededAdmin();

    await resetSubject(
      admin.token,
      specUser().name,
      { [NETWORK_SLUG]: AUTOJOIN_CHANNELS },
      { [NETWORK_SLUG]: [{ name: CHANNEL, seedCount: LARGE_SEED_COUNT, seedSender: SEED_SENDER }] },
    );

    const rows = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, CHANNEL);
    expect(rows.length).toBeGreaterThan(UNREAD_TARGET);

    const lastReadRow = rows[rows.length - UNREAD_TARGET];
    const tailRow = rows[rows.length - 1];
    if (!lastReadRow || !tailRow)
      throw new Error("#1765 spec: seeded #spec-wN rows missing an index");

    // Guard the precondition: below this the pane never goes far behind and
    // the spec would pass by testing nothing.
    const rowsAfterCursor = rows.filter((r) => r.id > lastReadRow.id).length;
    expect(rowsAfterCursor).toBeGreaterThan(MAX_HTTP_LIMIT);

    // Plant the cursor BEFORE login so the channel hydrates with it and takes
    // the cursor-present fetch arm.
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, lastReadRow.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL);

    // The bar renders only once the resume has probed the count and refused
    // the gap — the readiness signal for the far-behind arm, and the gate that
    // says the freeze is actually in force.
    const bar = page.locator('[data-testid="far-behind-bar"]');
    await expect(bar).toBeAttached({ timeout: OUTCOME_TIMEOUT_MS });

    const badge = sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL);
    await expect(badge).toBeVisible({ timeout: OUTCOME_TIMEOUT_MS });
    await expect(badge).toHaveClass(/far-behind/);

    // The pane is at the tail, so the divider is suppressed (#693): the rows
    // on screen are NOT the unread region. Pinning its absence here is what
    // makes its presence after the tap mean something.
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0);

    // The crossed state: this is the ONLY window with unread, so the cycle can
    // only resolve back to the selection. The count is a WINDOW count — the
    // `»1` under which a dismiss would have destroyed 240 messages.
    await expect(page.locator(NEXT_ACTIVE_COUNT)).toHaveText("1", {
      timeout: OUTCOME_TIMEOUT_MS,
    });

    // Nothing has moved the cursor yet: the pane has been open and rendered
    // and it is still exactly where it was planted. Without this the closing
    // assertion could be satisfied by a write that never happened at all.
    expect(await getReadCursor(vjt.token, NETWORK_SLUG, CHANNEL)).toBe(lastReadRow.id);

    // THE gesture — the same button #235 ships, through the same verb Alt+A
    // fires. On the parent commit this is where everything stops moving.
    await page.locator(NEXT_ACTIVE_BTN).click();

    // Outcome 1 — the far-behind state is resolved. The bar is down and the
    // badge has dropped the #888 frozen treatment.
    await expect(bar).toHaveCount(0, { timeout: OUTCOME_TIMEOUT_MS });
    await expect(badge).not.toHaveClass(/far-behind/, { timeout: OUTCOME_TIMEOUT_MS });

    // Outcome 2 — and it resolved by taking the operator TO the unread, not by
    // throwing it away. The divider is back, at their read position, carrying
    // the server-measured count rather than the page cap (#947). A dismiss
    // clears the bar too and re-latches this marker away, so this is the line
    // that tells the two exits apart.
    const marker = page.locator('[data-testid="unread-marker"]');
    await expect(marker).toBeVisible({ timeout: OUTCOME_TIMEOUT_MS });
    expect(countIn(await marker.innerText(), "the unread divider")).toBeGreaterThan(MAX_HTTP_LIMIT);

    // Outcome 3 — the product claim. An unlabelled `»` reading `1` did not
    // accept the abandoned region as read on every device. The cursor may
    // creep forward as the newly-rendered rows are read (the freeze is gone,
    // which is the point), but it must not have crossed to the tail.
    const cursorAfter = await getReadCursor(vjt.token, NETWORK_SLUG, CHANNEL);
    expect(cursorAfter).toBeLessThan(tailRow.id);
  });
});
