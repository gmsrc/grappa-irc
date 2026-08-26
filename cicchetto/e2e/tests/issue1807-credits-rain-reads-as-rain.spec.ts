// #1807 — the credits rain is loud, the Debug panel's rain is NOT, and the
// interlude burst rides the roll's own clock.
//
// WHAT ONLY THIS GATE CAN SEE. #1807 made `MatrixRain`'s four drawing knobs
// per-surface. vitest can pin the numbers each caller passes and the ops the
// component issues against a recording context, and it does
// (`AdminDebugTab.test.tsx`, `MatrixRain.test.tsx`). What it cannot do is
// rasterise: jsdom has no canvas, so "the credits rain actually puts a
// near-opaque pixel on screen and the phosphor panel actually does not" is
// unreachable there. Reading the pixels back with `getImageData` is that
// claim, made against a real 2D rasteriser.
//
// It also cannot run a CSS animation. `creditsRain.rollIsParked` reads the
// roll's phase and takes the start of the interlude off the animation's OWN
// keyframes, so the stylesheet stays the single source of truth — and every
// jsdom test of it runs against a HAND-BUILT `getAnimations`. That the
// browser exposes `computedOffset` and the parked transform the reader
// depends on is asserted here, on the real animation, and so is the
// consequence: seeking the ROLL's clock into the hold makes the RAIN change.
// That is the one-clock contract, and a rain driven by a `setTimeout` of its
// own would sail straight through it.
//
// THE METRIC. Premultiplied channel value, `channel * alpha`. The canvas
// accumulates a black wash, so the raw (unpremultiplied) value a pixel
// reports depends on how opaque its backing has become; the premultiplied
// one does not, and it is what the compositor puts on screen.
//
//   * one Debug glyph is `rgba(255, 176, 0, 0.18)` -> premultiplied red 46
//   * the credits leader is `rgba(255, 232, 176, 0.95)` -> red 242, blue 167
//   * the BURST leader is white at full alpha -> red 255, blue 255
//
// So red separates "there is a bright head" from "there is only dim trail",
// and blue separates the white burst leader from the amber steady one. The
// thresholds below sit in the wide middle of each gap.
//
// WHAT IS NOT PROVEN HERE, and cannot be: whether it READS as rain. That is
// a judgement about legibility over a dark theme on a real device, and the
// issue asks for it on a real iPhone, on BOTH surfaces. See the dogfood
// checklist on the PR.
//
// SCOPE. chromium only. The defect's platform is a phone, and this is not
// it — but the two claims made here are engine-independent (canvas 2D
// rasterisation and the Web Animations API), and the mobile project only
// takes `@webkit`-tagged specs.
//
// Per `feedback_e2e_user_class_parity_matrix`: the Debug panel is
// admin-gated, the EXEMPT shape; the credits roll is subject-shape-agnostic
// (it names the BUILD, not the reader), so registered vjt suffices — the
// same reading #1773's spec made.

import type { Page } from "@playwright/test";
import {
  adminLogin,
  loginAs,
  openAdminConsole,
  openSettingsDrawer,
} from "../fixtures/cicchettoPage";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, specUser, test } from "../fixtures/test";

test.setTimeout(90_000);

/**
 * The rain turns itself OFF under `prefers-reduced-motion`, and the roll
 * loses its animation with it — so an inherited preference would make every
 * assertion here vacuous in the same direction (nothing painted reads as
 * nothing loud). Stated rather than assumed.
 */
async function withMotion(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "no-preference" });
}

/** Well above one dim glyph (46), well below a leader (242). */
const PANEL_INK_CEILING = 120;
/** A leader lands at 242; a stack of dim trail glyphs cannot reach this. */
const LEADER_INK_FLOOR = 200;
/** The steady leader's blue is 167; only the white burst leader clears this. */
const BURST_BLUE_FLOOR = 210;

type InkPeak = { readonly red: number; readonly blue: number };

/**
 * The brightest premultiplied red and blue anywhere on a rain canvas.
 *
 * Peak rather than mean on purpose: the leader is a handful of pixels per
 * column against a mostly-empty canvas, so any average would drown exactly
 * the thing under test.
 */
async function inkPeak(page: Page, testId: string): Promise<InkPeak> {
  return await page.locator(`[data-testid="${testId}"] canvas`).evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    const ctx = canvas.getContext("2d");
    if (ctx === null || canvas.width === 0 || canvas.height === 0) return { red: 0, blue: 0 };
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let red = 0;
    let blue = 0;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = (data[i + 3] ?? 0) / 255;
      red = Math.max(red, (data[i] ?? 0) * alpha);
      blue = Math.max(blue, (data[i + 2] ?? 0) * alpha);
    }
    return { red, blue };
  });
}

/**
 * The loudest thing the canvas paints over `windowMs`.
 *
 * Not a sleep: every iteration is a `getImageData` round trip, so the loop
 * paces itself off the browser and the window bounds how many of the ~15fps
 * frames get sampled. A ceiling claim needs MANY frames — one sample could
 * land between two heads and report a quiet canvas that is never quiet.
 */
async function inkPeakOver(page: Page, testId: string, windowMs: number): Promise<InkPeak> {
  const until = Date.now() + windowMs;
  let red = 0;
  let blue = 0;
  do {
    const peak = await inkPeak(page, testId);
    red = Math.max(red, peak.red);
    blue = Math.max(blue, peak.blue);
  } while (Date.now() < until);
  return { red, blue };
}

test("#1807 — the Debug tab's phosphor rain stays as dim as it always was", async ({ page }) => {
  // The constraint the whole per-surface shape exists to protect: this rain
  // falls BEHIND viewport readouts an operator is trying to read. Nobody
  // asked for it to change, and the type system cannot say a future edit did
  // not hand it the credits modal's numbers.
  await withMotion(page);
  await adminLogin(page, getSeededAdmin());
  await openAdminConsole(page);
  await page.getByTestId("admin-tab-debug").click();
  await expect(page.getByTestId("admin-debug-tab")).toBeVisible({ timeout: 10_000 });

  // Five taps on the panel is the gate the rain has always sat behind — the
  // real gesture, not a signal poked from the outside.
  //
  // Scoped by the PROMPT line, because the tab carries THREE `.adm-matrix`
  // panels ("Viewport diagnostics", "Element chain", "Event log") and only
  // the first one wears `onClick={tapHeading}`. A bare `.adm-matrix` is a
  // strict-mode violation, and picking `.first()` instead would be a guess
  // that goes stale the day a panel is added above it. `.adm-matrix-prompt`
  // is that panel's own affordance line and exists nowhere else; the
  // assertion below then re-checks the choice for free, since tapping the
  // wrong panel mounts no rain at all.
  const panel = page.locator(".adm-matrix:has(.adm-matrix-prompt)");
  for (let i = 0; i < 5; i++) await panel.click();
  await expect(page.getByTestId("admin-matrix-rain")).toBeVisible({ timeout: 5_000 });

  // ANTI-HOLLOW-GREEN. A canvas that never painted satisfies any ceiling.
  await expect
    .poll(async () => (await inkPeak(page, "admin-matrix-rain")).red, {
      timeout: 15_000,
      message: "the phosphor rain never put a single glyph on its canvas",
    })
    .toBeGreaterThan(0);

  const peak = await inkPeakOver(page, "admin-matrix-rain", 3_000);
  expect(
    peak.red,
    "a bright head appeared on the Debug panel — the credits look reached a surface it must not",
  ).toBeLessThan(PANEL_INK_CEILING);
});

test("#1807 — the credits rain paints a bright leader, and the burst rides the roll's clock", async ({
  page,
}) => {
  await withMotion(page);
  await loginAs(page, specUser());
  await openSettingsDrawer(page);
  await page.getByTestId("credits-entry").click();
  await expect(page.getByTestId("credits-modal")).toBeVisible({ timeout: 5_000 });

  // ── the head is actually near-opaque ────────────────────────────────────
  // This is the defect: at #1773's settings the rain read as a faint texture
  // because every glyph in a column was painted identically and dim.
  await expect
    .poll(async () => (await inkPeak(page, "credits-matrix-rain")).red, {
      timeout: 15_000,
      message: "no near-opaque leader ever appeared on the credits rain",
    })
    .toBeGreaterThanOrEqual(LEADER_INK_FLOOR);

  // ── the interlude exists, and the browser exposes what the reader needs ──
  const roll = page.getByTestId("credits-roll");
  const timing = await roll.evaluate((node) => {
    const anim = node.getAnimations()[0];
    const effect = anim?.effect ?? null;
    if (effect === null) return null;
    const duration = effect.getComputedTiming().duration;
    const stops = (effect as KeyframeEffect)
      .getKeyframes()
      .map((frame) => ({ at: frame.computedOffset, transform: String(frame.transform) }));
    return { durationMs: typeof duration === "number" ? duration : null, stops };
  });

  expect(timing, "the roll carries no running animation to read a phase off").not.toBeNull();
  const stops = timing?.stops ?? [];
  const finalTransform = stops.at(-1)?.transform;
  const parkAt = stops.find((stop) => stop.transform === finalTransform)?.at ?? 1;
  expect(parkAt, "the roll never parks — there is no interlude to hold on").toBeLessThan(1);
  const interludeMs = (timing?.durationMs ?? 0) * (1 - parkAt);
  expect(interludeMs).toBeGreaterThanOrEqual(5_000);
  expect(interludeMs).toBeLessThanOrEqual(7_000);

  // ── mid-roll there is no white ──────────────────────────────────────────
  // The counter-claim. Without it, a rain that bursts CONTINUOUSLY would pass
  // the assertion below.
  const steady = await inkPeakOver(page, "credits-matrix-rain", 2_000);
  expect(steady.blue, "the burst is firing while the titles are still rolling").toBeLessThan(
    BURST_BLUE_FLOOR,
  );

  // ── ONE CLOCK ───────────────────────────────────────────────────────────
  // Move the ROLL's time and nothing else. If the burst were on a timer of
  // its own — the shape that drifts in a backgrounded tab, where rAF stops
  // and timers do not — this would change the titles and leave the rain
  // exactly as amber as it was.
  await roll.evaluate((node) => {
    const anim = node.getAnimations()[0];
    if (anim === undefined) return;
    const effect = anim.effect;
    if (effect === null) return;
    const duration = effect.getComputedTiming().duration;
    const stops = (effect as KeyframeEffect)
      .getKeyframes()
      .map((frame) => ({ at: frame.computedOffset, transform: String(frame.transform) }));
    const finalStop = stops.at(-1)?.transform;
    const parks = stops.find((stop) => stop.transform === finalStop)?.at ?? 1;
    // The MIDDLE of the hold, computed from the keyframes rather than typed
    // here, so retiming the roll retimes this seek with it.
    anim.currentTime = (typeof duration === "number" ? duration : 0) * ((parks + 1) / 2);
  });

  await expect
    .poll(async () => (await inkPeak(page, "credits-matrix-rain")).blue, {
      timeout: 10_000,
      message:
        "the roll is parked in its interlude and the rain never went white — the burst is not " +
        "reading the roll's phase",
    })
    .toBeGreaterThanOrEqual(BURST_BLUE_FLOOR);
});
