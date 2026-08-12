// #1249 — a ban (CHANMODES type A) must never enter the channel's mode
// string. Setting `+b` used to grow the header indicator a `b`: a channel
// that is really `+nt` rendered as `+bnt`, because the server-side
// `channel_modes` cache treated every non-membership letter as a channel
// flag. The header is the user-visible face of that cache, so the fix is
// only proven here.
//
// The gesture is ONE token, `+bk <mask> <key>`, and that is deliberate:
//   - the `k` landing in the header is the barrier that the ircd accepted
//     and echoed the WHOLE token — without it, "no b in the header" would
//     also pass if the MODE had simply never arrived;
//   - the key reflected in the modal proves the dropped `b` still CONSUMED
//     its mask, so the arg list stayed aligned. A fix that skips the pop
//     keys the channel to `*!*@…` instead, and this is where that shows.
//
// vjt creates a fresh per-run channel (→ sole op, so the MODE is accepted
// and no peer is needed) and PARTs it in `finally`. jsdom/vitest cannot do
// this — it needs the live ircd MODE round-trip.

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test("#1249 — +b does not join the channel mode string, and its mask does not steal +k's param", async ({
  page,
}) => {
  const vjt = specUser();
  const channel = `#t1249-${Date.now()}`;
  const mask = `*!*@t1249-${Date.now() % 100000}.example.org`;
  const key = `s3cr3t${Date.now() % 100000}`;

  await loginAs(page, vjt);
  // Focus the autojoin channel first to confirm login + WS-ready before
  // issuing the /join (mirrors the issue240 boot order).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  try {
    // vjt creates the channel → becomes op → the ircd accepts his MODE.
    await composeSend(page, `/join ${channel}`);
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: channel }),
    ).toHaveCount(1, { timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });

    // PRE-STATE — the indicator is live and already carries the ircd's own
    // fresh-channel flags. Without this the post-gesture `not.toContainText`
    // could pass on an indicator that never rendered at all.
    const modeIndicator = page.locator(".topic-bar-modes");
    await expect(modeIndicator).toBeVisible({ timeout: 15_000 });
    await expect(modeIndicator).not.toContainText("b");
    await expect(modeIndicator).not.toContainText("k");

    // GESTURE — one token, a list mode followed by a param mode.
    await composeSend(page, `/mode ${channel} +bk ${mask} ${key}`);

    // BARRIER — the `k` arrived, so the whole token was accepted and echoed.
    await expect(modeIndicator).toContainText("k", { timeout: 15_000 });

    // THE CLAIM — the ban is a list, not a flag: no `b` in the mode string.
    await expect(modeIndicator).not.toContainText("b");

    // ARG ALIGNMENT — the key is the KEY, not the ban mask.
    await composeSend(page, `/mode ${channel}`);
    const modal = page.getByTestId("mode-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    const keyRow = modal.getByTestId("mode-param-row-k");
    await expect(keyRow).toHaveClass(/mode-modal-param-row-active/, { timeout: 15_000 });
    await expect(keyRow).toContainText(key);

    await modal.getByLabel("close modes").click();
    await expect(modal).toBeHidden({ timeout: 2_000 });
  } finally {
    await composeSend(page, `/part ${channel}`).catch(() => {});
  }
});
