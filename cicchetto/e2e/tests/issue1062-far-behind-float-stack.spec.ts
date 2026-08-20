// #1062 — the far-behind ✓ is out of the float stack, and the × still works.
//
// This file replaces `issue997-far-behind-thumb-reach.spec.ts`, which pinned
// the OPPOSITE product: #997 mounted a second dismiss surface in the #280
// float stack and that spec measured its tap floor and its lower-right
// placement. vjt reported the cost from the mobile PWA: he navigates
// far-behind windows by repeated tapping of ONE zone, bottom-right —
// scroll-to-bottom while there is tail below, then the mobile next-active the
// instant it unmounts — and a third control with a third meaning landed under
// that thumb on exactly the windows the round trip is for.
//
// So the corner control is gone and the gesture is back to the bar alone. Two
// things are worth an e2e rather than a unit test, and both are here:
//
//   * the far-behind arm contributes NOTHING to the float stack. Asserted
//     against a real far-behind pane, because the arm only exists once the
//     resume has probed the gap and refused it — the state a unit test has to
//     fake;
//   * the × on the bar still drops the frozen badge. #997's spec was the only
//     e2e that clicked a dismiss and watched the badge fall; deleting it
//     outright would have quietly retired that outcome, so it moves here onto
//     the surviving door.
//
// NOT covered here, deliberately: that the next-active button takes over the
// corner once scroll-to-bottom unmounts. That is #280's coexistence claim, it
// has its own spec (`issue280-button-coexist.spec.ts`), and reproducing it
// needs a SECOND window seeded with unread on top of this file's 260-row
// far-behind seed — machinery whose failure modes would be about seeding, not
// about #1062. The third exit (leaving the window dismisses) is #1019's spec.
//
// Seeding mirrors the #997 spec it replaces (itself mirroring #947 and #693):
// the shared seeder plants 200 rows in #bofh and this needs unread > 200, so
// it re-seeds via the admin
// `resetSubject(baselineSeed)` surface. Nothing has to be undone afterwards:
// #1078 destroys the whole subject at teardown, rows and cursor with it.
//
// Desktop viewport, as the spec it replaces: the removal is a DOM claim, not a
// geometry one, and the sidebar badge is the clearer read of "the badge fell".

import { loginAs, selectChannel, sidebarMessageBadge } from "../fixtures/cicchettoPage";
import { fetchAllMessagesAsc, resetSubject, setReadCursorToId } from "../fixtures/grappaApi";
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

const countIn = (label: string, what: string): number => {
  const match = label.match(/(\d+)/);
  if (!match?.[1]) {
    throw new Error(`#1062 spec: ${what} carries no count: ${JSON.stringify(label)}`);
  }
  return Number(match[1]);
};

test.describe("#1062 — the far-behind gesture is the bar's × and nothing else", () => {
  test.use({ viewport: { width: 800, height: 400 } });

  test("a far-behind window adds no control to the float stack, and the bar still dismisses", async ({
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
    if (!lastReadRow) throw new Error("#1062 spec: seeded #spec-wN rows missing cursor index");
    const rowsAfterCursor = rows.filter((r) => r.id > lastReadRow.id).length;
    // Guard the precondition: below this the pane never goes far behind and
    // the spec would pass by testing nothing.
    expect(rowsAfterCursor).toBeGreaterThan(MAX_HTTP_LIMIT);

    // Plant the cursor BEFORE login so the channel hydrates with it and takes
    // the cursor-present fetch arm.
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, lastReadRow.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL);

    // The bar renders only once the resume has probed the count and decided
    // the gap is undrainable — the readiness signal for the far-behind arm,
    // and the gate that says the freeze is actually in force.
    const bar = page.locator('[data-testid="far-behind-bar"]');
    await expect(bar).toBeAttached({ timeout: 10_000 });
    const advertised = countIn(
      await page.locator('[data-testid="far-behind-jump"]').innerText(),
      "the jump-back bar",
    );
    expect(advertised).toBeGreaterThan(MAX_HTTP_LIMIT);

    // The state vjt's round trip runs in: a badge carrying the #888
    // far-behind treatment, frozen, with no amount of reading able to move it.
    const badge = sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL);
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveClass(/far-behind/);

    // THE removal. Scoped to the stack rather than to the whole page: the bar
    // legitimately carries a `far-behind-dismiss`, and what #1062 forbids is a
    // far-behind control in the thumb zone, not the gesture as such. The
    // page-wide check on the retired testid follows, so a control that moved
    // rather than went away is caught too.
    const stack = page.locator(".scrollback-float-stack");
    await expect(stack).toBeAttached();
    await expect(stack.locator('[data-testid^="far-behind"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="far-behind-float-dismiss"]')).toHaveCount(0);

    // The surviving door, and the outcome #997's spec used to own: the ONE
    // dismiss is on the bar, and it unfreezes the cursor. A removal that also
    // broke the remaining exit would leave the operator with no way out at all.
    const dismiss = page.locator('[data-testid="far-behind-dismiss"]');
    await expect(dismiss).toHaveCount(1);
    expect(await bar.locator('[data-testid="far-behind-dismiss"]').count()).toBe(1);
    await dismiss.click();

    await expect(badge).toHaveCount(0, { timeout: 10_000 });
    await expect(bar).toHaveCount(0);
  });
});
