// #143 — NamesModal mobile defects (follow-up to #140). Three fixes:
//
//   1. KEYBOARD OCCLUSION. The modal centered in the full LAYOUT
//      viewport while the visible region (window.visualViewport.height)
//      is shorter when the on-screen keyboard is up — so its lower half
//      sat under the keyboard. Fix: the backdrop now spans the VISIBLE
//      region (`height: var(--viewport-height)`) instead of `inset: 0`,
//      so `align-items: center` centers within what the user can see.
//      UX-6-D's `installSmartScrollPin` already clamps `vv.offsetTop`
//      toward 0, so NO offsetTop math is needed (offsetTop is
//      WebKit-broken — bug #297779, stuck at 24px post-dismiss; the
//      `translateY(offsetTop)` approach failed catastrophically across
//      D6/D8 — see DESIGN_NOTES 2026-05-21 UX-6-D).
//
//   3. CLOSE × TAP TARGET. Bumped to the project-standard 44px Apple-HIG
//      hit box (the #133 precedent shared by every top-pinned card ×).
//
// (#2, denser per-row spacing, is a pure visual CSS tweak with no
//  deterministic geometry contract worth asserting — it's covered by
//  the CSS rule + on-device review.)
//
// CHROMIUM LIMITATION (feedback_playwright_webkit_not_ios_scroll):
// chromium's layout viewport == its visual viewport (there is no OS
// keyboard), so it CANNOT reproduce the real iOS layout/visual
// divergence that triggers the occlusion. This spec therefore asserts
// the CSS CONTRACT, not the iOS physics: with the visible region shrunk
// to a keyboard-sized value by the production tracker itself (the same
// `installViewportHeightTracker` write that `vv.height` drives on iOS —
// unit-covered in viewportHeight.test.ts), the modal stays fully inside
// that region. Real on-device occlusion still needs Mezmerize dogfood
// before final close — flagged on #grappa.

import type { Page } from "@playwright/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// Stand-in for "the keyboard leaves ~300px of the screen visible". The
// window stays full-height; only the visible-region var shrinks — the
// same shape iOS produces (full layout viewport, short visual viewport).
const FAKE_VISIBLE_PX = 300;

async function openNamesModal(page: Page) {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await composeSend(page, `/names ${CHANNEL}`);
  const modal = page.getByTestId("names-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });
  return modal;
}

test("#143 — NamesModal stays within the keyboard-shrunk visible viewport", async ({ page }) => {
  const modal = await openNamesModal(page);

  // Simulate the iOS keyboard-up state the way docs/TESTING.md mandates
  // and issue66/issue253 already do: stub the SOURCE (`vv.height`) and
  // dispatch the `resize` the production code listens for, so
  // `installViewportHeightTracker` — the single writer of both vars
  // (lib/viewportHeight.ts:110) — shrinks the region itself.
  //
  // A bare `setProperty("--viewport-height", …)` is the documented trap,
  // and it is what this spec used to do: the tracker re-reads the REAL
  // `vv.height` on resize, focus, visibilitychange, pageshow AND a
  // post-boot settle schedule, so any one of them silently restores the
  // full height mid-test. Stubbing the source makes EVERY one of those
  // writes land on FAKE_VISIBLE_PX instead of racing them — the pin
  // survives the writer rather than being clobbered by it.
  await page.evaluate((px) => {
    const vv = window.visualViewport;
    if (!vv) throw new Error("names143 spec: window.visualViewport unavailable");
    Object.defineProperty(vv, "height", { configurable: true, get: () => px });
    vv.dispatchEvent(new Event("resize"));
  }, FAKE_VISIBLE_PX);

  // Guard: the shrink is in effect BEFORE any geometry is read, so a
  // failure below means "the modal overflows the visible region" (the
  // #143 bug) and never "the simulation didn't take".
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--viewport-height").trim(),
        ),
      { timeout: 5_000 },
    )
    .toBe(`${FAKE_VISIBLE_PX}px`);

  // The modal must stay fully inside [0, FAKE_VISIBLE_PX]; its bottom
  // edge cannot fall into the keyboard region. Pre-fix, the backdrop
  // centered in the full layout viewport, parking the lower half below.
  // Polled, not read once: the re-centre is a layout pass the resize
  // schedules. The poll reports the offending number on failure, which
  // is what made the clobber diagnosable in the first place.
  await expect
    .poll(
      async () => {
        const box = await modal.boundingBox();
        return box ? box.y + box.height : Number.POSITIVE_INFINITY;
      },
      { timeout: 5_000 },
    )
    .toBeLessThanOrEqual(FAKE_VISIBLE_PX + 1);

  // Top edge, from the now-settled layout the poll above proved landed.
  const box = await modal.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    expect(box.y).toBeGreaterThanOrEqual(-1);
  }
});

test("#143 — NamesModal close × is a 44px Apple-HIG tap target (#133)", async ({ page }) => {
  const modal = await openNamesModal(page);

  const box = await modal.getByLabel("close names").boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    // #339 — round to the CSS pixel (WebKit sub-pixel rounding); still fails
    // a genuinely short tap-target (< 43.5).
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(44);
    expect(Math.round(box.height)).toBeGreaterThanOrEqual(44);
  }
});
