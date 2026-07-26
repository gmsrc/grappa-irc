// #411 — human byte-size formatter. Renders a raw byte count as a readable
// size for user-facing copy (e.g. the `file_too_large` upload cap in
// `friendlyApiError`).
//
// Base-1024 with "bytes"/KB/MB/GB/TB labels. This is the SINGLE cap/size
// spelling for every user-facing limit surface (#411): `friendlyApiError`'s
// `file_too_large` AND the upload orchestrator's three cap messages both call
// it, so the surfaces never disagree on a given cap. The orchestrator's
// `mbLabel` is NOT a sibling cap formatter — it survives ONLY as the fixed
// MB-only spelling of the "X of Y" upload-progress line, where a unit that
// flips KB→MB→GB as the counter climbs would read worse. This formatter is the
// adaptive one-shot label; that one is the fixed progress label — different
// presentation contracts, not duplicated logic.
//
// FLOOR, NOT round (cap-safety, #411): a non-round cap must never render LARGER
// than the true limit, so an exact or >= 10 value renders as a floored whole
// number (no noisy trailing ".0"/decimals at large magnitudes) and a smaller
// fractional value keeps one floored decimal. Flooring also means the label can
// never overflow a unit — round could push 1023.99 KB → "1024 KB", forcing a
// promotion to "1 MB" that overstates the cap; floor keeps it "1023 KB", so no
// boundary-promotion branch is needed. Non-finite / non-positive input floors
// to "0 bytes" so a garbage size never renders as "NaN"; callers that want a
// capless fallback must gate on the value BEFORE calling (see
// `friendlyApiError`'s `file_too_large` arm).
const UNITS = ["KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1) return "0 bytes";
  if (bytes < 1024) {
    const n = Math.floor(bytes);
    return n === 1 ? "1 byte" : `${n} bytes`;
  }

  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  // FLOOR, never round: for every non-max unit `value` is < 1024 (the loop
  // divided until it was), so flooring can never overflow a unit — no
  // boundary-promotion branch is needed (round would; see moduledoc). The
  // largest unit (TB) may exceed 1024 and renders as-is ("2048 TB").
  const rendered =
    value >= 10 || Number.isInteger(value) ? Math.floor(value) : Math.floor(value * 10) / 10;

  return `${rendered} ${UNITS[unit]}`;
}
