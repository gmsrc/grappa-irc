// P-0a — Cluster `numeric-delegation-p0` 2026-05-13. End-to-end proof
// that 307 RPL_WHOISREGNICK is delegated by the EventRouter into the
// WhoisCard's `is_registered` flag, which cic renders as the
// "registered" tag chip.
//
// Pre-conditions:
//   - vjt logged in, focused on #spec-wN.
//   - Peer "p0a-target" connects to a leaf, REGISTERs with NickServ, then
//     AUTHs with the emailed code (EMAIL:1 since GH #349) to reach +r.
//     azzurra-testnet d998d09 added the `U:services.azzurra
//     .chat:*:*:` line on every leaf so the SVSMODE +r emitted by
//     services-via-hub is actually applied on the leaf the peer is on
//     (without that line, m_svsmode silently drops at IsULine and +r
//     never lands on the local user).
//   - vjt issues /whois <peer> from the compose box.
//
// Asserts:
//   - WhoisCard renders;
//   - "registered" tag chip is visible (proving end-to-end that the
//     307 fold path works — bahamut emits 307 only when IsRegNick on
//     the target, which only holds when SVSMODE +r actually applied).
//
// Note on broader coverage: per-numeric folds are exhaustively unit-
// tested at the Elixir boundary (event_router_test.exs) + cic-render
// boundary (WhoisCard.test.tsx). This e2e is the integration-level
// proof that one services-emitted numeric (307) flows end-to-end,
// from which the other 10 P-0a numerics follow by same-shape
// inductive reasoning.

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { awaitMail, extractFromMail, resetMailpit } from "../fixtures/mailpit";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const PEER_NICK = "p0a-target";
const PEER_PASSWORD = "p0a-test-password-not-secret";
// The testnet runs EMAIL:1 (GH #349 wired real-services registration), so
// REGISTER emails a confirmation code and the nick stays NOT-+r until the
// peer sends `AUTH <code>`. The recipient MUST use a real (ICANN) TLD —
// services' validate_email rejects `*.local`/`.test` — so use example.com;
// msmtp relays it to the mailpit sink regardless of domain (hermetic).
const PEER_EMAIL = "p0a@example.com";
// Azzurra's confirmation mail carries the code as `AUTH <digits>`
// (case-sensitive — same regex as registration-wizard-real.spec.ts).
const AUTH_CODE_RE = /AUTH (\d+)/;
const CHANNEL = AUTOJOIN_CHANNELS[0];

test("P-0a — /whois shows 'registered' tag for a NickServ-identified peer (307 RPL_WHOISREGNICK delegated)", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // Wipe any prior confirmation mail so the To-filter is unambiguous.
  await resetMailpit();

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // EMAIL:1 registration is a two-step round-trip: REGISTER emails an
    // AUTH code (the nick carries NI_AUTH, not yet +r), then `AUTH <code>`
    // flips +r. Read the code from the mailpit sink the REGISTER mail was
    // relayed to. `nickservAuth` waits for both the accept notice AND the
    // +r umode before resolving — eliminating the race between the
    // services<->ircd SVSMODE round-trip and a subsequent /whois that
    // would otherwise miss 307 RPL_WHOISREGNICK.
    await peer.nickservRegister(PEER_PASSWORD, PEER_EMAIL);
    const mail = await awaitMail(PEER_EMAIL, { timeoutMs: 45_000 });
    const code = extractFromMail(mail, AUTH_CODE_RE);
    await peer.nickservAuth(code);

    // Join the shared channel so /whois 319 reports something + so
    // the upstream considers the peer reachable.
    await peer.join(CHANNEL);

    // Issue /whois from cic.
    await composeSend(page, `/whois ${peer.nick}`);

    const card = page.getByTestId("whois-card");
    await expect(card).toBeVisible({ timeout: 5_000 });

    // Header carries the target nick.
    await expect(card.locator(".whois-card-target")).toHaveText(peer.nick);

    // P-0a — the "registered" tag chip is the proof: it's only
    // rendered when `is_registered: true` arrives in the wire
    // payload, which only happens when EventRouter's 307 handler
    // folded it from the services-emitted RPL_WHOISREGNICK.
    await expect(card.locator(".whois-card-tag-registered")).toBeVisible({
      timeout: 5_000,
    });
  } finally {
    await peer.disconnect("P-0a done");
  }
});
