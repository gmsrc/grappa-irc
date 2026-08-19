// #1152 — the fixture's nick and the session's nick are two different
// things, and the suite only ever knew the first one.
//
// `provisionSpecSubject` asks for `nick: <name>`. If that nick is taken at
// the moment the session registers, #676's fallback ladder
// (`auth_fsm.ex`) re-registers as `<name>_` — and then as two random
// suffixes — with nothing raised: grappa even writes the substitution into
// the scrollback in plain words. `specNick()` kept answering `<name>`, so
// every `privmsg(specNick(), …)` in the suite addressed a nick the subject
// did not hold. The DM went to whoever DID hold it, the spec's own
// assertion timed out, and the failure looked like a flake.
//
// In the wild the trigger is a RACE: the nick is held by the previous
// test's not-yet-reaped ghost. This spec DISPLACES that trigger — a
// squatter takes the nick deliberately while the session is parked — so
// the same 433 arrives on every run instead of on unlucky ones. The race
// itself is not reproduced here and is not claimed to be.
//
// What is pinned, in order:
//   1. pre-state — requested and live agree, and the live reading is
//      OBSERVABLE (without this the divergence below could be read as
//      "these two never agreed", and the guard in `fixtures/test.ts` could
//      be vacuous without anybody noticing);
//   2. the divergence — after the squatted registration the live nick is
//      NOT the requested one;
//   3. that `specLiveNick()` follows it, product-side: a DM addressed to
//      the live nick lands in the subject's scrollback;
//   4. that a DM addressed to the REQUESTED nick does not — asserted only
//      after (3) has fired, so the absence is a measurement and not an
//      empty read (#1336's rule).

import {
  assertMessagePersisted,
  fetchAllMessagesAsc,
  patchNetworkConnectionState,
} from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, readSpecLiveNick, specLiveNick, specUser, test } from "../fixtures/test";

// Per-run-unique: bahamut lingers a ghosted nick after disconnect, so a
// fixed literal 433s the peer itself on a rapid rerun.
const PEER_NICK = `n1152p${crypto.randomUUID().slice(0, 6)}`;
const LIVE_BODY = "#1152 addressed to the live nick";
const REQUESTED_BODY = "#1152 addressed to the requested nick";

test("a squatted registration moves the live nick, and specLiveNick() follows it", async () => {
  // `specUser().name` and NOT `specNick()`: the provision asks for
  // `nick: name`, so the account name IS the requested nick, at the
  // source. Reading it through `specNick()` would ALSO be reading it as
  // an address, and the teardown guard would rightly redden this spec for
  // addressing a nick the subject stops holding two lines later. The
  // squat below wants the string, not the address.
  const requested = specUser().name;
  const token = specUser().token;

  // (1) PRE-STATE. `kind: "live"` is half the assertion: it proves the
  // subject has a session whose nick can be read at all, which is the same
  // condition the teardown guard needs to be non-vacuous.
  const before = await readSpecLiveNick();
  expect(before, "no live nick before the squat — the guard would be vacuous").toMatchObject({
    kind: "live",
    nick: requested,
  });

  // Park first so the squatter takes the nick uncontested, rather than
  // racing the live session for it.
  await patchNetworkConnectionState(token, NETWORK_SLUG, { connection_state: "parked" });
  const squatter = await IrcPeer.connect({ nick: requested });
  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    const tReconnect = Date.now();
    await patchNetworkConnectionState(token, NETWORK_SLUG, { connection_state: "connected" });

    // BARRIER, and it has to be a causal one. The first version of this
    // bench polled `connection_state == "connected"` and read the nick 35 ms
    // BEFORE the reconciliation landed — `connection_state` is INTENT, not
    // liveness, and is already "connected" while the FSM is still walking
    // the 433 ladder. It went green, cleanly, on a defect that was there.
    //
    // The autojoin JOIN is strictly downstream of registration and happens
    // in BOTH worlds — diverged nick or not — so waiting on it is causal
    // without presupposing the answer the way waiting on the nick would.
    await expect
      .poll(
        async () => {
          const rows = await fetchAllMessagesAsc(token, NETWORK_SLUG, AUTOJOIN_CHANNELS[0]);
          return rows.some((r) => r.kind === "join" && r.server_time >= tReconnect);
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    // (2) THE DIVERGENCE. Not pinned to `<name>_` on purpose: the ladder's
    // later rungs are random, and the defect is the divergence, not its
    // spelling.
    const live = await specLiveNick();
    expect(live, "the squatted 433 did not move the session's nick").not.toBe(requested);

    // (3) + (4). Both DMs go out on ONE socket, requested-first, and only
    // then is the live one waited for. That order is what turns the absence
    // into a measurement rather than an empty read: bahamut processed the
    // first send before the second, and our session processes what reaches
    // it in order — so once the second has persisted, the first one's fate
    // is settled and "not there" means "never routed here".
    peer.privmsg(requested, REQUESTED_BODY);
    peer.privmsg(live, LIVE_BODY);

    // POSITIVE CONTROL — the live nick is the one that reaches us.
    await assertMessagePersisted({
      token,
      networkSlug: NETWORK_SLUG,
      channel: peer.nick,
      sender: peer.nick,
      body: LIVE_BODY,
    });

    // …and the requested nick is not: that DM went to the squatter.
    const rows = await fetchAllMessagesAsc(token, NETWORK_SLUG, peer.nick);
    expect(rows.map((r) => r.body)).not.toContain(REQUESTED_BODY);
  } finally {
    await peer.disconnect("#1152 done");
    await squatter.disconnect("#1152 done");
  }
});
