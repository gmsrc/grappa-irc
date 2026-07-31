// #474 — the right rail shows server-info context on a SERVER window.
//
// #71 INC-2 made `.shell-members` a PERMANENT desktop column on every
// window kind; on a channel it shows the members pane, on a server window
// it previously showed only the RailActions button drawer. #474 fills that
// slot with per-window-kind context: on the server window, connection facts
// already in the client store (network slug, own nick, connection state,
// connected-since) rendered by `RailContext` → `ServerInfoCard`.
//
// vitest (RailContext/ServerInfoCard/duration) proves the pure dispatch +
// formatting in jsdom, but jsdom is blind to layout + the live WS-hydrated
// Network store (feedback_ux_e2e_mandatory). This chromium e2e is the
// WIRING proof: a real login over the running stack, a real server window,
// the real store-fed card. Desktop viewport → the rail column is visible
// with no drawer toggle (permanent surface), so no members-open dance.

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SERVER_WINDOW_LABEL = "Server";

test.describe("#474 server-info rail card", () => {
  test("server window rail shows slug, own nick, connection state + connected-since", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    // Precondition: the server window entry exists, then focus it.
    const serverEntry = sidebarWindow(page, NETWORK_SLUG, SERVER_WINDOW_LABEL);
    await expect(serverEntry).toHaveCount(1);
    await selectChannel(page, NETWORK_SLUG, SERVER_WINDOW_LABEL, { awaitWsReady: false });

    // The per-kind rail context surface renders on the server window.
    const card = page.locator("[data-testid=rail-server-info]");
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Header carries the network slug (the folded key IS the display).
    await expect(card.locator(".rail-server-info-title")).toHaveText(NETWORK_SLUG);

    // Facts from the live-hydrated Network store, scoped to the card so a
    // stray match elsewhere in the shell can't false-green this.
    await expect(card).toContainText(NETWORK_NICK);
    // The DB-canonical connection state — the seeded network is live
    // (cp13 S8 drives /away over it), so it reads "connected".
    await expect(card).toContainText("connected");

    // The connected-since row is present with a non-empty duration value —
    // it renders ONLY while connected (honesty rule), so its presence
    // doubles as a live-state assertion. dt "connected" → its dd holds a
    // compact duration like "4h 12m" / "45s".
    const uptimeValue = card.locator('dt:text-is("connected") + dd');
    await expect(uptimeValue).toHaveText(/\d+\s*[smhd]/);
  });
});
