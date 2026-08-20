// #476 — the per-network identity editor is available to a USER subject,
// not just a visitor, and edits the SELECTED network row live.
//
// The coverage gap this closes: the identity editor (nick/ident/realname)
// used to be gated on `isVisitor()`, hiding it from user subjects on a
// retired premise ("users have no per-network identity"). The server door
// (`PATCH /networks/:slug/identity`) and both wire types were already
// subject-agnostic; only cic's gate was a relic (#461 audit). The existing
// identity e2e (issue152) drives the editor as a VISITOR — so nothing
// proved the editor renders + applies for a USER. This spec is that proof,
// end-to-end against a live upstream.
//
// Non-destructive on the shared seeded `vjt`: APPLY-AND-RESTORE. The spec
// changes vjt's per-network nick THROUGH the editor and asserts the change
// applied LIVE (the /networks row nick flips, the "Identity applied." banner
// shows, and vjt's own new nick appears in the #spec-wN members list), THEN
// restores `vjt-grappa` in a finally so downstream specs see the seeded
// baseline. `resetSubject` (the wrapped-test auto-teardown) restores
// autojoin + scrollback but NOT the nick, so this restore is load-bearing,
// not decorative. Playwright runs workers:1/fullyParallel:false → serial →
// the apply-and-restore window can't race a parallel vjt spec.
//
// Runs on chromium desktop: the settings drawer + general sub-page render
// directly (no mobile drawer choreography), and the members-pane assertion
// is over the REST members endpoint (layout-independent), so this is a
// pure form-logic + live-upstream-effect proof.

import { loginAs, openSettingsSection } from "../fixtures/cicchettoPage";
import { GRAPPA_BASE_URL, patchNetworkConnectionState } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

// A connect gate + a live identity apply (server-side reconnect + autojoin)
// + a restore-and-reconnect in the finally — well past the default. Give it
// testnet-latency headroom.
test.setTimeout(120_000);

type NetRow = { slug: string; nick: string; connection_state: string };

async function getNetworks(token: string): Promise<NetRow[]> {
  const res = await fetch(`${GRAPPA_BASE_URL}/networks`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`getNetworks: ${res.status} ${await res.text()}`);
  return (await res.json()) as NetRow[];
}

// Set the per-network nick via the subject-agnostic door
// `PATCH /networks/:slug/identity` — the SAME door cic's editor drives. Used
// by the finally to restore the seeded baseline nick.
async function setNetworkNick(token: string, slug: string, nick: string): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/networks/${slug}/identity`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ nick }),
  });
  if (!res.ok) {
    throw new Error(`setNetworkNick: ${slug}=${nick} → ${res.status} ${await res.text()}`);
  }
}

// Poll GET /networks until `slug` reaches `state` (or throw). Gates on the
// async spawn/reconnect fan-out settling.
async function waitForNetworkState(
  token: string,
  slug: string,
  state: string,
  attempts = 60,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const rows = await getNetworks(token);
    const row = rows.find((r) => r.slug === slug);
    if (row?.connection_state === state) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForNetworkState: ${slug} never reached ${state}`);
}

// Poll GET /networks until `slug`'s LIVE session nick equals `nick`. The
// /networks nick reflects the live upstream registration, so this only
// passes once the identity apply's reconnect re-registered under the new
// nick — the server-side proof the editor's change took effect.
async function waitForNetworkNick(
  token: string,
  slug: string,
  nick: string,
  attempts = 60,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const rows = await getNetworks(token).catch(() => [] as NetRow[]);
    const row = rows.find((r) => r.slug === slug);
    if (row?.nick === nick) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForNetworkNick: ${slug} nick never became ${nick}`);
}

async function fetchMembers(token: string, slug: string, channel: string): Promise<string[]> {
  const res = await fetch(
    `${GRAPPA_BASE_URL}/networks/${slug}/channels/${encodeURIComponent(channel)}/members`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`fetchMembers: ${slug}/${channel} → ${res.status}`);
  const body = (await res.json()) as { members: Array<{ nick: string }> };
  return body.members.map((m) => m.nick);
}

// Poll members until `ownNick` is present (per feedback_e2e_visitor_members_list
// — the visible liveness proof). Tolerates transient errors mid-reconnect
// (the members endpoint may briefly 404 while the session drops + rejoins).
async function waitForOwnNickInMembers(
  token: string,
  slug: string,
  channel: string,
  ownNick: string,
  attempts = 60,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const members = await fetchMembers(token, slug, channel).catch((): string[] => []);
    if (members.includes(ownNick)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForOwnNickInMembers: ${ownNick} never appeared in ${slug}/${channel}`);
}

test("issue #476 — a USER edits its per-network identity in settings and it applies live", async ({
  page,
}) => {
  const vjt = specUser();
  const channel = AUTOJOIN_CHANNELS[0];
  if (!channel) throw new Error("issue476: AUTOJOIN_CHANNELS is empty — seed contract broken");
  const stamp = Date.now();
  // A fresh, collision-free nick each run (unique per stamp; distinct from
  // every other seeded user's nick on bahamut-test).
  const newNick = `vjt476${stamp % 100000}`;

  try {
    // ── GATE: ensure vjt is LIVE under the seeded baseline nick ──
    // Idempotent reconnect (no-op if already connected), then wait for the
    // session to be connected AND vjt-grappa to be in #spec-wN members — the
    // real "the editor's starting point is live" precondition.
    await patchNetworkConnectionState(vjt.token, NETWORK_SLUG, {
      connection_state: "connected",
    });
    await waitForNetworkState(vjt.token, NETWORK_SLUG, "connected");
    await waitForOwnNickInMembers(vjt.token, NETWORK_SLUG, channel, specNick());

    // ── BROWSER: log in as the seeded USER vjt, open the editor ──
    await loginAs(page, vjt);
    const general = await openSettingsSection(page, "general");

    // HEADLINE — the identity editor is VISIBLE for a USER subject (the
    // #476 fix; the retired isVisitor() gate would have hidden it).
    await expect(general.getByTestId("settings-section-identity")).toBeVisible({
      timeout: 10_000,
    });

    // The nick field seeds from the SELECTED network row's live nick.
    await expect(page.locator("#settings-nick")).toHaveValue(specNick(), {
      timeout: 10_000,
    });

    // #497 — single network: the whole Network row is hidden (a one-option
    // picker is noise). Neither the static label nor the selector renders; the
    // nick/realname/ident fields self-evidently target the sole network.
    await expect(general.getByTestId("settings-identity-network-label")).toHaveCount(0);
    await expect(general.getByTestId("settings-identity-network-select")).toHaveCount(0);

    // ── EDIT + APPLY: change the nick, two-tap apply (reconnect is disruptive) ──
    await page.locator("#settings-nick").fill(newNick);
    const applyBtn = general.getByTestId("settings-identity-apply");
    await applyBtn.click(); // arm
    await applyBtn.click(); // confirm

    // HEADLINE — the apply succeeds (the "Identity applied." banner), the
    // /networks row's LIVE nick flips to the new value, and vjt's own new
    // nick appears in the #spec-wN members list after the reconnect + autojoin.
    // Three independent witnesses that the USER edit reached upstream.
    await expect(general.getByTestId("settings-identity-ok")).toBeVisible({
      timeout: 20_000,
    });
    await waitForNetworkNick(vjt.token, NETWORK_SLUG, newNick);
    await waitForOwnNickInMembers(vjt.token, NETWORK_SLUG, channel, newNick);
  } finally {
    // Restore the seeded baseline nick so downstream specs see vjt-grappa.
    // resetSubject (wrapped-test teardown) does NOT touch the nick, so this
    // is the only restore. Swallow errors: a cleanup hiccup must not mask
    // the test's own assertion outcome.
    await setNetworkNick(vjt.token, NETWORK_SLUG, specNick())
      .then(() => waitForNetworkNick(vjt.token, NETWORK_SLUG, specNick()))
      .then(() => waitForOwnNickInMembers(vjt.token, NETWORK_SLUG, channel, specNick()))
      .catch(() => {});
  }
});
