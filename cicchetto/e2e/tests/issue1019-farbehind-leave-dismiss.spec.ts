// #1019 — leaving a far-behind window IS the bar's ×.
//
// vjt, on IRC: *"il focus out su una finestra con molto scrollback e con la
// top bar dovrebbe fare mark as read, come se avessimo premuto la X"*. The
// far-behind bar (#693/#888) had two exits and both cost a deliberate click;
// an operator who simply moves on to another window used to carry a frozen
// badge that no amount of reading could clear, because #693 freezes the read
// cursor on purpose and the leave writer is one of the four the freeze holds
// back.
//
// The fix ROUTES the leave writer to `dismissFarBehind` instead of thawing
// `setCursorIfAdvances` for it. That distinction is invisible from the
// outside, so what this spec pins is the OUTCOME, three ways:
//
//   * the sidebar badge falls once the operator selects another window —
//     the thing they could not achieve without finding the × at the top edge;
//   * the SERVER-side cursor lands at (or past) the tail — the same
//     `setReadCursor` fan-out the × performs, which is what "identical in
//     effect to clicking ×" in the Acceptance clause actually means. A purely
//     local badge clear would satisfy the first assertion and leave every
//     other device still far behind;
//   * coming BACK shows no bar and no phantom count — the second Acceptance
//     clause, and the one that would catch a dismiss that cleared the badge
//     without moving the cursor the resume re-reads.
//
// Q1 was ruled by vjt on the issue: only (a), a window switch INSIDE cic,
// dismisses. Test 2 pins the negative half of that ruling — backgrounding the
// tab / losing window focus must NOT dismiss (`documentVisibility` gates the
// visibility-hide writer, which stays frozen).
//
// NOT covered here, deliberately, and named so nobody reads this file as a
// completeness claim: `channel → home / mentions / admin` unmounts the pane
// and lands in `onCleanup`, where `props` already read the ARRIVING virtual
// selection, so the leaving window cannot be named. That switch leaves the
// far-behind state STANDING (the safe side — the region stays recoverable)
// and the PR says so at the call site. This spec therefore leaves for the
// SERVER window, which shares the `kindHasScrollback` Match with channels and
// so keeps the pane mounted and fires the key arm — the same gesture
// `cursor-forward-only.spec.ts` uses to drive the leave writer.
//
// Against the parent commit the leave writer reaches a frozen door, the
// cursor never moves and the badge never falls, so the spec is RED at the
// first outcome assertion rather than at a locator.
//
// Seeding mirrors `issue997-far-behind-thumb-reach.spec.ts` (same bar, same
// precondition): the shared seeder plants 200 rows in #bofh and this needs a
// gap ABOVE the 200-row page cap, so it re-seeds via the admin
// `resetSubject(baselineSeed)` surface. The wrapped `test` fixture's afterEach
// truncates #bofh back to the baseline; `restoreReadCursorToTail` in afterAll
// undoes the early cursor (BUGHUNT-3 cascade rule — a spec that leaves a
// mid-list cursor behind makes every downstream spec open its pane at a
// divider instead of at the tail).
//
// No sleep is used as synchronisation anywhere: every step waits on an
// observable condition (the bar attaching, the badge reaching count 0, the
// server cursor reaching the tail, `isDocumentVisible`'s two inputs flipping).
// The cursor is written server-side at SETTLE cadence, so the timeouts here
// are WAIT BUDGETS on those conditions, never the thing being measured.
//
// Desktop viewport on purpose, matching #997: the sidebar badge is the
// clearer read of "the badge fell" than the mobile tab treatment.

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel, sidebarMessageBadge } from "../fixtures/cicchettoPage";
import {
  fetchAllMessagesAsc,
  getReadCursor,
  resetSubject,
  restoreReadCursorToTail,
  setReadCursorToId,
} from "../fixtures/grappaApi";
import {
  AUTOJOIN_CHANNELS,
  getSeededAdmin,
  getSeededVjt,
  NETWORK_SLUG,
  VJT_USER,
} from "../fixtures/seedData";

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

// Wait budget for the settle-cadence server write to land and fan back. Not a
// sleep: it bounds an `expect.poll` / `toHaveCount` CONDITION.
const OUTCOME_TIMEOUT_MS = 10_000;

interface FarBehindFixture {
  readonly tailId: number;
  readonly cursorPlantedAt: number;
}

// Plant the far-behind precondition and prove it, before any browser exists.
// Returns the two ids the assertions are written against.
async function seedFarBehindChannel(channel: string): Promise<FarBehindFixture> {
  const vjt = getSeededVjt();
  const admin = getSeededAdmin();

  await resetSubject(
    admin.token,
    VJT_USER,
    { [NETWORK_SLUG]: AUTOJOIN_CHANNELS },
    { [NETWORK_SLUG]: [{ name: channel, seedCount: LARGE_SEED_COUNT, seedSender: SEED_SENDER }] },
  );

  const rows = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, channel);
  expect(rows.length).toBeGreaterThan(UNREAD_TARGET);

  const lastReadRow = rows[rows.length - UNREAD_TARGET];
  const tailRow = rows[rows.length - 1];
  if (!lastReadRow || !tailRow) throw new Error("#1019 spec: seeded #bofh rows missing an index");

  // Guard the precondition: below this the pane never goes far behind and the
  // spec would pass by testing nothing.
  const rowsAfterCursor = rows.filter((r) => r.id > lastReadRow.id).length;
  expect(rowsAfterCursor).toBeGreaterThan(MAX_HTTP_LIMIT);

  // Plant the cursor BEFORE login so the channel hydrates with it and takes
  // the cursor-present fetch arm.
  await setReadCursorToId(vjt.token, NETWORK_SLUG, channel, lastReadRow.id);

  return { tailId: tailRow.id, cursorPlantedAt: lastReadRow.id };
}

test.describe("#1019 — leaving a far-behind window marks it read", () => {
  test.use({ viewport: { width: 800, height: 400 } });

  test.afterAll(async () => {
    if (!CHANNEL) return;
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("selecting another window drops the frozen badge and advances the server cursor", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();
    const { tailId, cursorPlantedAt } = await seedFarBehindChannel(CHANNEL);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL);

    // The bar renders only once the resume has probed the count and decided
    // the gap is undrainable — the readiness signal for the far-behind arm,
    // and the gate that says the freeze is actually in force.
    const bar = page.locator('[data-testid="far-behind-bar"]');
    await expect(bar).toBeAttached({ timeout: OUTCOME_TIMEOUT_MS });

    const badge = sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL);
    await expect(badge).toBeVisible({ timeout: OUTCOME_TIMEOUT_MS });
    await expect(badge).toHaveClass(/far-behind/);

    // Nothing has moved it yet: the pane has been open and rendered, and the
    // cursor is still exactly where it was planted. Without this the next
    // assertion could be satisfied by a write that had already happened.
    expect(await getReadCursor(vjt.token, NETWORK_SLUG, CHANNEL)).toBe(cursorPlantedAt);

    // THE gesture. The server window shares the `kindHasScrollback` Match with
    // channels, so the pane stays mounted and the key arm fires with #bofh as
    // the LEAVING key — a real selection change through the sidebar, not a
    // direct call to the dismiss.
    await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });

    // Outcome 1 — the badge fell. This is the operator-visible result and the
    // whole point of the issue.
    await expect(badge).toHaveCount(0, { timeout: OUTCOME_TIMEOUT_MS });

    // Outcome 2 — the SERVER cursor moved to the tail, i.e. the same
    // `setReadCursor` fan-out the × performs. `toBeGreaterThanOrEqual` rather
    // than `toBe`: the dismiss marks the newest LOCAL row, and a presence row
    // (a peer JOIN on the shared testnet) can land after the seed snapshot and
    // legitimately push the tail past `tailId`. The load-bearing claim is that
    // it crossed the whole abandoned region, which the second assertion pins.
    await expect
      .poll(async () => await getReadCursor(vjt.token, NETWORK_SLUG, CHANNEL), {
        timeout: OUTCOME_TIMEOUT_MS,
      })
      .toBeGreaterThanOrEqual(tailId);
    expect(tailId).toBeGreaterThan(cursorPlantedAt);

    // Outcome 3 — coming back shows no bar and no phantom count. The resume
    // re-reads the cursor this dismiss advanced, so a dismiss that cleared the
    // badge locally without persisting would rebuild the bar right here.
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { awaitWsReady: false });
    await expect(bar).toHaveCount(0, { timeout: OUTCOME_TIMEOUT_MS });
    await expect(badge).toHaveCount(0);
  });

  test("backgrounding the tab does NOT dismiss — only a window switch does", async ({
    page,
    context,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();
    const { cursorPlantedAt } = await seedFarBehindChannel(CHANNEL);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL);

    const bar = page.locator('[data-testid="far-behind-bar"]');
    await expect(bar).toBeAttached({ timeout: OUTCOME_TIMEOUT_MS });
    const badge = sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL);
    await expect(badge).toBeVisible({ timeout: OUTCOME_TIMEOUT_MS });

    // Drive a REAL background: a second tab brought to front. That flips both
    // inputs `documentVisibility.ts` reads — `visibilityState` and
    // `hasFocus()` — through the browser's own event path, not a synthesised
    // `visibilitychange`. Q1's rejected cases (b) and (c) are exactly this.
    const other = await context.newPage();
    await other.goto("about:blank");
    await other.bringToFront();

    // Precondition, polled, NOT assumed: if the harness cannot actually
    // background the page, this fails loudly instead of letting the negative
    // pass vacuously.
    await expect
      .poll(
        async () =>
          await page.evaluate(
            () => document.visibilityState === "visible" && document.hasFocus(),
          ),
        { timeout: OUTCOME_TIMEOUT_MS },
      )
      .toBe(false);

    // The barrier is the round trip, not a sleep: coming back to the front is
    // an observable edge, and it happens strictly after the hide edge that
    // would have dismissed. If the visibility writer had a back door, the
    // badge would already be gone by the time focus returns.
    await page.bringToFront();
    await expect
      .poll(
        async () =>
          await page.evaluate(
            () => document.visibilityState === "visible" && document.hasFocus(),
          ),
        { timeout: OUTCOME_TIMEOUT_MS },
      )
      .toBe(true);
    await other.close();

    // Still far behind: the freeze held, and the cursor is untouched
    // server-side. The cursor assertion is the one that cannot be faked by a
    // slow render.
    await expect(bar).toBeAttached();
    await expect(badge).toBeVisible();
    expect(await getReadCursor(vjt.token, NETWORK_SLUG, CHANNEL)).toBe(cursorPlantedAt);
  });
});
