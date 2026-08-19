// #211 phase 6 — HEADLINE e2e: the two-parallel-azzurra-testnet matrix.
//
// vjt (caps his): "ALL OF THIS MUST FUCKING BE TESTED END TO END BY
// STARTING TWO FUCKING AZZURRA TESTNETS IN PARALLEL AND TESTING ALL THE
// FUCKING CASES!" — the seeder (compose.yaml) provisions THREE
// visitor_enabled networks: azzurra (autoconnect, on the bahamut-test
// leaf) + azzurra3 (NOT autoconnect, also bahamut-test), and azzurra2
// (NOT autoconnect by default) which since #211 phase 7 points at a
// SEPARATE standalone ircd `bahamut-test2` with its own nick namespace.
// azzurra2 + azzurra3 stay non-autoconnect in the shared seed so the
// per-visitor connection count stays at one (the leaf's per-IP clone
// limit can't absorb every visitor spec opening N upstreams). This spec
// drives the multi-network visitor matrix:
//
//   * autoconnect test — flips azzurra2 → visitor_autoconnect in its OWN
//     setup, then a fresh visitor login AUTO-CONNECTS BOTH azzurra +
//     azzurra2 (both attached + connected); the deep live end-to-end
//     chain (JOIN → own nick in members → peer PRIVMSG) runs on the
//     anchor here, restoring the flag in finally. The BOTH-networks-live
//     end-to-end proof (own nick in members + live PRIVMSG on EACH,
//     across a real WS reconnect) lives in the dedicated
//     issue211-phase7-multinet-reconnect spec, which uses the separate
//     bahamut-test2 ircd so the two upstreams don't contend a nick;
//   * per-network DISCONNECT (park) azzurra (after accreting azzurra2) →
//     azzurra parked, azzurra2 stays live; RECONNECT azzurra → live;
//   * a visitor one-tap CONNECTS the available azzurra3 from the home-
//     page available_networks tier (accretion).
//
// The reboot-persistence case ("park A → reboot container → A still
// parked") + the per-network-identity peer-witness case are covered by
// the server-side suite (bootstrap_test "PARKED visitor credential is NOT
// respawned"; networks_controller_test identity) — a container reboot is
// outside the Playwright harness.
//
// Runs on chromium desktop (members pane renders directly).

import type { Browser } from "@playwright/test";
import {
  bootVisitorContext,
  expectShellReady,
  selectChannel,
  waitForUserTopicReady,
} from "../fixtures/cicchettoPage";
import { GRAPPA_BASE_URL, joinChannel, mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// Two full connect chains + a peer round-trip on each network — well
// past the default; give it plenty of testnet-latency headroom.
test.setTimeout(120_000);

// Flip a network's visitor_autoconnect flag via the admin PATCH. The
// matrix's autoconnect test enables azzurra2 in its OWN setup (NOT the
// shared seed — that would double every visitor spec's upstream
// connection count and exhaust the single test leaf's per-IP clone
// limit). Restored in finally.
async function setAutoconnect(adminToken: string, slug: string, on: boolean): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/networks/${slug}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ visitor_autoconnect: on }),
  });
  if (!res.ok) {
    throw new Error(`setAutoconnect: ${slug}=${on} → ${res.status} ${await res.text()}`);
  }
}

// Poll GET /networks until it lists at least `n` rows (the async
// autoconnect fan-out settles after the sync anchor connect).
type NetworkRow = { slug: string; connection_state: string };

async function waitForNetworks(token: string, n: number): Promise<NetworkRow[]> {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${GRAPPA_BASE_URL}/networks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const rows = (await res.json()) as NetworkRow[];
      if (rows.length >= n) return rows;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForNetworks: never reached ${n} networks`);
}

test("issue #211 phase 6 — fresh visitor AUTO-CONNECTS the visitor_autoconnect set (both attached; anchor live)", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const stamp = Date.now();
  const channel = `#p6-${stamp}`;

  // Enable azzurra2 autoconnect for THIS test only (the shared seed keeps
  // it off — see the seeder comment). Mint AFTER the flip so login
  // auto-connects both azzurra (anchor, sync) + azzurra2 (async).
  await setAutoconnect(admin.token, "azzurra2", true);
  let visitor: Awaited<ReturnType<typeof mintVisitor>> | null = null;
  let ctx: Awaited<ReturnType<Browser["newContext"]>> | null = null;
  const peers: IrcPeer[] = [];

  try {
    visitor = await mintVisitor(`p6auto-${stamp}`);

    // Autoconnect ATTACHED both networks (azzurra sync anchor, azzurra2
    // async) — GET /networks shows BOTH, connection_state connected.
    const nets = await waitForNetworks(visitor.token, 2);
    const byslug = new Map(nets.map((n) => [n.slug, n]));
    expect(byslug.get("azzurra")?.connection_state).toBe("connected");
    expect(byslug.get("azzurra2")?.connection_state).toBe("connected");

    const booted = await bootVisitorContext(browser, visitor);
    await expectShellReady(booted.page);
    ctx = booted.ctx;
    const page = booted.page;
    await waitForUserTopicReady(page, `visitor:${visitor.id}`);

    // Both network sections render in the sidebar (cic mirrors both
    // autoconnected networks) — "azzurra2" is unambiguous (not a
    // prefix-substring of another seeded slug).
    await expect(
      page.locator(".sidebar-network-header").filter({ hasText: "azzurra2" }),
    ).toBeVisible({ timeout: 15_000 });

    // Deep end-to-end LIVE proof on the ANCHOR (azzurra): JOIN → own nick
    // in members → a peer PRIVMSG lands. The anchor is the network login
    // synchronously identity-proved on, so it holds the visitor's nick.
    //
    // Scope note: this test asserts the autoconnect FAN-OUT (both networks
    // attached + connection_state connected, checked above) and runs the
    // deep live chain on the anchor only. azzurra2 now lives on a SEPARATE
    // ircd (bahamut-test2, #211 phase 7) with an independent nick
    // namespace, so a genuine both-networks-live end-to-end proof (own
    // nick in members + live PRIVMSG on EACH, across a real WS reconnect)
    // is possible and is covered by the dedicated
    // issue211-phase7-multinet-reconnect spec. Keeping this test
    // anchor-only avoids opening a second live upstream in the shared
    // suite (per-IP clone-limit budget); the fan-out assertion above is
    // the autoconnect proof, the sibling spec is the both-live proof.
    await joinChannel(visitor.token, "azzurra", channel);
    await selectChannel(page, "azzurra", channel, { ownNick: visitor.nick });

    const membersPane = page.locator(".shell-members .members-pane");
    await expect(membersPane.locator(".member-name", { hasText: visitor.nick })).toBeVisible({
      timeout: 15_000,
    });

    const peer = await IrcPeer.connect({ nick: `pp6-${stamp % 100000}` });
    peers.push(peer);
    await peer.join(channel);
    const wireMsg = `p6-azzurra-${stamp}`;
    peer.privmsg(channel, wireMsg);
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="privmsg"]', { hasText: wireMsg }),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    for (const peer of peers) await peer.disconnect("e2e cleanup").catch(() => {});
    if (ctx) await ctx.close();
    // Disable autoconnect FIRST (best-effort) so the network never respawns —
    // THEN reap the visitor loud, ordered benign-before-loud (see reapVisitors).
    await setAutoconnect(admin.token, "azzurra2", false).catch(() => {});
    await reapVisitors(admin.token, visitor?.id);
  }
});

test("issue #211 phase 6 — per-network park azzurra keeps azzurra2 live; reconnect restores azzurra", async () => {
  const admin = getSeededAdmin();
  const stamp = Date.now();
  const visitor = await mintVisitor(`p6park-${stamp}`);

  try {
    // Default seed autoconnects only azzurra; accrete azzurra2 so there
    // are two live networks to prove per-network park isolation.
    await waitForNetworks(visitor.token, 1);
    const addRes = await fetch(`${GRAPPA_BASE_URL}/session/networks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${visitor.token}` },
      body: JSON.stringify({ network: "azzurra2" }),
    });
    expect(addRes.status).toBe(204);
    await waitForNetworks(visitor.token, 2);

    // Park azzurra via the subject-agnostic PATCH /networks/:id (ruling D).
    const parkRes = await fetch(`${GRAPPA_BASE_URL}/networks/azzurra`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${visitor.token}` },
      body: JSON.stringify({ connection_state: "parked", reason: "matrix" }),
    });
    expect(parkRes.status).toBe(200);
    expect((await parkRes.json()).connection_state).toBe("parked");

    // azzurra is parked; azzurra2 stays connected — GET /networks reflects it.
    const rows = (await (
      await fetch(`${GRAPPA_BASE_URL}/networks`, {
        headers: { authorization: `Bearer ${visitor.token}` },
      })
    ).json()) as Array<{ slug: string; connection_state: string }>;
    const azzurra = rows.find((r) => r.slug === "azzurra");
    const azzurra2 = rows.find((r) => r.slug === "azzurra2");
    expect(azzurra?.connection_state).toBe("parked");
    expect(azzurra2?.connection_state).toBe("connected");

    // Reconnect azzurra → connected again.
    const connRes = await fetch(`${GRAPPA_BASE_URL}/networks/azzurra`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${visitor.token}` },
      body: JSON.stringify({ connection_state: "connected" }),
    });
    expect(connRes.status).toBe(200);
    expect((await connRes.json()).connection_state).toBe("connected");
  } finally {
    await reapVisitors(admin.token, visitor.id);
  }
});

test("issue #211 phase 6 — visitor one-tap connects the AVAILABLE (non-autoconnect) azzurra3", async () => {
  const admin = getSeededAdmin();
  const stamp = Date.now();
  const visitor = await mintVisitor(`p6avail-${stamp}`);

  try {
    await waitForNetworks(visitor.token, 1);

    // azzurra3 is visitor_enabled but NOT autoconnect → not attached at
    // login. It appears in /me's home_data.available_networks.
    const me = (await (
      await fetch(`${GRAPPA_BASE_URL}/me`, {
        headers: { authorization: `Bearer ${visitor.token}` },
      })
    ).json()) as { home_data: { available_networks: Array<{ slug: string }> } };
    const availSlugs = me.home_data.available_networks.map((n) => n.slug);
    expect(availSlugs).toContain("azzurra3");

    // One-tap connect (accretion) — anon-allowed (ruling C follow-up 2).
    const addRes = await fetch(`${GRAPPA_BASE_URL}/session/networks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${visitor.token}` },
      body: JSON.stringify({ network: "azzurra3" }),
    });
    expect(addRes.status).toBe(204);

    // azzurra3 now attached (azzurra anchor + azzurra3 = 2 networks).
    const rows = await waitForNetworks(visitor.token, 2);
    expect(rows.map((r) => r.slug)).toContain("azzurra3");
  } finally {
    await reapVisitors(admin.token, visitor.id);
  }
});
