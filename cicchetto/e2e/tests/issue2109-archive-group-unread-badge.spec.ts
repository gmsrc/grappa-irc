// issue 2109 — the unread rollup on each ArchiveModal network group header.
//
// Reported by vjt on IRC: "la lista network in archive non mostra il numero di
// msg non letti". #532 B gave the ROWS inside a group their badges and #2096
// gave the LAUNCHER the cross-network total; the `<summary>` in between
// carried nothing but the slug. Every group starts COLLAPSED (the rows are
// lazy), so the launcher said "something is unread behind this door" and the
// operator then had to expand every network in turn to find out which one.
//
// What this pins, in ONE continuously-open modal so every transition is
// observed LIVE rather than across reloads:
//
//   1. baseline — read off the badge itself, because the suite shares one
//      account across specs and an absolute `0` would be a hostage to whatever
//      ran before;
//   2. THE CONTROL — a peer line lands in a channel the operator is still IN.
//      The unread is real (the +1 in step 3 proves cic counted it) and the
//      group badge must NOT move: an active window has its own nav surface and
//      is not the archive's business. Without this reading, step 3 would only
//      say "a number appeared", not "the subtraction works";
//   3. APPEARS — PART. Same unread, no new message; the window simply stops
//      having a nav surface and the group gains exactly 1;
//   4. THE GROUP AGREES WITH ITS ROWS — expand, and the row the group was
//      hiding carries exactly the 1 the header gained. The two numbers are
//      read off the SAME open modal, so this is the issue's invariant ("a
//      group's badge must equal the sum of the row badges that group would
//      draw") measured as a delta, which is what makes it immune to unread a
//      sibling spec left behind;
//   5. DISAPPEARS — JOIN it back. Still nothing read, the surface returns, the
//      header falls back to the baseline.
//
// Steps 2, 4 and 5 are what make this a real spec rather than a green mirror:
// the badge is DERIVED from `/me`'s seed minus what the nav draws
// (`lib/archiveRollup.ts`), so a header wired to the raw seed fails at 2, one
// wired to the cross-network total fails at 4 on any multi-network account,
// and one snapshotted at modal-open fails at 5.
//
// Desktop only, deliberately, and this is NOT the #2096 shape: that badge
// lives on `RailActions`, a component whose two mounts are the thing under
// test, so it owed a `@touch` twin. `ArchiveModal` is ONE modal with ONE
// layout on both form factors (#473 folded the mobile-only archive panel into
// it) and `openArchive` is already viewport-aware, so a phone entry would
// re-measure the fixture rather than the badge.

import type { Locator, Page } from "@playwright/test";
import { loginAs, openArchive, selectChannel } from "../fixtures/cicchettoPage";
import {
  assertMessagePersisted,
  awaitPartEcho,
  joinChannel,
  partChannel,
  restoreReadCursorToTail,
} from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specLiveNick, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const WITNESS = "#2109 — the line the group header must own up to";

test.afterEach(async () => {
  const vjt = specUser();
  // Restore the seed-time joined state and a tail cursor: this spec PARTs the
  // shared autojoin channel and leaves an unread behind, and neither may
  // poison a sibling spec (or this one under --repeat-each). Both idempotent,
  // both guarded so a mid-test failure cannot cascade.
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL).catch(() => {});
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL).catch(() => {});
});

// The MESSAGE pill of one group header, as a number — 0 when no badge renders.
//
// Scoped to `.sidebar-msg-unread` and not to the whole cluster on purpose: the
// events pill is a separate tier (#265/#532) fed by presence churn this spec
// does not control, and the claim here is strictly about the message rollup.
async function groupBadgeMessages(page: Page, slug: string): Promise<number> {
  const pill = page.locator(`[data-testid='archive-group-unread-${slug}'] .sidebar-msg-unread`);
  if ((await pill.count()) === 0) return 0;
  const text = (await pill.first().innerText()).trim();
  const parsed = Number.parseInt(text, 10);
  return Number.isNaN(parsed) ? -1 : parsed;
}

async function expectGroupBadge(page: Page, slug: string, expected: number): Promise<void> {
  await expect
    .poll(() => groupBadgeMessages(page, slug), { timeout: 10_000, intervals: [100, 200, 500] })
    .toBe(expected);
}

// The MESSAGE pill of one ROW inside an expanded group, by its target.
async function rowBadgeMessages(group: Locator, target: string): Promise<number> {
  const pill = group.locator(
    `[data-testid='archive-unread-${NETWORK_SLUG}-${target}'] .sidebar-msg-unread`,
  );
  if ((await pill.count()) === 0) return 0;
  const text = (await pill.first().innerText()).trim();
  const parsed = Number.parseInt(text, 10);
  return Number.isNaN(parsed) ? -1 : parsed;
}

test("#2109 — the archive group header counts what the collapsed group is hiding", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Clean baseline on the channel itself, so the +1 below is OUR peer line and
  // not a leftover from a sibling spec.
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);

  // Focus the channel once (hydrates its pane + the per-channel topic), then
  // step off to the server window: a focused window suppresses its own badge,
  // and the server window has no compose, so it cannot produce client chatter
  // of its own.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });

  // Open the modal ONCE and leave it open: the whole point of the badge is
  // that it is readable while the group is still COLLAPSED, so every reading
  // below step 4 is taken without expanding anything.
  await openArchive(page);
  const group = page.getByTestId(`archive-modal-group-${NETWORK_SLUG}`);
  await expect(group).toBeVisible();
  expect(await group.getAttribute("open")).toBeNull();

  // 1 — BASELINE, read off the badge.
  const baseline = await groupBadgeMessages(page, NETWORK_SLUG);
  expect(baseline).toBeGreaterThanOrEqual(0);

  const peer = await IrcPeer.connect({ nick: `i2109-peer` });
  try {
    await peer.join(CHANNEL);
    peer.privmsg(CHANNEL, WITNESS);
    // Server-side barrier: the line exists. Without this the "badge did not
    // move" reading below could be a message that never arrived.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: CHANNEL,
      sender: peer.nick,
      body: WITNESS,
    });

    // 2 — THE CONTROL. The unread is in a channel the operator is still IN, so
    // it has a nav row of its own and the group header must not claim it.
    await expectGroupBadge(page, NETWORK_SLUG, baseline);

    // 3 — APPEARS. PART only removes the surface; the unread is untouched.
    await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
    await awaitPartEcho(vjt.token, NETWORK_SLUG, CHANNEL, await specLiveNick());
    await expectGroupBadge(page, NETWORK_SLUG, baseline + 1);

    // 4 — THE GROUP AGREES WITH ITS ROWS. Expanding is what the badge exists
    // to spare the operator, so it happens only now: the row that arrives
    // carries exactly the 1 the header gained in step 3.
    await group.locator("summary.archive-modal-group-summary").click();
    await expect(group).toHaveAttribute("open", "");
    await expect
      .poll(() => rowBadgeMessages(group, CHANNEL), {
        timeout: 10_000,
        intervals: [100, 200, 500],
      })
      .toBe(1);
    // …and the header did not move when its rows loaded: the badge is the seed
    // minus the nav, never the fetched list, so a lazy load must not change it.
    await expectGroupBadge(page, NETWORK_SLUG, baseline + 1);

    // 5 — DISAPPEARS. JOIN gives the surface back; still no message read.
    await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
    await expectGroupBadge(page, NETWORK_SLUG, baseline);
  } finally {
    await peer.disconnect("#2109 done");
  }
});
