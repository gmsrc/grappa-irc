// #510 — `/join #a,#b` must focus the FIRST channel, never a phantom
// window literally named "#a,#b".
//
// The server handles the RFC1459 comma-list correctly (#382): it splits
// the list, canonical-folds + validates each element, and opens a
// `:pending → :joined` window PER channel. cic forwards the list unsplit
// (the POST body is the whole "#a,#b") — that part is right. The bug was
// purely client-side focus: compose.ts fed the RAW unsplit string to
// `setSelectedChannel`, so focus landed on a key ("#a,#b") that no
// `window_states` entry ever matches → an empty, topic-less phantom pane
// (header "#a,#b  (no topic set)", composer placeholder "message #a,#b").
//
// The fix splits on `,` and focuses the first element, canonicalised the
// SAME way the server folds window keys (`canonicalChannel`, the
// `Identifier.canonical_channel/1` twin). This spec proves the focus
// contract end-to-end: BOTH real rows join from one command, focus lands
// on #a, and the "#a,#b" phantom is never created.
//
// jsdom/vitest proves the compose.ts split+fold (compose.test.ts #510);
// this needs the live ircd multi-target JOIN round-trip + the real
// selection→ComposeBox render to prove the phantom is gone in a browser.
//
// vjt creates two fresh per-run channels via ONE `/join #x,#y` (→ sole op
// of each) and PARTs both in `finally`, keeping the shared testnet tidy.

import { composeSend, composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test("#510 — /join #a,#b focuses #a, never a phantom '#a,#b' window", async ({ page }) => {
  const vjt = specUser();
  const stamp = Date.now();
  const chanA = `#t510a-${stamp}`;
  const chanB = `#t510b-${stamp}`;

  await loginAs(page, vjt);
  // Focus the autojoin channel first to confirm login + WS-ready before the
  // /join (mirrors issue382 / issue240 boot order).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  try {
    // ONE comma-list command → server sends ONE multi-target JOIN line.
    await composeSend(page, `/join ${chanA},${chanB}`);

    // The DEFINITIVE phantom check. Focus AUTO-lands on the FIRST channel
    // (no manual click); the active ComposeBox placeholder reflects the
    // focused window (`composePlaceholder` → "message <chan>"). Pre-#510 the
    // focus key was the raw "#a,#b" list, so the placeholder read
    // "message #a,#b" — the empty phantom window. This assertion FAILS
    // pre-fix and passes post-fix. (A sidebar-row check would be hollow: cic
    // never originates window state and the server emits window_pending per
    // CANONICAL channel, so the literal "#a,#b" never becomes a row — the
    // phantom was the focused PANE, not a sidebar entry.)
    await expect(composeTextarea(page)).toHaveAttribute("placeholder", `message ${chanA}`, {
      timeout: 15_000,
    });

    // BOTH real channels joined from the ONE command: each sidebar row
    // resolves to :joined — selectChannel with ownNick requires the
    // per-channel self-JOIN line + WS-ready seam, which only a resolved
    // :joined window satisfies (a greyed :pending/:failed never does).
    await selectChannel(page, NETWORK_SLUG, chanB, { ownNick: specNick() });
    await selectChannel(page, NETWORK_SLUG, chanA, { ownNick: specNick() });
  } finally {
    // Explicit-channel /part parts each regardless of focus (both are fresh
    // per-run channels, so cleanup keeps the shared testnet tidy).
    await composeSend(page, `/part ${chanA}`).catch(() => {});
    await composeSend(page, `/part ${chanB}`).catch(() => {});
  }
});
