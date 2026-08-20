// #238 — /links renders the server-mesh topology as an interactive radial SVG
// map, built ENTIRELY from the ONE server-side parse of the real Bahamut
// 364 RPL_LINKS / 365 RPL_ENDOFLINKS burst. cic never parses IRC — it consumes
// the typed `links_bundle` wire event and reconstructs the spanning tree in
// `radialLayout` (unit-tested in linksLayout.test.ts).
//
// This is the vjt-non-negotiable REAL e2e: the map must render from parsed
// numerics off the live testnet, not a hollow green spec. The azzurra testnet
// is a genuine mesh (hub + leaf-v4 + leaf-v6 + services), so /links returns a
// multi-server topology.
//
// It ALSO closes INC-1's open assumption about the 364 param order
// (node = params[1], uplink = params[2]). If that order were wrong (server /
// linked_to swapped), the de-dup-by-server-name in buildTree would COLLAPSE the
// leaves that share an uplink into a single node — the render would show ~1
// node and the tree invariant `edges === nodes - 1` over a >=2-node mesh would
// break. So the structural assertions below (>=2 nodes, exactly one root, a
// connected tree) are the ground-truth witness that the parse order is right.
//
// Full path exercised:
//   1. operator focused on a channel window (#spec-wN, seed-autojoined)
//   2. operator issues `/links` via composeSend
//   3. grappa primes links_pending + sends LINKS upstream; Bahamut replies
//      with the 364 burst; 365 RPL_ENDOFLINKS flushes the `links_bundle` event
//   4. cic dispatches it into the linksModal store; LinksModal renders the map

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("#238 — /links renders the topology map from the real 364/365 burst", async ({ page }) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // Issue /links FROM the channel window. grappa sends LINKS upstream; Bahamut
  // replies with the 364 burst; 365 flushes the typed bundle.
  await composeSend(page, "/links");

  const modal = page.getByTestId("links-modal");
  await expect(modal).toBeVisible({ timeout: 8_000 });

  // The interactive SVG canvas paints (NOT the empty "hides topology" state —
  // the azzurra testnet is a real linked mesh).
  await expect(page.getByTestId("links-modal-svg")).toBeVisible();
  await expect(page.getByTestId("links-modal-empty")).toHaveCount(0);

  // Nodes rendered from the parsed numerics. A real mesh has >= 2 servers (the
  // leaf grappa is on + at least its hub). If the 364 param order were swapped,
  // de-dup would collapse this toward a single node.
  const nodes = page.getByTestId("links-modal-node");
  const nodeCount = await nodes.count();
  expect(nodeCount).toBeGreaterThanOrEqual(2);

  // Ground-truth log of the discovered topology (server names off the wire).
  const servers = await nodes.evaluateAll((els) => els.map((el) => el.getAttribute("data-server")));
  // Ground-truth breadcrumb for the #364 param-order verification. (`noConsole`
  // is not in biome's recommended set, so the suppression this line used to
  // carry was itself flagged as unused once e2e/ entered the lint scope.)
  console.log(`[#238] LINKS topology (${nodeCount} servers):`, servers);

  // Every node carries a non-empty server name (a real hostname, not garbage).
  for (const s of servers) {
    expect(s).toBeTruthy();
  }

  // Tree invariants — the witness that the spanning tree reconstructed cleanly
  // from the `linked_to` uplinks: EXACTLY one root, and a connected tree of N
  // nodes has N-1 edges (a param swap that orphaned/forked nodes breaks this).
  await expect(page.locator(".links-modal-node-root")).toHaveCount(1);
  const edgeCount = await page.locator(".links-modal-edge").count();
  expect(edgeCount).toBe(nodeCount - 1);

  // Interactive: clicking a node opens the detail footer with its server name.
  const first = nodes.first();
  const firstServer = await first.getAttribute("data-server");
  await first.click();
  const detail = page.getByTestId("links-modal-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(firstServer ?? "");

  // Dismiss via the × control.
  await page.getByLabel("close links").click();
  await expect(modal).toBeHidden();
});
