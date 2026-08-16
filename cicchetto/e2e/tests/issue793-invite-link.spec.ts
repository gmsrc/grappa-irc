// #793 — a shareable invite link, `irc.sindro.me/?go=<network>/<channel>`, is
// a URL you can paste to a normal person: they click it, they are ASKED, and
// they land in the channel.
//
// What is proven here is the user-visible chain, end to end against the live
// bahamut-test leaf, not the existence of a parser:
//   1. Opening the app AT the invite URL pops the shared ConfirmModal naming
//      the channel; confirming JOINs it and switches to the window. The
//      address bar is left clean once the invite is spent, so a refresh does
//      not re-fire it.
//   2. An invite to a channel we are already in switches straight there with
//      NO modal (#648's rule: asking to join an open window is noise).
//   3. An invite naming a network this account has not bound joins nothing
//      and says so — the branch #793 leaves open (cross-user network
//      identity) must be a visible dead end, never a silent one.
//
// `?go=` is a query param on `/`, deliberately: vjt asked for it in those
// words so an invite could never collide with a client route. The first
// shipment used `/<network>/<channel>` instead and had to keep a denylist of
// reserved first segments to stay out of `/share`'s way. Nothing here
// depends on the path any more, which is the property that made the denylist
// unnecessary.

import type { Page } from "@playwright/test";
import {
  confirmModal,
  confirmModalBody,
  confirmModalYes,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { joinChannel, listChannelNames, partChannel, type SeededUser } from "../fixtures/grappaApi";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specUser, test } from "../fixtures/test";

// Lowercase throughout: raw == ASCII-folded, so the sidebar window key (the
// folded key IS the display) equals the spelling asserted on. The raw-vs-
// folded split of the invite value itself is pinned by the inviteLink unit
// test (`#BoFH`), which is the cheaper place for a casing matrix.
const freshChannel = (label: string) => `#i793${label}-${crypto.randomUUID().slice(0, 6)}`;

// Links are written by hand — there is no generator in the product, by vjt's
// ruling — so this helper IS the canonical spelling, and it is the shape the
// docs quote. The channel travels WITHOUT its `#` (a literal `#` starts the
// fragment and the value would truncate; the parser implies the sigil), and
// each component is encoded on its own so the `/` separator survives.
const inviteUrl = (networkSlug: string, channel: string) =>
  `/?go=${encodeURIComponent(networkSlug)}/${encodeURIComponent(channel.replace(/^#/, ""))}`;

// Auth is pre-seeded the way `loginAs` does it, but the navigation target is
// the invite URL rather than `/` — `loginAs` always gotos the bare root.
async function openInvite(page: Page, vjt: SeededUser, path: string): Promise<void> {
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [vjt.token, vjt.subjectJson] as const,
  );
  await page.goto(path);
}

test("an invite link asks, then joins and switches (#793)", async ({ page }) => {
  const vjt = specUser();
  const target = freshChannel("join");

  await openInvite(page, vjt, inviteUrl(NETWORK_SLUG, target));

  // Discriminating probe: the invite reader sets this only after it has
  // ROUTED a parsed target, so the assertions below cannot pass off the back
  // of an unrelated session-restore selection.
  await page.waitForFunction(() => window.__cicInviteLinkApplied === true, null, {
    timeout: 15_000,
  });

  // The consent gate. A URL must never join anybody silently.
  await expect(confirmModal(page)).toBeVisible({ timeout: 10_000 });
  await expect(confirmModalBody(page)).toHaveText(`Join ${target}?`);

  // Address bar already clean — the invite is spent, a refresh re-fires
  // nothing. Asserted BEFORE the confirm so it is the reader being tested,
  // not some later navigation. The `?go=` is dropped by the SAME step that
  // routes the target, so waiting on the applied flag is what makes this
  // deterministic rather than a poll against a boot-time rewrite.
  expect(new URL(page.url()).pathname).toBe("/");
  expect(new URL(page.url()).search).toBe("");

  await confirmModalYes(page);

  try {
    await expect(sidebarWindow(page, NETWORK_SLUG, target)).toHaveClass(/selected/, {
      timeout: 15_000,
    });
    // Count-0, not not-visible: an absent node satisfies toBeVisible's
    // negation for the wrong reason.
    await expect(confirmModal(page)).toHaveCount(0);
  } finally {
    await partChannel(vjt.token, NETWORK_SLUG, target);
  }
});

test("an invite to a channel we are already in switches with NO modal (#793)", async ({ page }) => {
  const vjt = specUser();
  const already = freshChannel("have");

  // The PRECONDITION is "already in the channel", so it has to be true before
  // the link is opened — not merely requested. `joinChannel` returns when the
  // POST is accepted; the channel appears in the list cic reads at boot once
  // the upstream JOIN lands. Waiting on the list makes this a test of the
  // invite's already-in branch instead of a race against the join.
  await joinChannel(vjt.token, NETWORK_SLUG, already);
  await expect
    .poll(() => listChannelNames(vjt.token, NETWORK_SLUG), { timeout: 20_000 })
    .toContain(already);

  try {
    await openInvite(page, vjt, inviteUrl(NETWORK_SLUG, already));
    await page.waitForFunction(() => window.__cicInviteLinkApplied === true, null, {
      timeout: 15_000,
    });

    await expect(sidebarWindow(page, NETWORK_SLUG, already)).toHaveClass(/selected/, {
      timeout: 15_000,
    });
    await expect(confirmModal(page)).toHaveCount(0);
  } finally {
    await partChannel(vjt.token, NETWORK_SLUG, already);
  }
});

test("an invite for an unbound network joins nothing and says so (#793)", async ({ page }) => {
  const vjt = specUser();

  await openInvite(page, vjt, inviteUrl("nowhere-bound", "somechannel"));
  await page.waitForFunction(() => window.__cicInviteLinkApplied === true, null, {
    timeout: 15_000,
  });

  await expect(page.locator(".toast-stack .toast")).toContainText("nowhere-bound", {
    timeout: 10_000,
  });
  // No consent was asked for, because there is nothing to consent to.
  await expect(confirmModal(page)).toHaveCount(0);
});
