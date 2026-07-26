// #411 — human byte-size formatter. Renders a raw byte count as a readable
// size for user-facing copy (e.g. the `file_too_large` upload cap in
// `friendlyApiError`).
//
// Base-1024 with "bytes"/KB/MB/GB/TB labels — the same binary spelling the
// upload orchestrator's `mbLabel` uses, so the two surfaces never disagree on
// the size of a given cap. `mbLabel` stays separate: it is deliberately
// MB-only (fixed units for the "X of Y" upload-progress line, where a unit
// that flips KB→MB→GB as the counter climbs would read worse). This formatter
// is the adaptive one-shot label; that one is the fixed progress label —
// different presentation contracts, not duplicated logic.
//
// Rounding mirrors `mbLabel`: an exact or >= 10 value renders as a whole
// number (no noisy trailing ".0"/decimals at large magnitudes); a smaller
// fractional value keeps one decimal. Non-finite / non-positive input floors
// to "0 bytes" so a garbage size never renders as "NaN"; callers that want a
// capless fallback must gate on the value BEFORE calling (see
// `friendlyApiError`'s `file_too_large` arm).
const UNITS = ["KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1) return "0 bytes";
  if (bytes < 1024) {
    const n = Math.round(bytes);
    return n === 1 ? "1 byte" : `${n} bytes`;
  }

  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  let rounded =
    value >= 10 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  // Rounding can push a just-under-boundary value to 1024 (e.g. 1048575 B →
  // 1023.999 KB → 1024 KB); promote it to 1 of the next unit rather than
  // print "1024 KB".
  if (rounded >= 1024 && unit < UNITS.length - 1) {
    rounded = 1;
    unit += 1;
  }

  return `${rounded} ${UNITS[unit]}`;
}
