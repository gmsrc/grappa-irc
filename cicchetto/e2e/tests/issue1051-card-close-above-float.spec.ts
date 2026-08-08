// @webkit — #1051. On a non-channel window the floating ☰ painted over the ✕
// of the top-pinned lookup cards (WHOIS / WHOWAS / LUSERS), so the card could
// not be dismissed.
//
// Same corner, same root cause as #1050, opposite remedy. The cards mount in
// `.scrollback-overlay` (#133, top-pinned, `pointer-events: none` on the
// container and `auto` per card) and each card's ✕ is `margin-left: auto` in
// its header — the card's top-right. `.shell-chrome` floats its lone ☰ into
// that same corner at `z-index: 41` (#985). The overlay was at 5, so 41 > 5 and
// the ☰ won the hit test. #1050 could delete the row because /list does not
// want the rail; a server or query window DOES (bucket L — on mobile this ☰ is
// the only door to settings), so here the overlay is raised instead, to 42.
// vjt's ruling: the card wins, because if a card is open the intent is to close
// it, and closing it uncovers the ☰ anyway.
//
// WHY AN E2E. The stacking NUMBERS are pinned in
// `src/__tests__/shellChromeFloat.test.ts` — including the guard that fails if
// the overlay ever drops back under the float, which the pre-existing
// `40 < z(.shell-chrome) < 89` assertion could not do. What a source-level
// guard cannot answer is the one thing the operator felt: which element is
// actually under the finger. jsdom has no layout engine and no hit testing.
//
// WHY A QUERY WINDOW and not the `$server` one vjt reported from: the issue's
// own measurement says the radius is EVERY non-channel window — the gate is
// `Shell.tsx:920`, not a server-specific branch — and the query window has a
// proven mobile driver in `issue985-mobile-floating-opener`. Same branch, same
// float, fewer moving parts.
//
// Mobile-only shape (`ShellChrome` mounts once, in Shell's `isMobile()`
// branch), so webkit-iphone-15 alone via @webkit.
//
// Parity per `feedback_e2e_user_class_parity_matrix`: a UI shape contract with
// no subject-shaped branch. The registered seed suffices.

import {
  composeSend,
  loginAs,
  selectChannel,
  waitForQueryWindowReady,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const PEER = `F1051${crypto.randomUUID().slice(0, 7)}`;
const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(90_000);

test("@webkit #1051 — on a non-channel window the card's ✕ is the topmost element at its own coordinates", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER });
  try {
    await peer.join(CHANNEL);
    await composeSend(page, `/q ${PEER}`);
    await waitForQueryWindowReady(page, NETWORK_SLUG, PEER);

    // PRECONDITION — we are on the NON-channel branch, the only one that
    // floats the ☰. Without this the whole test could pass on a channel
    // window, where the opener rides in the TopicBar and nothing ever
    // overlapped: every assertion below would be green for the wrong reason.
    await expect(page.locator(".topic-bar")).toHaveCount(0);
    const opener = page.getByTestId("shell-chrome-rail-opener");
    await expect(opener).toBeVisible({ timeout: 10_000 });

    await composeSend(page, `/whois ${PEER}`);
    const card = page.locator(".scrollback-overlay").getByTestId("whois-card");
    await expect(card).toBeVisible({ timeout: 15_000 });

    const closeBtn = card.locator(".whois-card-close");
    await expect(closeBtn).toBeVisible();

    // THE COLLISION IS REAL, not hypothetical. Assert the two boxes actually
    // intersect before asserting who wins — otherwise a layout change that
    // simply moved them apart would leave this spec green while retiring the
    // thing it guards, and the z-index could quietly go back to 5.
    const openerBox = await opener.boundingBox();
    const closeBox = await closeBtn.boundingBox();
    if (!openerBox || !closeBox) {
      throw new Error("#1051 — a measured element has no bounding box");
    }
    const overlaps =
      openerBox.x < closeBox.x + closeBox.width &&
      closeBox.x < openerBox.x + openerBox.width &&
      openerBox.y < closeBox.y + closeBox.height &&
      closeBox.y < openerBox.y + openerBox.height;
    expect(
      overlaps,
      "#1051 — the ☰ and the card's ✕ must still share the corner for this guard to mean anything",
    ).toBe(true);

    // THE OUTCOME. At the ✕'s own centre, the topmost element is the ✕ —
    // pre-fix this resolved to the floated ☰, which is precisely why the card
    // could not be dismissed.
    const hit = await closeBtn.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return top === el || el.contains(top);
    });
    expect(hit, "#1051 — the floated ☰ must not paint over the card's ✕").toBe(true);

    // …and the tap therefore does what it says. Playwright's hit-target check
    // would fail here on an intercepted pointer, so this is the user-visible
    // half of the same claim.
    await closeBtn.tap();
    await expect(card).toHaveCount(0, { timeout: 10_000 });

    // THE OTHER HALF OF THE RULING. Raising the overlay must not have buried
    // the rail: with the card gone the ☰ is reachable again, which is what
    // makes "the card wins" acceptable in the first place (bucket L survives —
    // unlike #1050, this window keeps its door).
    await opener.tap();
    await expect(page.locator(".shell-members.open")).toBeVisible({ timeout: 10_000 });
  } finally {
    await peer.disconnect("i1051 cleanup").catch(() => {});
  }
});
