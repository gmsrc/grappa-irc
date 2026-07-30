// #540 — `/who` with extended (bahamut) flag args, end-to-end. Two
// independent breaks, both surfaced here against the live bahamut hub:
//
//   A. The cic `/who` parser kept only the FIRST token, so `/who +s <server>`
//      reached the wire as `WHO +s` — bahamut's `s` flag needs a server arg,
//      so with the arg eaten it answered 522 ERR_WHOSYNTAX and NO modal
//      opened. The fix forwards the full argument string (and the server no
//      longer folds it as a channel), so `WHO +s <server>` reaches upstream
//      and the WhoModal renders.
//
//   B. A raw `/quote WHO +s <server>` primes no accumulator server-side, so
//      the 352/315 replies were dropped silently (no error, no output) — the
//      documented workaround for A failing too. The fix lazily creates the
//      accumulator on the first unsolicited 352 and drains it on 315.
//
// vjt (network `bahamut-test`) dials the hub (bahamut-test:6667 →
// hub.azzurra.chat), so `+s hub.azzurra.chat` matches at least vjt itself —
// but per the #221 who-mask precedent the headline proof is that the modal
// OPENS (feedback), not a specific matched row (bahamut cloaks hosts and the
// membership varies).

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// The bahamut hub the default `bahamut-test` network dials (compose.yaml:
// hub on 6667, SERVER_NAME hub.azzurra.chat). vjt is a client of it, so a
// server-scoped WHO matches at least vjt.
const HUB_SERVER = "hub.azzurra.chat";

test("#540 A — /who +s <server> forwards flag args and opens the WhoModal (not pre-#540 522)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Pre-#540 the parser dropped the server arg → `WHO +s` → 522
  // ERR_WHOSYNTAX → no modal. Now the full arg string forwards verbatim and
  // bahamut answers with 352 rows + 315, so the modal renders.
  await composeSend(page, `/who +s ${HUB_SERVER}`);

  const modal = page.getByTestId("who-modal");
  await expect(modal).toBeVisible({ timeout: 8_000 });
});

test("#540 B — raw /quote WHO +s <server> surfaces the WhoModal (no longer a silent hole)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // The raw escape hatch a user reaches for when part A blocks them. It
  // primes no accumulator server-side; pre-#540 the 352/315 burst was
  // dropped (no error, no output). Now the first unsolicited 352 lazily
  // creates the accumulator and the 315 drains it → modal opens.
  await composeSend(page, `/quote WHO +s ${HUB_SERVER}`);

  const modal = page.getByTestId("who-modal");
  await expect(modal).toBeVisible({ timeout: 8_000 });
});
