// BUG7-M6 — webkit + iPhone 15 variant of M6 (cicchetto-driven DM via
// `/msg`). Same iOS-shape input path as bug7-ios-own-msg-visible:
// tap-to-focus + per-keystroke type + tap send. Pins the same
// regression class — own-msg visibility post-compose-send — but on
// the DM auto-open + auto-focus path rather than the focused-channel
// path.
//
// **Outcome on Playwright iPhone 15 emulation: GREEN** (same as the
// channel-shaped sibling spec). The bug surface is real iOS Safari +
// virtual keyboard, which the headless WebKit + iPhone-15 viewport
// doesn't reproduce. This spec is now a positive guard rail for the
// iOS-shaped DM input path: tap-focus → per-keystroke type → tap send
// → auto-opened query window renders own-msg. A regression in compose
// dispatch / openQueryWindowState / WS fanout for query-kind windows
// would surface here.
//
// `@webkit` opts into the webkit-iphone-15 project.

import {
  composeTextarea,
  loginAs,
  scrollbackDistanceFromBottom,
  scrollbackLine,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const PEER_NICK = "bug7m6-peer";
const CHANNEL = AUTOJOIN_CHANNELS[0];
const MESSAGE_BODY = `BUG7-M6-ios: DM own-msg @ ${crypto.randomUUID().slice(0, 8)}`;

// Mirror of ScrollbackPane.SCROLL_BOTTOM_THRESHOLD_PX = 50 (not exported; kept
// in lockstep by hand — same as issue168 / issue580).
const SCROLL_BOTTOM_THRESHOLD_PX = 50;

test("@webkit BUG7-M6 — cicchetto /msg DM own-msg visible on iOS-shaped input", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    const ta = composeTextarea(page);
    await expect(ta).toBeVisible();

    // iOS-shape: tap to focus (triggers virtual-keyboard show on a
    // real device), per-keystroke type, tap send button.
    await ta.tap();
    await ta.pressSequentially(`/msg ${peer.nick} ${MESSAGE_BODY}`, { delay: 20 });

    const sendButton = page.getByRole("button", { name: /send message/i });
    await sendButton.tap();
    await expect(ta).toHaveValue("", { timeout: 5_000 });

    // Sidebar entry for the DM target appears (auto-open via
    // openQueryWindowState in compose.ts /msg handler).
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(1, { timeout: 5_000 });

    // First door: server persistence — same as M6 chromium.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: peer.nick,
      sender: specNick(),
      body: MESSAGE_BODY,
    });

    // Second door: own-msg visible in the auto-focused DM scrollback.
    // toBeVisible enforces the viewport-intersection check — a row
    // that's painted but virtual-keyboard-occluded fails here.
    const ownRow = scrollbackLine(page, "privmsg", MESSAGE_BODY);
    await expect(ownRow).toBeVisible({ timeout: 5_000 });

    // #608 STEP 6 STRENGTHEN — after the measured settle the OWN sent line must
    // be at the TRUE tail of the auto-focused DM, not merely attached / partially
    // on screen. `toBeVisible` passed even one line below the fold (the #608 §5
    // off-by-one); `toBeInViewport` (full intersection) + distance-to-tail within
    // threshold pin that the send tailed to the real bottom once the echo laid
    // out. NEVER weaken these, NEVER inflate the poll.
    await expect(ownRow).toBeInViewport();
    await expect
      .poll(async () => (await scrollbackDistanceFromBottom(page)) ?? 999)
      .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
  } finally {
    await peer.disconnect("BUG7-M6 done");
  }
});
