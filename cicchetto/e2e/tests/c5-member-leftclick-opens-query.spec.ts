// C5 — left-click on a member-list nick opens a query window AND switches
// focus. Companion to UserContextMenu's "Query" right-click submenu (which
// composes the same store mutations); this spec pins the keyboard-free
// one-click variant the spec calls for.
//
// Pre-conditions:
//   - vjt logged in, focused on #spec-wN (specNick() is the autojoin user;
//     IrcPeer "c5-buddy" joins and shows up in members list).
//
// Asserts:
//   - sidebar gains an entry for the buddy nick after click;
//   - selected window switches to the buddy nick (TopicBar / scrollback
//     surface keys on it);
//   - members list still renders #spec-wN (we left the channel in the
//     sidebar — close semantics for query windows is unrelated).

import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const PEER_NICK = "c5-buddy";
const CHANNEL = AUTOJOIN_CHANNELS[0];

test("C5 — left-click on member nick opens query window + switches focus", async ({ page }) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // Connect BEFORE the pre-condition so every locator below is keyed on the
  // nick the server GRANTED (#944). A connected-but-idle peer creates no
  // query window, so the pre-condition still observes the same state.
  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Pre-condition: no query window yet for the peer.
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(0);

    await peer.join(CHANNEL);

    // Wait for the peer to appear in the members list.
    const memberBtn = page.locator(`.members-pane .member-name`, { hasText: peer.nick });
    await expect(memberBtn).toBeVisible({ timeout: 5_000 });

    // Click the nick — should open the query window AND switch focus.
    await memberBtn.click();

    // Query window appears in sidebar.
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(1, { timeout: 5_000 });

    // Focus switched to the query window — sidebar entry has the
    // selection class. The exact selector matches Sidebar.tsx's
    // `.sidebar-channel-selected` (or whichever) — check the live DOM.
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveClass(/selected/, {
      timeout: 5_000,
    });
  } finally {
    await peer.disconnect("C5 done");
  }
});
