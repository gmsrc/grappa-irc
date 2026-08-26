// Desktop sidebar width preferences — two flat localStorage keys, two
// CSS custom properties on <html>. Mirror-shape of fontSize.ts:
//
//   * Sync boot-time read so the first paint already has the right grid
//     template — no flash of default width as Shell mounts. applyFromStorage
//     is called from main.tsx BEFORE render().
//   * setSidebarWidth writes BOTH localStorage AND the CSS var. ResizeHandle
//     calls it only on pointerup (drag-end), not on every pointermove —
//     during drag the CSS var is mutated directly by the handle for live
//     visual feedback without thrashing localStorage.
//
// localStorage only — per `feedback_no_localized_strings_server_side`,
// device-local UI prefs (different desktops have different ergonomic widths)
// stay client-side. fontSize.ts + theme.ts set the precedent.
//
// 🔴 A SIDE WITH NO STORED WIDTH GETS NO CSS VAR (issue 1827). The var is
// written only once the operator has actually dragged. That is load-bearing,
// not tidiness: the per-tier DEFAULT lives in the stylesheet, as the fallback
// arm of `var(--sidebar-width, …)`, and a var written for everybody makes
// every one of those fallbacks unreachable. This module used to write
// DEFAULT_PX (256 / 224) on every cold load, so the #319 short-landscape
// tier's `8rem` / `7rem` could never render and a never-dragged operator got
// the 256px desktop rail in the tier built to prevent exactly that. Keeping
// the defaults in CSS also keeps them in `rem`, so they track --font-size
// (S=12px … XXL=20px) the way the rest of that tier does; a px constant here
// would freeze them at one font size.
//
// Clamp policy — TWO tiers, because the bound is not one number:
//   * Min width:  MIN_WIDTH_PX on the desktop shell; COMPACT_MIN_WIDTH_PX in
//                 the short-landscape tier, whose whole rail is narrower than
//                 the desktop floor.
//   * Max width:  half the viewport on the desktop shell; a QUARTER of it in
//                 the short-landscape tier, so both rails at their cap still
//                 leave the centre at least half the width.
//   * Both are evaluated at read/write time against the current viewport, so
//     a width chosen on a tall window clamps DOWN on entering the tier
//     instead of leaking in — and, because a read never writes back, it is
//     restored in full on leaving.

export type SidebarSide = "left" | "right";

const STORAGE_KEY: Record<SidebarSide, string> = {
  left: "cicchetto.sidebarWidth",
  right: "cicchetto.membersWidth",
};

const CSS_VAR: Record<SidebarSide, string> = {
  left: "--sidebar-width",
  right: "--members-width",
};

const DEFAULT_PX: Record<SidebarSide, number> = {
  left: 256,
  right: 224,
};

export const MIN_WIDTH_PX = 160;

// issue 1827 — the tier's own floor. Deliberately a SECOND constant rather
// than a smaller MIN_WIDTH_PX: 160px is the right floor for the desktop
// shell and must not move. In the short-landscape tier it is wider than the
// tier's own 7rem rail (98px at the default font size), so reusing it would
// pin the handle against its floor and give the operator nothing to drag.
export const COMPACT_MIN_WIDTH_PX = 96;

// Mirrors the #319 tier predicate in themes/default.css. Same caveat theme.ts
// records for MOBILE_QUERY: a media query cannot read a var(), so the
// predicate is mirrored here, not shared — change one and you must change the
// other. Read live on every clamp, exactly as window.innerWidth already is;
// no signal and no listener, because nothing here is reactive.
const SHORT_LANDSCAPE_QUERY =
  "(orientation: landscape) and (max-height: 500px) and (min-width: 769px)";

function inShortLandscape(): boolean {
  // jsdom implements no matchMedia; absent means "not in the tier", which is
  // also the correct answer for any environment that cannot evaluate it.
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(SHORT_LANDSCAPE_QUERY).matches;
}

export function minWidthPx(): number {
  return inShortLandscape() ? COMPACT_MIN_WIDTH_PX : MIN_WIDTH_PX;
}

// The single source of the upper bound. ResizeHandle reads it for BOTH the
// live-drag clamp and `aria-valuemax`; before issue 1827 each of those was
// its own inlined copy of `Math.floor(window.innerWidth / 2)`, so making the
// bound tier-aware in one place would have left the rail snapping back at
// pointerup and the separator announcing a maximum that was not the real one.
export function maxWidthPx(): number {
  if (typeof window === "undefined") return Number.POSITIVE_INFINITY;
  const divisor = inShortLandscape() ? 4 : 2;
  return Math.max(minWidthPx(), Math.floor(window.innerWidth / divisor));
}

export function clampWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_PX.left;
  return Math.min(maxWidthPx(), Math.max(minWidthPx(), Math.round(px)));
}

// Clamped stored width, or null when the operator has never dragged this
// side. null is the signal that the stylesheet owns the value — see the
// no-var rule at the top.
function readStoredWidth(side: SidebarSide): number | null {
  const raw = localStorage.getItem(STORAGE_KEY[side]);
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return clampWidth(n);
}

function writeCssVar(side: SidebarSide, px: number): void {
  document.documentElement.style.setProperty(CSS_VAR[side], `${px}px`);
}

export function getStoredSidebarWidth(side: SidebarSide): number | null {
  return readStoredWidth(side);
}

export function getSidebarWidth(side: SidebarSide): number {
  return readStoredWidth(side) ?? clampWidth(DEFAULT_PX[side]);
}

export function setSidebarWidth(side: SidebarSide, px: number): number {
  const clamped = clampWidth(px);
  localStorage.setItem(STORAGE_KEY[side], String(clamped));
  writeCssVar(side, clamped);
  return clamped;
}

// Boot-time entry. Writes the CSS var for each side the operator has
// actually sized, and leaves the others alone so the stylesheet's own
// per-tier default renders.
export function applySidebarWidthsFromStorage(): void {
  for (const side of ["left", "right"] as const) {
    const stored = readStoredWidth(side);
    if (stored !== null) writeCssVar(side, stored);
  }
}
