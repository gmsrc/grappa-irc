// #579 — `/lusers <mask> <server>` must actually route the query to the
// named server.
//
// Bug: cic's parser was `lusers: (_verb, _rest) => ({ kind: "lusers" })`, so
// both RFC 2812 §3.4.2 arguments were discarded and every /lusers reached the
// wire as a bare LUSERS. The operator who named a server read the LOCAL
// server's counts believing they had queried the one they typed — a wrong
// answer with no error.
//
// Why this spec drives the TWO-token form and not `/lusers <mask>`:
// bahamut's `send_lusers` never `match()`es the mask (azzurra/bahamut
// src/s_serv.c:2100-2315 — `parv[1]` is never dereferenced and there is no
// `match()` in the function), so a mask ALONE has no observable effect on
// this ircd; a spec built on it would be green whether or not the fix is
// present. Routing is the observable half: `m_lusers` calls `hunt_server`
// only when BOTH tokens are present (src/s_serv.c:2085), and the server that
// answers reports ITS OWN figures via RPL_LUSERME (`m_client` / `m_server`)
// — the card's "this server" field.
//
// The assertion is a DIFFERENCE BETWEEN TWO ROUTED REPLIES, not a comparison
// against the local one. The testnet is a real mesh (hub + leaf-v4 + leaf-v6
// + services) and the bouncer's session lands on a leaf via the
// `bahamut-test` alias — but which leaf is not pinned anywhere the client can
// see, and an older spec (issue540) still describes the session as dialling
// the hub. Comparing hub-vs-leaf4 sidesteps that entirely: whichever of them
// happens to be the session's own server, the two are DIFFERENT servers, so
// their per-server counts must differ (a hub carries the leaves' links and no
// clients; a leaf carries clients and one link). Pre-#579 both commands
// reached the wire as the same bare LUSERS, so both replies came from the
// session's own server and the two snapshots were identical — this spec fails
// on that code.
//
// Per feedback_ux_e2e_mandatory: every cic UX-behavior change ships with a
// Playwright e2e via scripts/integration.sh.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Two servers that exist on the testnet mesh under these exact names: the
// hub (issue540 queries `+s hub.azzurra.chat` and matches rows) and leaf-v4
// (compose.yaml aliases it `leaf4.azzurra.chat`; m12-motd matches
// `leaf[46].azzurra.chat` in its NOTICEs). The mask is `*` — bahamut ignores
// it, and `hunt_server` reads the target from the SECOND slot, so the mask is
// only there to make the two-token frame well-formed (a server with no mask
// is `:invalid_line` server-side and unconstructible client-side).
const HUB = "hub.azzurra.chat";
const LEAF = "leaf4.azzurra.chat";

// Collapse whitespace before comparing. `toHaveText` normalizes internally,
// so comparing a raw textContent against it could report "different" for a
// pure whitespace difference — a green that proves nothing. Both sides go
// through this.
const norm = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();

// 60s — two round trips through the mesh plus login/select. bahamut caches
// LUSERS for 180s per server (LUSERS_CACHE_TIME), so the figures are stable
// within a run; the budget is for the mesh hops, not for settling.
test.setTimeout(60_000);

test("#579 — /lusers <mask> <server> routes: two named servers answer with their own counts", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const card = page.getByTestId("lusers-card");
  const thisServer = page.getByTestId("lusers-card-this-server");

  // First routed query. Pre-#579 the server token never left the browser and
  // this was a bare LUSERS answered by the session's own server.
  await composeSend(page, `/lusers * ${HUB}`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  const hubCounts = norm(await thisServer.textContent());
  expect(hubCounts).not.toBe("");

  // Second routed query, to a DIFFERENT server. The solicited gate (#248) is
  // consume-once per request, so this reply surfaces too and replaces the
  // snapshot (last-solicited-write-wins).
  await composeSend(page, `/lusers * ${LEAF}`);

  // The barrier and the assertion are the same act: poll until the per-server
  // line differs. It can only differ once the SECOND reply lands, and it can
  // only be a different value if that reply came from a different server —
  // which is the whole claim. On pre-#579 code both replies carry the local
  // server's identical figures and this times out red.
  await expect
    .poll(async () => norm(await thisServer.textContent()), { timeout: 15_000 })
    .not.toBe(hubCounts);
});
