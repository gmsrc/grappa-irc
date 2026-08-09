// #1063 acceptance 3 — the operator finds out what the Refresh they pressed did.
//
// The unit tests pin the DECISION (`bundleRefreshNotice.test.ts`) and the
// button-level wiring (`errorBanners.test.ts`). Neither can pin the CHAIN.
// jsdom has no service worker, no precache and no navigation, so there the
// reload is a function that was called, and "the marker survives the reload"
// is asserted by writing to `sessionStorage` and reading it back in the SAME
// document. This file is the only place that claim is actually tested: a real
// press, a real `performRefresh` (real SW update, real cache purge), a real
// navigation, and a real `Toasts` mount in the document that comes out the
// other side.
//
// THE PAIR IS THE POINT. Same gesture, same code; the only thing that differs
// is whether the bundle underneath moved:
//
//   * nothing moved → "Still on <label>"    ← #1063's complaint, and new
//   * bundle moved  → "Updated to <label>"  ← #775's toast, now also on the
//                                             MANUAL path (the behaviour
//                                             change #1063 accepted by ruling)
//
// Either test alone would still pass with a formatter that ignored the
// outcome and said one thing always. Together they cannot.
//
// Not duplicated from `issue1063-update-delivery.spec.ts`: that file is
// acceptance 5 (does a stale client reach the new bundle at all) and states
// what a real browser cannot witness. This one is about what the operator is
// TOLD, which is a different claim and reachable in full.
//
// TIMING, stated because it is the one coupling worth knowing about: a toast
// self-expires after `TOAST_MS` (6s), so the assertion has to be polling
// already when the reloaded document mounts. It is — there is no wait between
// the navigation and the `expect`, which starts before the SPA has even
// booted. Nothing here sleeps, and nothing here may be "fixed" by sleeping.

import type { Page } from "@playwright/test";
import { snapshotBundle, swapToBootableBundleB } from "../fixtures/bundleSwap";
import {
  awaitServerBundleHashPush,
  awaitServiceWorkerActive,
  loginAs,
} from "../fixtures/cicchettoPage";
import { expect, specUser, test } from "../fixtures/test";

// #119 — the refresh banner is a slot in the stacked error region.
const BANNER_SELECTOR = '.error-banner[data-source="bundle-refresh"]';
const REFRESH_BUTTON = /refresh|new version/i;

// The update-toned row in the single toast stack (Toasts.tsx). Scoped to the
// tone so a presence toast in flight cannot satisfy it.
const TOAST_TEXT = ".toast-update .toast-text";

// IMPORTANT: keep in lockstep with `SHORT_HASH_LEN` in `src/lib/bundleHash.ts`.
// Asserting on the hash the label carries is what makes these assertions about
// the bundle actually running rather than about a fixed string.
const SHORT_HASH_LEN = 7;

// The two literal sentences the operator reads. Hard-coded on purpose: the
// wording IS the deliverable here, and a spec that computed it from the same
// formatter under test would agree with any wording at all.
function stillOn(hash: string): RegExp {
  return new RegExp(`^Still on .*\\(${hash.slice(0, SHORT_HASH_LEN)}\\)$`);
}

function updatedTo(hash: string): RegExp {
  return new RegExp(`^Updated to .*\\(${hash.slice(0, SHORT_HASH_LEN)}\\)$`);
}

async function bootHashOf(page: Page): Promise<string> {
  const hash = await page.evaluate(() => window.__cic_bundleHash?.bootHash() ?? null);
  expect(hash, "boot hash must be readable from index.html").toBeTruthy();
  return hash as string;
}

/** Log in, get past the SW's own reload, and let the real `bundle_hash` push land. */
async function readyOnBundleA(page: Page): Promise<string> {
  await loginAs(page, specUser());
  // Both are load-bearing and both are documented at their definition: the SW
  // does one reload of its own after claiming, and the server pushes the REAL
  // hash on every user-topic join, which would overwrite a synthetic set after
  // the fact.
  await awaitServiceWorkerActive(page);
  await awaitServerBundleHashPush(page);

  // PRE-STATE. Nothing has been announced yet, so a toast seen later cannot be
  // a leftover from login or from the service worker's own reload.
  await expect(page.locator(TOAST_TEXT)).toHaveCount(0);

  return bootHashOf(page);
}

/** Press the banner's Refresh and wait for the navigation it eventually causes. */
async function pressRefresh(page: Page): Promise<void> {
  const banner = page.locator(BANNER_SELECTOR);
  await expect(banner).toBeVisible();
  // `performRefresh` is async — SW update, up to 2s of `controllerchange`,
  // then the cache purge, and only then the navigation. Arm the wait BEFORE
  // the click so we capture that navigation instead of racing it.
  await Promise.all([
    page.waitForEvent("framenavigated", { timeout: 15_000 }),
    banner.getByRole("button", { name: REFRESH_BUTTON }).click(),
  ]);
}

test("#1063 — a Refresh that moves nothing says what it is still running", async ({ page }) => {
  const bootHash = await readyOnBundleA(page);

  // THE DIST IS NOT TOUCHED. Only the server-advertised hash moves, which is
  // exactly the shape of the complaint: the client is told an update exists
  // and the reload does not land on one. A real deploy the precache refuses to
  // give up is indistinguishable from here — that is the point, and it is why
  // the toast below states what it is running instead of diagnosing why.
  await page.evaluate(() => {
    window.__cic_bundleHash?.setServerHash("i1063NoSuchBundleOnDisk");
  });

  await pressRefresh(page);

  // The whole feature, in the user's terms: the page came back, and it said so.
  // Before #1063 this press was silent and the identical banner simply
  // reappeared — indistinguishable from a mis-tap, which is the three-presses
  // complaint from the other side.
  await expect(page.locator(TOAST_TEXT)).toHaveText(stillOn(bootHash));

  // ...and the premise held. Without this the assertion above could be green
  // for the wrong reason (a bundle that DID move and a mislabelled toast).
  expect(await bootHashOf(page), "the bundle must not have moved").toBe(bootHash);
});

test("#1063 — a Refresh that lands on a new bundle names the new one", async ({ page }) => {
  const snap = await snapshotBundle();
  try {
    const bootHash = await readyOnBundleA(page);

    // A bundle B that BOOTS — see `swapToBootableBundleB` on why the inert
    // stub cannot serve here: a page that never boots mounts no `Toasts` and
    // so can never make the announcement this test is waiting for.
    const { newHash, oldHash } = await swapToBootableBundleB();
    expect(oldHash).toBe(bootHash);
    expect(newHash).not.toBe(oldHash);

    // Mirror the `/admin/cic-bundle-changed` broadcast so the banner mounts.
    await page.evaluate((hash: string) => {
      window.__cic_bundleHash?.setServerHash(hash);
    }, newHash);

    await pressRefresh(page);

    // #775's toast on the MANUAL path. Pre-#1063 the button wrote no marker at
    // all, so a successful manual refresh was as silent as a failed one; this
    // is the accepted behaviour change, asserted rather than left to the diff.
    await expect(page.locator(TOAST_TEXT)).toHaveText(updatedTo(newHash));

    // The label names the bundle that is RUNNING, not the one that asked to be
    // replaced — the reason the marker carries the departing hash.
    expect(await bootHashOf(page), "the reload must have landed on bundle B").toBe(newHash);
  } finally {
    await snap.restore();
  }
});
