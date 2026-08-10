// #348 — the auto-away debounce is a per-user knob, and turning it has
// to change what other people see.
//
// Until this, the grace period between "every device of mine is hidden"
// and the upstream `AWAY` was one compile-time constant for the whole
// deployment. The ask was a per-user setting with an off state, and the
// two claims worth an e2e are the ones no unit test can make:
//
//   1. the bouncer waits the value the user PICKED IN THE UI, not the
//      deployment's own default;
//   2. changing it reaches a session that is already running — no
//      reconnect, no restart.
//
// Both are asserted the way a human would notice them: through a peer's
// WHOIS, which shows `301 RPL_AWAY` exactly when the network thinks the
// user is away. The knob is driven through the settings control, not
// through the REST endpoint — the control is half of what #348 shipped.
//
// Three of the four assertions here are NEGATIVE ("not away yet", "away
// cleared", "off means never"), and a negative read off a line stream is
// worthless: no-301-heard is also what a dead peer, a throttled reply and
// a nick that never registered all look like. So every question is a
// complete WHOIS round-trip ending in `318 RPL_ENDOFWHOIS`
// (`IrcPeer.whoisAway`) — the peer asked, the network answered, and the
// answer did or did not carry a 301. Silence is an error, never a verdict.
//
// The integration env sets the deployment default SHORT
// (`config/dev.exs`, `auto_away_debounce_ms: 2_000`) so the #671 spec
// need not wait ten minutes. That number is what makes this spec's
// oracle sharp: a CUSTOM value well above it can be told apart from the
// default, because an answered "still present" long after 2s can only
// mean the preference is in force.
//
// Per `feedback_ux_e2e_mandatory`: server behaviour a client observes,
// so it ships with a Playwright e2e via scripts/integration.sh.

import { loginAs, openSettingsDrawer, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { setPageVisibility } from "../fixtures/push";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const PEER_NICK = "i348-away-watcher";
const CHANNEL = AUTOJOIN_CHANNELS[0];

// The custom delay this spec configures. Chosen far above the
// integration default (2s) so "not away yet" is evidence the preference
// won, and low enough that the whole spec stays under a minute.
const CUSTOM_DEBOUNCE_SECONDS = 12;

// Long enough past the 2s deployment default that an AWAY here would
// mean the preference was ignored; far enough below the 12s preference
// that it cannot be the preference firing early.
const PAST_DEFAULT_MS = 6_000;

// The budget for the preference itself to fire, clocked from the END of
// the window above rather than from the hide — the two run back to back,
// so the preference has already spent PAST_DEFAULT_MS of its 12s by the
// time this one opens. Sized as a generous ceiling on a condition-wait,
// not as a second measurement of the delay: the claim "longer than the
// deployment default" is made by the window above, and pinning an upper
// bound on the delay too would only add a way to go red on a slow host.
const PREFERENCE_BUDGET_MS = 20_000;

// How long "never" gets to prove itself. Four times the deployment
// default, on a run that has already shown this harness CAN see an AWAY.
const OFF_WINDOW_MS = 8_000;

// Cadence of the round-trips inside a window. Unchanged from the WHOIS
// poll this replaced, so the command load on bahamut's per-connection
// fake-lag bank is the same as before.
const WHOIS_POLL_MS = 2_000;

// "Was the bouncer away at any point inside this window?"
//
// Every answer is a COMPLETED WHOIS round-trip (`IrcPeer.whoisAway`), so a
// `false` here means the network was asked and answered "present" — not
// that nothing was heard. That distinction is what makes the three
// negative assertions below worth anything: watching the line stream for
// a 301 reports the same silence whether auto-away correctly held off,
// or the peer died, or bahamut throttled the reply. Three of this spec's
// four assertions want `false`, so silence must never be able to produce
// it — a peer that stops answering now throws.
//
// The final probe is taken AT the end of the window, so a `false` verdict
// speaks about the window's closing instant and not some earlier moment
// inside it.
async function awayWithin(peer: IrcPeer, nick: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await peer.whoisAway(nick)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(WHOIS_POLL_MS, remaining)));
  }
}

test("#348 — the bouncer waits the delay the user picked, and honours a change made live", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const vjt = specUser();
  const nick = specNick();

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: nick });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });

  const saveViaControl = async (act: () => Promise<void>) => {
    const saved = page.waitForResponse(
      (res) =>
        res.url().includes("/me/settings/auto-away-debounce-seconds") &&
        res.request().method() === "PUT",
      { timeout: 10_000 },
    );
    await act();
    const res = await saved;
    expect(res.status()).toBe(200);
  };

  try {
    // ---- the user picks a custom delay, in the UI -----------------------
    await openSettingsDrawer(page);
    await page.getByTestId("general-settings-entry").click();

    const select = page.getByTestId("auto-away-select");
    await expect(select).toBeVisible({ timeout: 5_000 });
    await select.selectOption("custom");

    await saveViaControl(async () => {
      await page.getByTestId("auto-away-custom-input").fill(String(CUSTOM_DEBOUNCE_SECONDS));
      await page.getByTestId("auto-away-custom-save").click();
    });

    // Close the drawer so the page is a normal session again before the
    // visibility flip (an open drawer is not what a backgrounded phone
    // looks like, and the flip is the thing under test).
    await page.keyboard.press("Escape");

    // ---- hiding starts the clock the USER set ---------------------------
    await setPageVisibility(page, false);

    // Pre-state: past the deployment's own 2s default and still present.
    // If the preference were ignored, the AWAY would already be up — so
    // this is the assertion that the knob, not the default, is in force.
    expect(await awayWithin(peer, nick, PAST_DEFAULT_MS)).toBe(false);

    // ...and the preference does fire. Without this the check above would
    // be satisfied by an auto-away that is simply broken.
    expect(await awayWithin(peer, nick, PREFERENCE_BUDGET_MS)).toBe(true);

    // ---- coming back clears it ------------------------------------------
    // Not decoration: "present again, upstream" is the durable pre-state
    // the OFF phase needs, and it is established by a round-trip the
    // network answered rather than assumed from the visibility flip.
    await setPageVisibility(page, true);
    await expect.poll(() => peer.whoisAway(nick), { timeout: 20_000 }).toBe(false);

    // ---- switching OFF reaches the RUNNING session ----------------------
    // No reload, no reconnect: the same page, the same upstream session
    // that just demonstrated it can go away.
    await openSettingsDrawer(page);
    await page.getByTestId("general-settings-entry").click();
    await saveViaControl(async () => {
      await page.getByTestId("auto-away-select").selectOption("off");
    });
    await page.keyboard.press("Escape");

    await setPageVisibility(page, false);

    // With auto-away off the bouncer arms nothing at all, so this window
    // — four times the deployment default, on a session that went away
    // in this very test — stays clear.
    expect(await awayWithin(peer, nick, OFF_WINDOW_MS)).toBe(false);
  } finally {
    await peer.disconnect("#348 spec done");
  }
});
