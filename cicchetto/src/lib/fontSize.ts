// Font-size preference — a NUMBER of px, persisted in localStorage, written
// as a single CSS var on `<html>`. Mirror-shape of theme.ts: boot-time entry
// called from main.tsx BEFORE render() so the first paint already has the
// right size — no FOUC + no flash on toggle.
//
// `--font-size` is plumbed into every cic surface via the default.css
// `:root` rule (default 14px = "M") + downstream `font-size: var(--font-size)`
// references. Setting it on `<html>` overrides `:root` without touching
// the stylesheet.
//
// localStorage only — per `feedback_no_localized_strings_server_side`,
// cic owns mobile UX; no server-side persistence, no wire bleed.
//
// ## issue 2164 — why the closed set became a number
//
// The stored value used to be one of five KEYS ("S".."XXL") and the guard
// was a five-string match. vjt's ruling adds an XS rung at 11px AND an
// advanced numeric field clamped to 9–28px, so the set is no longer closed
// and the guard is a FINITENESS CHECK PLUS A CLAMP instead.
//
// The presets did not go away: they are the tested path, six sizes somebody
// has actually looked at, and they now simply WRITE their number. The free
// field is the escape hatch.
//
// ## The guard, and why it is shaped like this
//
// What comes out of here goes into `style.setProperty("--font-size", …)`,
// i.e. it is a string this app puts inside CSS. So the value is parsed to a
// number and RE-SERIALISED as `${n}px` — never concatenated from the raw
// input. That single decision is what makes a stored `"20px; --evil: 1"`
// inert rather than a second declaration.
//
// Two dispositions, deliberately different:
//
//   * NOT A FINITE NUMBER (`NaN`, `Infinity`, `"14px; …"`, `""`, a legacy
//     key we do not know) — there is nothing to clamp, so it falls back to
//     M. `""` is called out separately because `Number("")` is 0, which
//     would otherwise clamp onto the 9px floor and silently shrink the app.
//   * A FINITE NUMBER OUTSIDE THE RANGE (400, -5) — CLAMPED, per the
//     ruling: "a value outside the range is clamped, not rejected
//     silently". A negative is a number, it is just not a legal one, so it
//     lands on the floor rather than on M.

const STORAGE_KEY = "cicchetto.fontSize";

// The rungs, smallest first — this is also the order the drawer renders.
// XS is 11px and NOT the 10px the +2 ladder would give: 10px monospace is
// unreadable, which is why the number needed a ruling at all (issue 2164).
export const FONT_SIZE_PRESETS = [
  { key: "XS", px: 11 },
  { key: "S", px: 12 },
  { key: "M", px: 14 },
  { key: "L", px: 16 },
  { key: "XL", px: 18 },
  { key: "XXL", px: 20 },
] as const;

// The ruled clamp. Wide enough to cover XS through XXL with headroom on
// both ends; the numbers are vjt's, not a derived quantity.
export const FONT_SIZE_MIN_PX = 9;
export const FONT_SIZE_MAX_PX = 28;

// "M", and the same 14px the default.css `:root` rule carries. Everything
// unreadable lands here, including a value written by a build that knew a
// key this one does not.
const DEFAULT_PX = 14;

// Finiteness + clamp. The ONE place a number becomes a legal font size.
function sanitizePx(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PX;
  return Math.min(FONT_SIZE_MAX_PX, Math.max(FONT_SIZE_MIN_PX, n));
}

// Read-side migration off the pre-2164 keys. Deliberately NOT a write-back:
// an operator who never touches the control keeps a row an older bundle
// still understands, and two e2e specs seed exactly these strings. The row
// converts to a number the first time something is actually picked.
function readStoredPx(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return DEFAULT_PX;

  const preset = FONT_SIZE_PRESETS.find((p) => p.key === raw);
  if (preset !== undefined) return preset.px;

  // `Number(" ")` is 0, so the blank has to be caught before the parse.
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_PX;

  return sanitizePx(Number(trimmed));
}

function writeCssVar(px: number): void {
  document.documentElement.style.setProperty("--font-size", `${px}px`);
}

export function getFontSizePx(): number {
  return readStoredPx();
}

// Persists and applies the size, and returns the px it ACTUALLY applied —
// which is not always the one it was handed. The caller needs that: an
// input box showing a number the app refused would be lying about what is
// in effect, and the clamp is meant to be visible.
export function setFontSizePx(px: number): number {
  const applied = sanitizePx(px);
  localStorage.setItem(STORAGE_KEY, String(applied));
  writeCssVar(applied);
  return applied;
}

// Boot-time entry. Reads stored preference (falling back to M) and
// writes `--font-size` on `<html>` so the first frame already has the
// right size.
export function applyFontSizeFromStorage(): void {
  writeCssVar(readStoredPx());
}
