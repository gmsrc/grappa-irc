// #1192 — the nick context menu's CTCP submenu.
//
// The machinery has been shipped since #591: `/ctcp` works typed, the server
// classifies the reply, the echo renders. What #1192 added is the way IN, so
// what has to be proven here is exactly the part jsdom cannot see — that a real
// right-click in a real browser reaches a real IRC peer.
//
// Three arms, each of which can fail on its own:
//
//   1. The drill-down. Clicking the group row replaces the item list with the
//      six verbs instead of invoking anything; the top level is gone and the
//      back row brings it back. The unit tests pin the mechanism against stubbed
//      rects — this pins that it survives the portal, the backdrop and the #487
//      measured placement in a browser that actually paints.
//   2. The wire. The peer itself witnesses `\x01VERSION\x01`. This is the arm
//      that makes the spec more than a DOM tour: a menu that opened beautifully
//      and dispatched nothing would pass every other assertion here.
//   3. The #640 shape. The echo lands in the SOURCE window and no query tab is
//      minted for the peer — a CTCP probe is a control surface, not the start
//      of a conversation.
//
// Untagged (chromium), like the #487 spec it shares a menu with: this is a
// right-click affordance, and the mobile long-press door onto the SAME shell is
// covered by #1067's spec.

import type { Page } from "@playwright/test";
import { loginAs, scrollbackLine, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// The six verbs the menu offers. Not imported from src: this is the CONTRACT
// the operator sees, and a spec that read the same constant the component reads
// would agree with it no matter what either one said.
const VERBS = ["VERSION", "TIME", "PING", "CLIENTINFO", "USERINFO", "SOURCE"];

const menuItem = (page: Page, label: string) =>
  page.locator(".context-menu .context-menu-item", { hasText: label });

test("#1192 — the CTCP submenu drills down and puts a real VERSION probe on the wire", async ({
  page,
}) => {
  const vjt = specUser();
  // Per-run unique nick: the test network persists across runs and a fixed nick
  // is a 433/ghost time bomb under CI rerun (mirrors #591/#637/#641).
  const peer = await IrcPeer.connect({ nick: `m1192-${crypto.randomUUID().slice(0, 5)}` });

  try {
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    await peer.join(CHANNEL);
    const memberRow = page.locator(".members-pane .member-name", { hasText: peer.nick });
    await expect(memberRow).toBeVisible({ timeout: 15_000 });

    await memberRow.click({ button: "right" });
    await expect(page.locator(".context-menu")).toBeVisible({ timeout: 5_000 });

    // ARM 1 — the group row NAVIGATES. Asserting WHOIS is gone is the half that
    // makes this non-trivial: a submenu appended to the existing list would show
    // the verbs too, and only the disappearance of the top level proves the list
    // was replaced rather than extended.
    await expect(menuItem(page, "CTCP ▸")).toBeVisible();
    await menuItem(page, "CTCP ▸").click();
    for (const verb of VERBS) {
      await expect(menuItem(page, verb)).toBeVisible();
    }
    await expect(menuItem(page, "WHOIS")).toHaveCount(0);

    // …and the back row is a real way out, not decoration.
    await menuItem(page, "‹ CTCP").click();
    await expect(menuItem(page, "WHOIS")).toBeVisible();
    await menuItem(page, "CTCP ▸").click();

    // ARM 2 — arm the peer-side wire witness BEFORE the click, so the listener
    // cannot miss a frame that arrives faster than the assertion is attached.
    const sawCtcp = peer.waitForLine(
      new RegExp(`PRIVMSG ${peer.nick} :\x01VERSION\x01`),
      "CTCP VERSION frame at the peer",
      15_000,
    );
    await menuItem(page, "VERSION").click();
    await sawCtcp;

    // The menu closes on an ACTION, unlike on the group row.
    await expect(page.locator(".context-menu")).toHaveCount(0);

    // ARM 3 — the echo renders in the SOURCE window (the channel we are looking
    // at), naming the recipient, with no \x01 anywhere near the DOM.
    const echo = scrollbackLine(page, "privmsg", `→ CTCP VERSION to ${peer.nick}`);
    await expect(echo).toBeVisible({ timeout: 15_000 });
    expect(await echo.textContent()).not.toContain("\x01");

    // #640 — and NO query tab for the peer. A probe that minted a conversation
    // window is the regression this shape exists to prevent.
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(0);
  } finally {
    await peer.disconnect("#1192 done");
  }
});
