// #1226 — /away and its un-away twin were silent in the client. compose.ts's
// "away" case returns `{ok: true}` (a SILENT success, ComposeBox.tsx:515), so
// the only cue was the 💤 sidebar badge — a STATE indicator, and off-screen on
// a phone with the sidebar collapsed. This spec pins the acknowledgement the
// operator actually looks at: a line in the feedback seam under the compose
// box, on BOTH transitions.
//
// Drives the real round-trip, exactly as #276 does for the badge: `/away
// :reason` over the user-level Phoenix Channel → GrappaChannel.handle_in
// ("away") → Session.set_explicit_away → `AWAY :reason` upstream → bahamut
// replies 306 RPL_NOWAWAY → EventRouter's typed `away_confirmed` effect →
// broadcast on Topic.user → cic's awayStatus store → the seam. Bare `/away`
// unsets → 305 RPL_UNAWAY → away_confirmed(present) → the second line.
//
// The trigger is the SERVER echo, not the local push resolving (vjt's ruling,
// 2026-08-11), which is why the assertion below is worth its fake-lag wait: a
// seam fed by the local ack would light up even when the ircd never confirmed.
//
// Severity is the GREEN notice register (#356): class `compose-box-notice`,
// `role=status`. The red `compose-box-error` MUST NOT appear — an away
// acknowledgement is not a failure. Copy is state-ONLY (no reason echoed, no
// tally — the #1108 precedent), pinned here against ComposeBox.tsx's
// AWAY_SET_NOTICE / AWAY_UNSET_NOTICE.
//
// CLEANUP: afterEach clears away iff the badge is still up (failure path), so
// a mid-run failure does not leave the seeded session away for the next spec.

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];

// ComposeBox.tsx AWAY_SET_NOTICE / AWAY_UNSET_NOTICE.
const AWAY_SET_LINE = "away: you are marked as away";
const AWAY_UNSET_LINE = "away: you are no longer away";

// 60s — login + channel seed + two AWAY round-trips against the real bahamut
// testnet (fake-lag on both echoes), with load headroom.
test.setTimeout(60_000);

test.afterEach(async ({ page }) => {
  const badge = page.locator(".sidebar-away-badge");
  if ((await badge.count().catch(() => 0)) > 0) {
    await composeSend(page, "/away").catch(() => {});
  }
});

test("#1226 — /away and un-away each render a green line in the compose seam", async ({ page }) => {
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: specNick() });

  const notice = page.locator(".compose-box-notice");
  const error = page.locator(".compose-box-error");

  // Baseline: nothing in the seam before either transition.
  await expect(notice).toHaveCount(0);

  // GOING AWAY. One assertion, not a count-then-text pair: the notice
  // auto-dismisses after ~3s (#356), so a second poll on the same element
  // could legitimately find it gone. `toHaveText` resolves the instant the
  // 306 echo lands and never waits on the dismissal.
  await composeSend(page, "/away :testing #1226 seam feedback");
  await expect(notice).toHaveText(AWAY_SET_LINE, { timeout: 15_000 });
  await expect(notice).toHaveAttribute("role", "status");
  await expect(error).toHaveCount(0);
  // The reason is NOT echoed back: state only.
  await expect(notice).not.toContainText("testing #1226");

  // COMING BACK. composeSend's own submit clears the first line on the way in
  // (ComposeBox clears feedback at submit start), so this text can only come
  // from the 305 echo.
  await composeSend(page, "/away");
  await expect(notice).toHaveText(AWAY_UNSET_LINE, { timeout: 15_000 });
  await expect(notice).toHaveAttribute("role", "status");
  await expect(error).toHaveCount(0);
});
