// issue 2150 — the remembered QUIT/PART message, measured where it is
// actually visible: on the wire, at a peer sitting in the same channel.
//
// WHY THIS SPEC EXISTS AND THE UNIT TESTS DO NOT SUFFICE.
//
// The feature crosses three artefacts that no single suite spans: the drawer
// writes it, the SERVER resolves it (the declared deviation — cic never puts
// the default on the wire), and a THIRD PARTY is the only one who can say
// whether it arrived. `user_settings_controller_test` proves the store;
// `channels_controller_test` proves the resolution against a fake ircd. Only
// this spec proves that the text a human typed into the drawer is the text
// another human in the channel reads when they leave.
//
// TWO ARMS, ONE TEST, and each arm names the mutant it kills:
//
//   1. stored default, no reason typed → the peer's PART line carries the
//      stored text. Kills "the value is saved and never applied", which is
//      the whole complaint the issue opens with, and which every unit test
//      on the store alone goes green on.
//   2. an EXPLICIT reason → the peer's PART line carries the explicit text
//      and NOT the stored one. Kills the inverted precedence — a resolver
//      that reads the stored value first would pass arm 1 and only arm 2
//      catches it.
//
// One test rather than two because arm 2's precondition is arm 1's
// post-state: the reason must already be stored, and re-storing it in a
// second test would be a second save able to fail for its own reasons.
//
// ⚠️ THE OBSERVER IS ARMED BEFORE THE ACTION, NEVER AFTER. `waitForLine`
// registers its listener when called, so building the promise after
// `composeSend` would race the wire and fail as a timeout — which reads like
// "the reason never arrived" and would be a lie about a working feature.
//
// ⚠️ WHAT THIS SPEC DOES NOT COVER. QUIT, deliberately. Parting a channel is
// reversible in one API call; quitting tears the session down and every spec
// after this one would inherit a disconnected subject. The QUIT arm of the
// same resolver is pinned in `networks_controller_test` against the fake
// ircd, including the wire line — so the uncovered half is uncovered HERE,
// not uncovered anywhere.

import {
  composeSend,
  loginAs,
  openSettingsDrawer,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { joinChannel, setQuitPartReason } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const WITNESS_NICK = "leave-witness";

// No regex metacharacters in either: both are interpolated into the assertion
// as literals, and a `.` or `?` here would make a wrong line match.
const STORED_REASON = "remembered by the bouncer 2150";
const EXPLICIT_REASON = "typed by hand 2150";

// The seeded subject outlives this spec on a shared upstream session, so a
// left-behind reason would silently attach itself to the PART and QUIT of
// every spec that runs after it. Cleared unconditionally, and the channel is
// re-joined because both arms leave it parted.
test.afterEach(async () => {
  const vjt = specUser();
  await setQuitPartReason(vjt.token, null).catch(() => {});
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL).catch(() => {});
});

test("2150 — the remembered leave message reaches the channel, and an explicit one beats it", async ({
  page,
}) => {
  const vjt = specUser();
  const nick = specNick();

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: nick });

  // The witness. It must be IN the channel before either PART is issued —
  // bahamut relays a PART only to the members present at that moment, so a
  // peer that joins late observes nothing and the spec would time out with
  // the feature working perfectly.
  const witness = await IrcPeer.connect({ nick: WITNESS_NICK });

  try {
    await witness.join(CHANNEL);

    // ---------------------------------------- the user types it in the drawer
    // Through the UI rather than the API on purpose: the issue's own
    // verification is client-side, and this is the half of it that survives
    // the server-side deviation — cic still OWNS the save, it just does not
    // own the application.
    //
    // The PUT is awaited rather than assumed. Without this barrier the arm
    // below could part before the write landed and read the bare form, which
    // is indistinguishable from the resolver being broken.
    const saved = page.waitForResponse(
      (res) =>
        res.url().includes("/me/settings/quit-part-reason") && res.request().method() === "PUT",
      { timeout: 10_000 },
    );
    await openSettingsDrawer(page);
    await page.getByTestId("general-settings-entry").click();
    const input = page.getByTestId("quit-part-reason-input");
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill(STORED_REASON);
    // issue 2181 — the `save` button is gone; the field commits on blur, with
    // Enter as the keyboard commit. Enter rather than a Tab-away because it
    // depends on nothing outside this field: whatever the drawer's tab order
    // becomes, the gesture this spec performs stays the one under test. The
    // PUT barrier below is what proves it actually committed — a trigger that
    // silently did nothing would time out here rather than pass.
    await input.press("Enter");
    expect((await saved).status()).toBe(200);

    await page.keyboard.press("Escape");
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: nick });

    // ------------------------------- arm 1: nothing typed, the default applies
    // Matched on WHO and WHAT VERB, asserted on the CONTENT. A pattern that
    // also encoded the expected text would turn a wrong reason into a
    // timeout ("nothing arrived") instead of a diff ("this arrived").
    const partLine = new RegExp(`^:${nick}![^ ]* PART `);
    const firstPart = witness.waitForLine(partLine, `PART by ${nick}`, 15_000);
    await composeSend(page, "/part");
    const observed = await firstPart;

    expect(observed).toContain(`PART ${CHANNEL} :${STORED_REASON}`);

    // The window going away is the server's own acknowledgement, and it is
    // the barrier the re-join below needs: re-joining while the part is still
    // in flight races bahamut's own ordering.
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 15_000 });

    // ------------------------------ arm 2: an explicit reason beats the stored
    await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: nick });

    const secondPart = witness.waitForLine(partLine, `explicit PART by ${nick}`, 15_000);
    await composeSend(page, `/part ${EXPLICIT_REASON}`);
    const explicit = await secondPart;

    expect(explicit).toContain(`PART ${CHANNEL} :${EXPLICIT_REASON}`);
    // The load-bearing half of arm 2: a resolver that consulted the store
    // first would satisfy the line above only if the two texts were equal,
    // and they are not — but an implementation that CONCATENATED them, or
    // that sent two PARTs, would. This refutes both.
    expect(explicit).not.toContain(STORED_REASON);
  } finally {
    await witness.disconnect("2150 witness done").catch(() => {});
  }
});
