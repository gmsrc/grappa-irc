// BUGHUNT-1 B (#473 rework) — archive reachable + populated via the rail.
//
// Pre-#473 this pinned a mobile-specific bug: the ShellChrome archive
// chip (`[data-testid="shell-chrome-archive"]`) called
// `setArchiveModalNetwork(slug)` but NOT `loadArchive(slug)`, so the
// modal opened empty until an `archive_changed` re-fetch. #473
// redesigned the archive into ONE grouped `ArchiveModal` reached via the
// always-on `mobile-panel-archive` button in the RailActions rail, on
// BOTH form factors. Rows now load LAZILY per network group on expand
// (the group's `<details onToggle>` fires `loadArchive(slug)`) — there is
// no "seed on modal open" step left to get wrong.
//
// This spec pins that the PARTed channel is REACHABLE + VISIBLE through
// the modal on each form factor: test 1 on mobile (@webkit — the only
// archive door there, via the rail drawer), test 2 on desktop (chromium —
// the same modal, same rail; there is no separate desktop Sidebar
// `<details>` any more). openArchive is viewport-aware (mobile: open rail
// → tap archive; desktop: tap archive directly); expandArchiveGroup
// triggers the lazy per-group load.
//
// `@webkit` tag opts into the iPhone-15 project (mobile viewport +
// touch + isMobile() = true). Desktop chromium project skips the tagged
// test via `grepInvert: /@webkit/`.

import {
  expandArchiveGroup,
  loginAs,
  openArchive,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.afterEach(async () => {
  // Restore the seed-time joined state so later specs that assume
  // #spec-wN is joined keep working under retries. Mirror of cp15-b4.
  const vjt = specUser();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
});

test("@webkit @touch BUGHUNT-1 B — mobile rail archive shows the row on expand", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Select the channel + PART it so there's a guaranteed archive
  // entry to populate the group with. selectChannel awaits the WS
  // join confirmation so we know the channel is live before PART.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(1);

  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);

  // Wait for the channel to leave the active sidebar (channels_changed
  // propagated) before reaching for the archive.
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });

  // openArchive (mobile) opens the rail drawer then taps
  // mobile-panel-archive → the grouped ArchiveModal — the only archive
  // door on mobile. expandArchiveGroup expands the seeded network's group,
  // whose `<details onToggle>` lazy-loads its rows. The PARTed channel
  // must appear: the reachability + lazy-load pin for the mobile door.
  await openArchive(page);
  const group = await expandArchiveGroup(page, NETWORK_SLUG);
  await expect(group.locator(".archive-modal-row", { hasText: CHANNEL })).toHaveCount(1, {
    timeout: 5_000,
  });
});

test("BUGHUNT-1 B — desktop rail archive shows the row on expand", async ({ page }) => {
  // Desktop chromium path (no @webkit tag = stays in default project).
  // The archive is the SAME grouped modal on desktop, reached via the
  // always-on rail — there is no separate desktop Sidebar `<details>` any
  // more. Pins that the lazy per-group load path works on desktop too.
  const vjt = specUser();
  await loginAs(page, vjt);

  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });

  // openArchive (desktop) taps the rail archive button directly;
  // expandArchiveGroup lazy-loads the group. The PARTed channel is listed.
  await openArchive(page);
  const group = await expandArchiveGroup(page, NETWORK_SLUG);
  await expect(group.locator(".archive-modal-row", { hasText: CHANNEL })).toHaveCount(1, {
    timeout: 5_000,
  });
});
