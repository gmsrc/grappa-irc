// Pure pinch geometry for the media-viewer image (#213, #1805). DOM-free so it
// unit-tests without touch physics — gemello di `swipe.ts`. The gesture itself
// (element-level touch listeners, {passive:false}) lives in the ZoomableImage
// component; this module owns only the math.
//
// WHY the PINCH is still hand-rolled: iOS-1 (2026-05-17, `<meta viewport ...
// maximum-scale=1, user-scalable=no>`) deliberately kills the browser's native
// pinch-zoom app-wide so cic feels like an app, not a website. That lock is a
// viewport-level property with no per-element opt-out, so the only way to zoom
// the modal image is to synthesize the gesture and apply a CSS `transform` to
// the <img> alone.
//
// WHY the PAN is NOT (#1805): that lock governs PAGE ZOOM, and nothing else. An
// `overflow: auto` box inside the modal scrolls natively underneath it —
// measured, chromium/iPhone-15 through the real touch pipeline: 112px of scroll
// with the lock in place against 128px without it, where the whole question was
// whether it would be zero. So the pan is the browser's job now: momentum,
// rubber-band, scrollbar and exact bounds come for free, and the geometry that
// used to synthesize it (`applyPan`, `maxTranslate`, and `clampTransform`'s
// translate half) is gone rather than kept as a second answer to "where is the
// image". What replaces it is `rescaleScroll`, which is a different job: a
// scroll offset is anchored to a point on the IMAGE, so changing the scale has
// to move the offset or the picture jumps out from under the fingers.
//
// A scale therefore travels alone — no `tx`/`ty` — and is applied as
// `transform: scale(s)` under a `transform-origin: 0 0`. The 0 0 origin is
// load-bearing and not a style choice: it makes image coordinates and scroll
// coordinates the same coordinate system times `s`, which is the whole of
// `rescaleScroll`'s arithmetic. `Size` is the image's fit-to-viewer box, which
// the component reads off the CSS rather than recomputing.

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };

// A scroll container's offset, in the same shape the DOM uses
// (`scrollLeft`/`scrollTop`) so a caller never has to rename fields.
export type Scroll = { left: number; top: number };

// Zoom bounds. MIN_SCALE = fit (can't zoom out past the object-fit:contain
// baseline); MAX_SCALE caps the hand-rolled zoom so a frantic pinch can't blow
// the image up unboundedly. DOUBLE_TAP_SCALE is the toggle target.
export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
export const DOUBLE_TAP_SCALE = 2;

export const distance = (a: Point, b: Point): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
};

export const midpoint = (a: Point, b: Point): Point => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const clampScale = (scale: number): number => clamp(scale, MIN_SCALE, MAX_SCALE);

// Pinch: scale the START scale by the ratio of current/start finger distance,
// then re-confine. A zero start distance (degenerate touch) is a no-op guard
// against divide-by-zero.
export const applyPinch = (
  startScale: number,
  startDistance: number,
  currentDistance: number,
): number => {
  if (startDistance <= 0) return startScale;
  return clampScale(startScale * (currentDistance / startDistance));
};

// Double-tap toggle: fit → DOUBLE_TAP_SCALE, any zoom → back to fit. Where the
// zoom lands is `rescaleScroll`'s business, not this function's — the toggle
// says WHAT scale, the caller says AROUND WHAT POINT.
export const toggleZoom = (scale: number): number =>
  scale > MIN_SCALE ? MIN_SCALE : DOUBLE_TAP_SCALE;

// Keep the point under `focus` under `focus` across a scale change.
//
// `focus` is in the scroll container's own viewport coordinates (0,0 = the
// container's top-left corner, NOT the page's). With `transform-origin: 0 0`
// the image point currently under it is `(scroll + focus) / from`, and putting
// that same image point back under `focus` at the new scale is
// `imagePoint * to - focus`. That is the whole derivation.
//
// Deliberately NOT clamped here: assigning `scrollLeft`/`scrollTop` clamps to
// the container's real bounds, which is the one authority that knows them — and
// re-deriving those bounds in here is exactly the duplicated geometry #1805
// deleted. A negative or over-large result is therefore correct input, not a
// bug to guard.
export const rescaleScroll = (scroll: Scroll, focus: Point, from: number, to: number): Scroll => {
  if (from <= 0) return scroll;
  return {
    left: ((scroll.left + focus.x) / from) * to - focus.x,
    top: ((scroll.top + focus.y) / from) * to - focus.y,
  };
};
