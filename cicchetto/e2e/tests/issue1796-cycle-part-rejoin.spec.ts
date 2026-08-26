// #1796 — `/cycle [<channel>] [<message>]`: the CHANNEL bounce, irssi's CYCLE.
//
// Asserts the VISIBLE outcome of BOTH legs, in the window the operator typed
// in: a PART line carrying the message they typed, then a second self-JOIN
// line for the SAME channel, and a live sidebar row at the end.
//
// COUNTED, not merely matched. The testnet does not reset between specs and
// the scrollback is persistent, so #spec-wN already carries at least one
// self-JOIN line — and possibly several, since `cp15-b6-part-archive-rejoin`
// parts and re-joins the same channel. Each assertion is therefore "one MORE
// than the count this spec observed before it typed anything", which is
// order-independent and survives `--repeat-each`.
//
// The message is a bare sigil-less word ON PURPOSE: it is the #1208 trap.
// `/cycle brb` must part THIS window with the reason "brb" — not manufacture a
// channel named `brb` — and the cure is that `/cycle` shares `/part`'s parser
// arm rather than owning a second copy of the sigil rule. Under that
// regression the DELETE and the JOIN both go to a phantom `brb`, so BOTH
// counts below stay flat and both assertions fail. Asserting only the JOIN
// would pass with the part leg aimed anywhere.
//
// FOCUS is part of what is asserted, implicitly and deliberately: parting the
// focused window drops it from `channelsBySlug`, and selection.ts's UX-4
// bucket E picker moves focus off it. Both locators read the VISIBLE
// scrollback, so they only reach their counts once the join leg has put the
// operator back in the channel — which is the behaviour `cycleCommand`
// inherits from `joinCommand`.
//
// Cleanup: the spec's own end state IS the seed state (joined), so the
// afterEach is defensive — it only matters if the run died between the legs.

import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { joinChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const CYCLE_MESSAGE = "brb";

test.afterEach(async () => {
  const vjt = specUser();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL).catch(() => {});
});

test("#1796 — /cycle parts the current channel with its message, then rejoins it", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const selfJoins = page
    .locator('[data-testid="scrollback-line"][data-kind="join"]')
    .filter({ hasText: specNick() })
    .filter({ hasText: CHANNEL });
  const selfParts = page
    .locator('[data-testid="scrollback-line"][data-kind="part"]')
    .filter({ hasText: specNick() })
    .filter({ hasText: CHANNEL })
    .filter({ hasText: CYCLE_MESSAGE });

  const joinsBefore = await selfJoins.count();
  const partsBefore = await selfParts.count();

  await composeSend(page, `/cycle ${CYCLE_MESSAGE}`);

  // Leg 1 — the PART reached THIS channel and carried the typed message.
  await expect(selfParts).toHaveCount(partsBefore + 1, { timeout: 20_000 });
  // Leg 2 — the JOIN came back, to the same channel.
  await expect(selfJoins).toHaveCount(joinsBefore + 1, { timeout: 20_000 });

  // End state: a live sidebar row, not an archived one. `/cycle` that parts
  // and fails to rejoin leaves the operator out of the channel with a green
  // compose box, which is the failure mode worth naming.
  const row = sidebarWindow(page, NETWORK_SLUG, CHANNEL);
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  await expect(row.locator(".sidebar-window-greyed")).toHaveCount(0);
});
