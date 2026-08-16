// Session-sharing — end-to-end Playwright flow, parameterized over
// subject class (#1306).
//
// What this covers, per class:
//   1. The subject is loaded into device A.
//   2. It mints a share-token from the Settings drawer → the share
//      MODAL (#392, reverts #335's sub-page) shows the share URL + QR.
//   3. A second browser context opens the URL → ShareConsume route
//      auto-consumes → cic navigates into Shell.
//   4. BOTH contexts stay connected as the SAME subject:
//      - device A still alive (NOT a transfer).
//      - device B's persisted subject is the same identity.
//   5. A third context reopening the link gets 410 — one-shot.
//
// Why this matters: this is the user-visible promise of the feature.
// Vitest jsdom can't see the live multi-context fan-out; the e2e
// harness is the only place to assert "device A still has its bearer
// after device B redeems."
//
// #1306 — this was a one-class spec ("visitor-only by design, the mint
// endpoint 403s for users"). The mint serves a user now, so per
// `feedback_e2e_user_class_parity_matrix` the flow is ONE spec looped
// over the classes rather than a second file: the assertions are
// identical, and a duplicated file is how one class silently keeps an
// assertion the other loses. What differs per class is provisioning
// device A and naming the identity device B must land on — that is the
// whole content of `SHARE_CLASSES`.
//
// Incognito stays excluded (#363); issue363-incognito owns that arm.

import type { Browser, Page } from "@playwright/test";
import { expectShellReady, openSettingsDrawer } from "../fixtures/cicchettoPage";
import { mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { getSeededAdmin, getSeededVjt } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

type ShareIdentity = {
  // What device A boots with.
  token: string;
  subjectJson: string;
  // What device B must resolve to. `kind` + `id` are what the consume
  // envelope carries for both classes.
  expectKind: string;
  expectId: string;
  // Class-specific teardown (a minted visitor has to be reaped; the
  // seeded user is permanent and must NOT be).
  cleanup: () => Promise<void>;
};

type ShareClass = {
  label: string;
  provision: () => Promise<ShareIdentity>;
};

const SHARE_CLASSES: ShareClass[] = [
  {
    label: "visitor",
    provision: async () => {
      const admin = getSeededAdmin();
      const visitor = await mintVisitor(`share-${Date.now()}`);
      return {
        token: visitor.token,
        subjectJson: JSON.stringify({ kind: "visitor", id: visitor.id }),
        expectKind: "visitor",
        expectId: visitor.id,
        cleanup: () => reapVisitors(admin.token, visitor.id),
      };
    },
  },
  {
    label: "registered user",
    provision: async () => {
      // The seeded user, loaded exactly as the visitor arm loads its
      // minted one — NO real `POST /auth/login` from the browser, which
      // would mint a live Session.Server on the shared testnet and
      // cascade-poison downstream specs. The consume DOES mint a second
      // bearer row for this user; that is the feature, and it is inert
      // (a session row, not an upstream connection).
      const vjt = getSeededVjt();
      const subject = JSON.parse(vjt.subjectJson) as { kind: string; id: string };
      return {
        token: vjt.token,
        subjectJson: vjt.subjectJson,
        expectKind: "user",
        expectId: subject.id,
        cleanup: async () => {},
      };
    },
  },
];

// Load an identity into a fresh context the way cic expects to find it
// at boot, and open the app.
async function bootDeviceA(browser: Browser, identity: ShareIdentity): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [identity.token, identity.subjectJson] as const,
  );
  await page.goto("/");
  return page;
}

for (const shareClass of SHARE_CLASSES) {
  test(`session-sharing (${shareClass.label}) — mint on device A, consume on device B, both connected`, async ({
    browser,
  }) => {
    const identity = await shareClass.provision();

    const pageA = await bootDeviceA(browser, identity);
    const ctxA = pageA.context();

    // Device B: starts with NO bearer — a fresh device opening the
    // share link cold.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();

    try {
      // Open Settings drawer → click the share entry → the share
      // MODAL (#392, reverts #335's sub-page) opens and mints on open.
      // #1306 — for the user class, the entry being VISIBLE at all is
      // half the assertion: it was hidden before.
      await openSettingsDrawer(pageA);
      await expect(pageA.getByRole("dialog", { name: /settings/i })).toBeVisible();
      await pageA.getByTestId("share-session-entry").click();
      await expect(pageA.getByTestId("share-modal")).toBeVisible();

      // Wait for the URL to materialize after the mint request resolves.
      const urlInput = pageA.getByTestId("share-url");
      await expect(urlInput).toBeVisible();
      await expect(urlInput).not.toHaveValue("", { timeout: 10_000 });

      const shareUrl = await urlInput.inputValue();
      expect(shareUrl).toMatch(/\/share#/);

      // Device B navigates to the share URL. The ROUTE is a plain path
      // (`@solidjs/router` v0.16 is path-mode, and the SPA fallback
      // serves it); only the TOKEN is in the fragment (#1404), which
      // `goto` carries across because the browser keeps it client-side.
      const sharePath = shareUrl.replace(/^https?:\/\/[^/]+/, "");
      await ctxB.addInitScript(() => {
        localStorage.setItem("cic.installChoice", "browser");
      });
      await pageB.goto(sharePath);

      // ShareConsume mounts, runs the consume call, and navigates to /
      // on success. The page transition can happen so fast the share-
      // consume route never renders for a measurable instant — we
      // therefore assert on the post-redirect Shell surface directly
      // (the settings button is stable across desktop + mobile).
      await expectShellReady(pageB);
      // No error rendered: a failure would keep the share-consume page
      // mounted with the error visible.
      await expect(pageB.getByTestId("share-consume-error")).toHaveCount(0);

      // Device B's persisted subject IS device A's identity — same kind,
      // same id. For the user class this is what proves the consume read
      // the users table and not the visitors one: a wrong branch would
      // have 404'd before ever reaching Shell.
      const subjectB = await pageB.evaluate(() => localStorage.getItem("grappa-subject"));
      expect(subjectB).not.toBeNull();
      const parsedB = JSON.parse(subjectB ?? "{}") as { kind: string; id: string };
      expect(parsedB.kind).toBe(identity.expectKind);
      expect(parsedB.id).toBe(identity.expectId);

      // Device B's OWN bearer resolves to the same identity server-side.
      // The localStorage check above only proves what the response said;
      // this proves the minted bearer actually authenticates as it — and
      // that it is a DIFFERENT bearer, i.e. a real second session.
      const tokenB = await pageB.evaluate(() => localStorage.getItem("grappa-token"));
      expect(tokenB).not.toBeNull();
      expect(tokenB).not.toBe(identity.token);
      const meB = await pageB.evaluate(async (t) => {
        const r = await fetch("/me", { headers: { authorization: `Bearer ${t}` } });
        return (await r.json()) as { kind: string; id: string };
      }, tokenB ?? "");
      expect(meB.kind).toBe(identity.expectKind);
      expect(meB.id).toBe(identity.expectId);

      // …and the same PER-NETWORK identity, which is where the nick
      // actually lives (#211 phase 7 took it off the subject envelope).
      // Compared device-to-device rather than against a seeded constant:
      // the live nick is the authority, and a spec that ran before this
      // one may legitimately have changed it.
      const nicksBySlug = async (page: Page, bearer: string) =>
        await page.evaluate(async (t) => {
          const r = await fetch("/networks", { headers: { authorization: `Bearer ${t}` } });
          const rows = (await r.json()) as Array<{ slug: string; nick: string }>;
          return Object.fromEntries(rows.map((n) => [n.slug, n.nick]));
        }, bearer);

      const nicksA = await nicksBySlug(pageA, identity.token);
      const nicksB = await nicksBySlug(pageB, tokenB ?? "");
      expect(Object.keys(nicksB).length).toBeGreaterThan(0);
      expect(nicksB).toEqual(nicksA);

      // Device A's token + subject UNCHANGED — this is sharing, not
      // transfer. The original bearer must still be present, and a
      // /me probe from inside pageA returns 200.
      const tokenA = await pageA.evaluate(() => localStorage.getItem("grappa-token"));
      expect(tokenA).toBe(identity.token);

      const meStatusA = await pageA.evaluate(async (t) => {
        const r = await fetch("/me", { headers: { authorization: `Bearer ${t}` } });
        return r.status;
      }, identity.token);
      expect(meStatusA).toBe(200);

      // Reopening the same share URL on a third context fails with
      // 410 share_token_consumed — one-shot semantics, unchanged by
      // #1306 (the ledger keys on the token, not on the subject kind).
      const ctxC = await browser.newContext();
      const pageC = await ctxC.newPage();
      try {
        await ctxC.addInitScript(() => {
          localStorage.setItem("cic.installChoice", "browser");
        });
        await pageC.goto(sharePath);
        await expect(pageC.getByTestId("share-consume-error")).toBeVisible({ timeout: 10_000 });
        await expect(pageC.getByTestId("share-consume-error")).toHaveText(/share_token_consumed/);
      } finally {
        await ctxC.close();
      }
    } finally {
      await ctxA.close();
      await ctxB.close();
      await identity.cleanup();
    }
  });
}
