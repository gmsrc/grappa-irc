// Issue #126 (P0) — lifecycle verbs detach / disconnect / reconnect /
// quit, standardized across user + NickServ-visitor + ephemeral.
//
// This spec owns the two VISIBLE, ISOLATABLE outcomes (the rest of the
// matrix is covered by the server SessionController test + the cic
// lifecycle/SettingsDrawer vitest, because a *registered* visitor in the
// e2e testnet needs the full NickServ REGISTER dance — out of scope for a
// stable browser gate):
//
//   1. EPHEMERAL VISITOR GATING — a minted (anon, no NickServ identity)
//      visitor's rail actions menu offers ONLY "quit": no "detach", no
//      "disconnect"/"reconnect", and the retired "log out" label is gone.
//      RED before #126 (an ephemeral visitor saw a single "log out"
//      button and no `quit-irc-btn`). #986 moved the surface from the
//      settings drawer to the rail and put a confirm modal in front of the
//      verb; the GATE is the same question, so this test follows it there —
//      and now also pins the modal copy that gate earns, since an anon
//      visitor is the one subject whose quit DESTROYS the session.
//
//   2. USER DETACH KEEPS THE BOUNCER (bug #1 + #2) — after a user detaches
//      via the rail, the web session ends (back to /login) but the
//      server-side Session.Server + upstream IRC connection STAY UP: the
//      autojoin channel is still `joined` server-side. RED before #126
//      (logout called stop_all_user_sessions, tearing the upstream down →
//      the channel would read `joined: false`, and the credential stayed
//      `:connected` while the pid was gone — the desync).
//
// The user-detach test mints a SECOND bearer for this spec's own subject
// (grappaApi.login), NOT the one the fixture handed it, so revoking it on
// detach still leaves the test a live token to probe with. The afterEach
// reconnects the subject's network defensively (a pre-#126 RED run of
// this spec would tear its session down).

import { bootVisitorContext, loginAs, openRailMenu } from "../fixtures/cicchettoPage";
import {
  GRAPPA_BASE_URL,
  login,
  mintVisitor,
  patchNetworkConnectionState,
  reapVisitors,
} from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specUser, test } from "../fixtures/test";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];

// Build a loginAs-shaped seed from a FRESH login of THIS spec's subject
// (own bearer + subject), so detach revokes only this token and not the
// one the fixture minted at provision time — the test asserts the
// session outlives a revoked bearer, so it needs a second, disposable
// one.
async function freshSubjectSeed(): Promise<{
  name: string;
  password: string;
  identifier: string;
  token: string;
  subjectJson: string;
}> {
  const spec = specUser();
  const { token, subject } = await login(spec.identifier, spec.password);
  return {
    name: subject.name,
    password: spec.password,
    identifier: spec.identifier,
    token,
    subjectJson: JSON.stringify(subject),
  };
}

async function channelJoined(token: string, slug: string, channel: string): Promise<boolean> {
  const res = await fetch(`${GRAPPA_BASE_URL}/networks/${slug}/channels`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return false;
  const channels = (await res.json()) as Array<{ name: string; joined: boolean }>;
  return channels.find((c) => c.name === channel)?.joined === true;
}

test.describe("issue #126 — detach lifecycle", () => {
  test.afterEach(async () => {
    // A pre-#126 (RED) run of the user-detach test tears this spec
    // subject's Session.Server down (stop_all_user_sessions). Reconnect
    // defensively so the rest of THIS test's body still has a live
    // autojoin. Post-#126 detach keeps the session, so this is a no-op
    // (already connected → :not_connected, swallowed).
    const subject = specUser();
    await patchNetworkConnectionState(subject.token, NETWORK_SLUG, {
      connection_state: "connected",
    }).catch(() => {});

    // Wait for the autojoin to land again so the next spec doesn't race a
    // half-spawned session (same pattern as cp15-b6-parked-disconnect).
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await channelJoined(subject.token, NETWORK_SLUG, SEED_CHANNEL)) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  test("ephemeral visitor settings offers ONLY quit (no detach/disconnect, no 'log out')", async ({
    browser,
  }) => {
    const visitor = await mintVisitor(`e2e126-${Date.now()}`);
    // ephemeral: no NickServ identity → not registered
    const { ctx, page } = await bootVisitorContext(browser, {
      id: visitor.id,
      token: visitor.token,
      registered: false,
    });

    try {
      await openRailMenu(page);

      // The ONLY lifecycle verb an ephemeral visitor gets is quit.
      await expect(page.getByTestId("quit-irc-btn")).toBeVisible();
      await expect(page.getByTestId("quit-irc-btn")).toHaveText(/quit/i);
      // Persistent-identity verbs are withheld …
      await expect(page.getByTestId("detach-btn")).toHaveCount(0);
      await expect(page.getByTestId("disconnect-btn")).toHaveCount(0);
      await expect(page.getByTestId("reconnect-btn")).toHaveCount(0);
      // … and the retired "log out" label is gone (positive twin so a
      // testid typo can't silently green this).
      await expect(page.getByText(/^log out$/i)).toHaveCount(0);

      // #986 — and the copy in front of that verb must be the ANON one. This
      // is the subject the issue was filed for: the server hard-deletes an
      // unregistered visitor row on the way out (Visitors.purge_if_anon →
      // destroy_visitor, CASCADE), so the modal has to say so BEFORE the tap.
      // Asserted against a REAL minted anon visitor rather than a stubbed
      // subject — the vitest can fake `registered: false`, only this can
      // prove the shipped client classifies a real one that way. Cancel:
      // this session is torn down by the finally block, not by the modal.
      await page.getByTestId("quit-irc-btn").click();
      await expect(page.getByTestId("confirm-modal-body")).toHaveText(/deletes it/i);
      await expect(page.getByTestId("confirm-modal-body")).not.toHaveText(/survive/i);
      await page.getByTestId("confirm-modal-cancel").click();
      await expect(page.getByTestId("confirm-modal")).toHaveCount(0);
    } finally {
      await ctx.close();
      // Tear down the throwaway visitor's row + session (loud — see reapVisitors).
      const admin = (await import("../fixtures/seedData")).getSeededAdmin();
      await reapVisitors(admin.token, visitor.id);
    }
  });

  test("user detach keeps the upstream session up (bug #1 + #2)", async ({ page }) => {
    const seed = await freshSubjectSeed();

    // Baseline: the autojoin channel is live server-side.
    expect(await channelJoined(seed.token, NETWORK_SLUG, SEED_CHANNEL)).toBe(true);

    await loginAs(page, seed);

    // Detach via the rail — #986 put a confirm modal in front of the verb,
    // so the affirmative is what actually fires it. The web session then
    // ends (back to /login) …
    await openRailMenu(page);
    await page.getByTestId("detach-btn").click();
    await expect(page.getByTestId("confirm-modal-body")).toHaveText(/keeps running/i);
    await page.getByTestId("confirm-modal-confirm").click();
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

    // … but the bouncer STAYS UP: the upstream Session.Server survived, so
    // the autojoin channel is still joined server-side (a SEPARATE fresh
    // bearer proves it without depending on the just-revoked token).
    // Pre-#126 detach tore the session down → this would read false.
    const probe = await freshSubjectSeed();
    let stillJoined = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      stillJoined = await channelJoined(probe.token, NETWORK_SLUG, SEED_CHANNEL);
      if (stillJoined) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(stillJoined).toBe(true);
  });
});
