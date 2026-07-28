// #513a — a /links MASK that matches nothing must render "no server matches
// <mask>", NOT the "this network hides its topology" restricted-network copy.
//
// This is the REAL e2e the issue calls for: on the azzurra testnet (bahamut) a
// mask that matches no server name (`all` — the exact shape Mezmerize reported)
// is answered LITERALLY with a bare 365 RPL_ENDOFLINKS and zero 364 rows. Pre-
// #513 the bundle drained `entries: []` and cic fell through to "hides its
// topology / restricted to operators" — both lines false for a mask miss. The
// fix carries the requested mask on the `links_bundle` wire event
// (server→wire→cic) so the empty state splits: a non-null mask that matched
// nothing says so; only a null-mask (bare `/links`) empty is the restricted
// guess. The companion `links238-modal` spec proves the bare full-mesh path
// still renders the map — this one proves the mask miss no longer lies.
//
// Runs against the live upstream (a bare 365 must actually come back from
// bahamut), which jsdom/vitest cannot do — per feedback_cicchetto_browser_smoke.

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// A mask that matches no server on the testnet mesh → bahamut answers with a
// bare 365 (zero 364). `all` is the exact token the bug was reported against.
const NO_MATCH_MASK = "all";

test("#513a — /links <mask matching nothing> shows 'no server matches', not 'hides topology'", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // grappa sends `LINKS all` upstream; bahamut replies with a bare 365 (the
  // mask matched nothing); 365 flushes an EMPTY bundle CARRYING mask="all".
  await composeSend(page, `/links ${NO_MATCH_MASK}`);

  const modal = page.getByTestId("links-modal");
  await expect(modal).toBeVisible({ timeout: 8_000 });

  // The empty state renders — but the MASK-MISS variant, not the restricted
  // one. `data-empty-reason` is the server-authoritative discriminator (driven
  // by the wire `mask`), asserted alongside the human copy.
  const empty = page.getByTestId("links-modal-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toHaveAttribute("data-empty-reason", "no-match");
  await expect(empty).toContainText("no server matches");
  await expect(empty).toContainText(NO_MATCH_MASK);
  // The pre-#513 lie MUST NOT appear for a mask miss.
  await expect(empty).not.toContainText("hides its topology");
  // No SVG canvas on an empty topology (empty state replaces it).
  await expect(page.getByTestId("links-modal-svg")).toHaveCount(0);

  await page.getByLabel("close links").click();
  await expect(modal).toBeHidden();
});
