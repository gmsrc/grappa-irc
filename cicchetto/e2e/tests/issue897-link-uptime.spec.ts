// #897 — the server-info card's "connected <duration>" must measure the LIVE
// IRC link, and must say nothing when there is no live link to measure.
//
// Mezmerize reported `connected 10d 9h` on an instance he was power-cycling
// daily for upgrades. The card read the credential's
// `connection_state_changed_at`, which answers a different question: when the
// ROW last changed state. `Networks.connect/1` returns without a DB write on
// an already-`:connected` row, and a restart deliberately never parks the
// credential, so that column sails through restarts the socket does not.
//
// The fix moves the anchor to `connection.connected_at` — `Session.Server`'s
// per-process stamp, inside the live-only `connection` sub-object of
// `GET /networks`. Two consequences, and this spec asserts BOTH over the real
// stack because only the real stack can produce the divergence:
//
//   1. On a live link the duration renders — proving the new anchor actually
//      travels Session.Server → wire → store → DOM, which jsdom cannot show.
//   2. With the pid stopped and the DB row left at `:connected`, the card
//      keeps reporting the DB-canonical state and reports NO duration. This
//      is the discriminator: the OLD code renders a duration here, computed
//      from a column the terminate did not touch. It is also the CLAUDE.md
//      DB-vs-live rule made visible — divergence is shown, not smoothed over.
//
// Subject choice: a freshly minted VISITOR, not a seeded user. The spec has
// to kill a session to create the divergence, and a throwaway visitor is the
// one subject whose death poisons no downstream spec on the serial stack
// (`feedback_e2e_real_login_poisons_shared_stack`); it is reaped in `finally`.
//
// Desktop viewport → the rail column is permanent (#71 INC-2), no drawer
// dance. Sibling coverage: `issue474-server-info-rail.spec.ts` (the card's
// other rows), `ServerInfoCard.test.tsx` (the pure rendering rule).

import { expect, test } from "@playwright/test";
import { bootVisitorContext, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import {
  GRAPPA_BASE_URL,
  mintVisitor,
  reapVisitors,
  terminateSession,
} from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";

const SERVER_WINDOW_LABEL = "Server";

// The composite id the admin session verbs key on. Resolved from the
// visitor's own `GET /networks` rather than assuming the seeder's
// single-network id, so the spec states its input instead of guessing it.
async function resolveNetworkId(token: string, slug: string): Promise<number> {
  const res = await fetch(`${GRAPPA_BASE_URL}/networks`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`issue897: GET /networks → ${res.status} ${await res.text()}`);
  }
  const rows = (await res.json()) as Array<{ id: number; slug: string }>;
  const row = rows.find((r) => r.slug === slug);
  if (!row) throw new Error(`issue897: visitor has no row for ${slug}`);
  return row.id;
}

test.describe("#897 server-info uptime measures the live link", () => {
  test("renders the link's uptime while up, and NO duration once the pid is gone", async ({
    browser,
  }) => {
    const admin = getSeededAdmin();
    const visitor = await mintVisitor(`e2e897-${Date.now()}`);
    const { ctx, page } = await bootVisitorContext(browser, {
      id: visitor.id,
      token: visitor.token,
      registered: false,
    });

    try {
      const networkId = await resolveNetworkId(visitor.token, visitor.network_slug);

      // ---- 1. LIVE LINK: the duration is present and is a real duration.
      await expect(sidebarWindow(page, visitor.network_slug, SERVER_WINDOW_LABEL)).toHaveCount(1, {
        timeout: 15_000,
      });
      await selectChannel(page, visitor.network_slug, SERVER_WINDOW_LABEL, {
        awaitWsReady: false,
      });

      const card = page.locator("[data-testid=rail-server-info]");
      await expect(card).toBeVisible({ timeout: 10_000 });
      await expect(card).toContainText("connected");
      // The `dt` "connected" labels the uptime row (the state word above it
      // lives in the `status` row's `dd`), so this locator is specific to the
      // duration. The visitor's link is seconds old — a fresh mint — so the
      // value is a small unit, which is itself evidence the anchor is the
      // LINK and not the long-lived seeded row.
      await expect(card.locator('dt:text-is("connected") + dd')).toHaveText(/\d+\s*[smhd]/, {
        timeout: 10_000,
      });

      // ---- 2. Kill the pid, leave the row alone.
      // `DELETE /admin/sessions/:id` is documented "force-stop the pid
      // without touching the DB row" — so the credential still reads
      // `:connected` while nothing is connected. Exactly Mezmerize's shape,
      // manufactured in one call instead of a restart.
      await terminateSession(admin.token, `visitor:${visitor.id}:${networkId}`);

      // Reload rather than waiting for a push: no state TRANSITION happened,
      // so by design there is no `connection_state_changed` event to react to
      // — which is the whole reason the stale column went unnoticed. A fresh
      // `GET /networks` is how a user coming back to the tab sees it.
      await page.reload();
      await expect(sidebarWindow(page, visitor.network_slug, SERVER_WINDOW_LABEL)).toHaveCount(1, {
        timeout: 15_000,
      });
      await selectChannel(page, visitor.network_slug, SERVER_WINDOW_LABEL, {
        awaitWsReady: false,
      });
      await expect(card).toBeVisible({ timeout: 10_000 });

      // The DB-canonical state is unchanged and still shown — the card does
      // not invent a "disconnected" it was never told about.
      await expect(card).toContainText("connected");

      // The live rows are gone, because there is no live session to describe.
      // `server` first: it is the pre-existing #474 B honesty signal, so its
      // absence proves `connection` really is null here and the uptime check
      // below is testing the intended condition rather than a mis-seeded one.
      await expect(card.locator('dt:text-is("server")')).toHaveCount(0);
      // THE point of #897: no duration. Pre-fix this row rendered, counting
      // from a timestamp the terminate never touched.
      await expect(card.locator('dt:text-is("connected")')).toHaveCount(0);
    } finally {
      await ctx.close();
      await reapVisitors(admin.token, visitor.id);
    }
  });
});
