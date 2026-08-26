import type { MatrixRainLook } from "../MatrixRain";

// #1807 — what the credits modal's rain looks like.
//
// #1773 shipped the effect at the Debug panel's settings, where the rain is
// dim on purpose because readouts have to stay legible through it. Behind the
// end titles nothing has to stay legible through it: the rain IS the picture,
// and at those settings it read as a faint texture rather than as rain
// (verified on a real iPhone against `4c9270c5`).

/**
 * The credits look.
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
