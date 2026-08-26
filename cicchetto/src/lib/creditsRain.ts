import type { MatrixRainLook } from "../MatrixRain";

// #1807 — what the credits modal's rain looks like, and WHEN it changes.
//
// #1773 shipped the effect at the Debug panel's settings, where the rain is
// dim on purpose because readouts have to stay legible through it. Behind the
// end titles nothing has to stay legible through it: the rain IS the picture,
// and at those settings it read as a faint texture rather than as rain
// (verified on a real iPhone against `4c9270c5`).
//
// The two looks below are the whole of this module's data; the rest is the
// one question the modal asks 15 times a second — "is the roll parked?".

/**
 * The steady look, while the titles are travelling.
 *
 * Against `4c9270c5`: the glyph goes 0.18 → 0.30 so it is visible at all; the
 * wash goes 0.10 → 0.06, which takes the trail from dying in seven frames
 * (0.9^7 of an alpha that started at 0.18) to a streak that is still a third
 * as bright twenty frames later; the head gets its own near-opaque light
 * amber, which is the single change that makes the effect read as rain rather
 * than as drifting dots; and the column advances 0.7 rows per frame instead
 * of one, which is vjt's 0.7x (revised up from 0.4x on #grappa at 01:57).
 *
 * The speed does NOT come from the frame budget — `MatrixRain` keeps its
 * ~15fps loop, because at ~6fps the columns visibly step.
 */
export const CREDITS_RAIN_LOOK: MatrixRainLook = {
  glyphAlpha: 0.3,
  fadeAlpha: 0.06,
  leader: "rgba(255, 232, 176, 0.95)",
  rowsPerFrame: 0.7,
};

/**
 * The interlude burst: once the titles have scrolled off the top, the roll
 * holds off-screen for a few seconds and the rain is all there is to look at.
 * Leaders go full white, the wash drops again so more of every column is lit
 * at once, and the fall speeds up past the 0.7x baseline (vjt, #grappa 01:55).
 *
 * ⚠️ "More columns lighting at once" was the third item vjt named, and it has
 * no referent in this implementation: every column already paints on every
 * frame — they differ only in where their head is, so there is no unlit
 * column to light. It is rendered here as more of each column being lit
 * (brighter glyph, longer streak) rather than as more columns, and that is a
 * substitution, not the same thing.
 */
export const CREDITS_RAIN_BURST_LOOK: MatrixRainLook = {
  glyphAlpha: 0.45,
  fadeAlpha: 0.05,
  leader: "rgba(255, 255, 255, 1)",
  rowsPerFrame: 1,
};

/**
 * The look for RIGHT NOW, given the element carrying the `credits-roll`
 * animation. Handed to `MatrixRain` as its `look` prop, so it is called from
 * inside the frame loop that already exists.
 *
 * @param roll the `.credits-roll` element, or `undefined` before it mounts
 */
export function creditsRainLook(roll: HTMLElement | undefined): MatrixRainLook {
  return rollIsParked(roll) ? CREDITS_RAIN_BURST_LOOK : CREDITS_RAIN_LOOK;
}

/**
 * Is the roll parked off-screen — i.e. is this the interlude?
 *
 * ONE CLOCK. The interlude is a stretch of the CSS animation's own cycle (the
 * translate finishes early and the last keyframes hold), so the phase is read
 * off the animation instead of being counted alongside it. A `setTimeout`
 * would be a second clock that has to agree with the first, and it would
 * disagree exactly where it matters: in a backgrounded tab, rAF stops and
 * timers do not, so the burst would come back mid-roll.
 *
 * Degrades to "not parked" rather than throwing. `getAnimations` is absent in
 * jsdom, and absent FOR REAL under `prefers-reduced-motion`, where the roll
 * is a plain scrollable column with no animation at all — no phase to read,
 * and no rain running to burst anyway.
 */
export function rollIsParked(roll: HTMLElement | undefined): boolean {
  if (roll === undefined) return false;

  const effect = roll.getAnimations?.()[0]?.effect ?? null;
  if (effect === null) return false;

  const progress = effect.getComputedTiming().progress;
  if (typeof progress !== "number") return false;

  const parksAt = parkOffset(effect);
  return parksAt !== null && progress >= parksAt;
}

/**
 * The offset in the cycle at which the roll stops travelling, read off the
 * animation's OWN keyframes.
 *
 * Read rather than declared, so the stylesheet stays the single source of
 * truth for both ends of the interlude — a constant here would be a second
 * copy of a number that lives in `@keyframes credits-roll`, and the two would
 * drift the first time anyone retimed the roll.
 *
 * `null` when there is no interlude to be inside of: a roll whose FIRST
 * keyframe already carries the final transform is not rolling, and one that
 * only reaches it at the end has no hold.
 */
function parkOffset(effect: AnimationEffect): number | null {
  const keyframed = effect as AnimationEffect & {
    readonly getKeyframes?: () => readonly ComputedKeyframe[];
  };
  const frames = keyframed.getKeyframes?.();
  const last = frames?.at(-1);
  if (frames === undefined || last === undefined) return null;

  for (const frame of frames) {
    if (frame.transform !== last.transform) continue;
    const at = frame.computedOffset;
    return at > 0 && at < 1 ? at : null;
  }
  return null;
}
