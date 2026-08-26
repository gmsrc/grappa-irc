// #1796 — `/reconnect [<network>] [<reason>]`: the NETWORK bounce, irssi's
// RECONNECT. One verb where the operator used to type two, and the second of
// those two made them spell out a slug the client already knew.
//
// What makes this spec discriminating is that BOTH legs leave a signal, and
// neither signal is a transient the assertion has to catch mid-flight:
//
//   PARK — selection.ts's UX-4 bucket D redirects to Home the moment a
//   network the operator is looking at transitions INTO `:parked`. That
//   redirect is one-way: nothing sends them back. So "the operator ends on
//   Home" is durable proof that the park leg fired, readable long after it
//   did. A `/reconnect` that quietly skipped the park would leave the
//   operator in the channel and this assertion fails.
//
//   UNPARK — the network ends CONNECTED, with NO click. That is the whole
//   difference from `/disconnect` (cp15-b6-parked-disconnect-reconnect, which
//   has to click the Home card's Reconnect chip to get here). A `/reconnect`
//   that only parked would leave the section greyed and the parked card up.
//
// Deliberately NOT asserted: that the sidebar is greyed BETWEEN the legs. It
// is, but only for as long as the bounce takes, and pinning a state the
// implementation is racing to leave is how a spec becomes a flake detector for
// testnet latency instead of a regression detector for this verb.
//
// Also not asserted: the reason reaching upstream as the QUIT message. It is
// only visible to OTHER users on the channel, and the park-leg
// `connection_state_reason` that IS visible here is cleared by the unpark leg
// (`Networks.connect/1` clears the prior reason by contract). The reason
// riding the park body is pinned in the unit suite instead
// (compose.test.ts, "/reconnect <net> <reason> carries the reason into the
// park leg only").
//
// Timeout: 90s. The body itself is seconds, but the afterEach settle polls up
// to 30s for SpawnOrchestrator → connect → SASL → autojoin → NAMES, and the
// bounce inside the body pays that cost once already.

import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { settleNetworkAutojoin } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const BOUNCE_REASON = "rolling a fresh vhost";

test.setTimeout(90_000);

test.afterEach(async () => {
  // The testnet does not reset between specs: if this spec died between the
  // two legs the credential is left parked, which breaks every following spec
  // that expects autojoin to be live. Same ritual, same 30s budget, as
  // cp15-b6-parked-disconnect-reconnect — shared, not re-typed.
  const vjt = specUser();
  await settleNetworkAutojoin(vjt.token, NETWORK_SLUG, SEED_CHANNEL, specNick());
});

test("#1796 — /reconnect bounces the network end to end: parks, then comes back connected with no click", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: specNick() });

  const networkSection = page.locator(".sidebar-network-section", {
    has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
  });
  const channelRow = sidebarWindow(page, NETWORK_SLUG, SEED_CHANNEL);

  // Baseline: live network, live channel row, live compose.
  await expect(networkSection).not.toHaveClass(/sidebar-network-greyed/);
  await expect(channelRow.locator(".sidebar-window-greyed")).toHaveCount(0);

  // The park leg unmounts the ComposeBox out from under the submit (bucket D
  // redirects to Home, and Home renders no compose), so `expectUnmount` waits
  // for the textarea-gone signal rather than for it to go empty.
  await composeSend(page, `/reconnect ${NETWORK_SLUG} ${BOUNCE_REASON}`, { expectUnmount: true });

  // PARK happened, and this is the durable evidence of it: the operator is on
  // Home and stays there. Nothing in the unpark leg navigates back.
  await expect(page.locator(".home-pane")).toHaveCount(1, { timeout: 15_000 });

  // UNPARK happened, with no click anywhere: the network is connected again,
  // so the greyed cascade is gone and no parked card is left on Home.
  await expect(networkSection).not.toHaveClass(/sidebar-network-greyed/, { timeout: 30_000 });
  await expect(
    page.locator(".home-pane-network-row-parked", {
      has: page.locator(".home-pane-network-slug", { hasText: NETWORK_SLUG }),
    }),
  ).toHaveCount(0, { timeout: 30_000 });

  // A genuinely fresh session, not a row flipped in the DB: the respawned
  // Session.Server ran its autojoin loop, so the seeded channel is back as a
  // live (un-greyed) row.
  await expect(channelRow).toHaveCount(1, { timeout: 30_000 });
  await expect(channelRow.locator(".sidebar-window-greyed")).toHaveCount(0, { timeout: 30_000 });
});
