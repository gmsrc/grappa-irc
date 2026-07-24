import type { TokenPayload } from "./themesApi";
import type { ThemesWireT } from "./wireTypes";

// #75 sub-task 7 — pure helpers for the gallery consumer view.
//
// The gallery preview is a DERIVED swatch (a strip of palette chips), NOT
// a stored screenshot — the theme record carries no image, so the preview
// is generated from the token payload on render. `SWATCH_KEYS` is the
// fixed, representative subset of the 27-color vocabulary that reads as a
// recognizable palette essence (canvas + accents + a spread of the nick
// palette).

export const SWATCH_KEYS: string[] = [
  "bg",
  "bg_alt",
  "fg",
  "accent",
  "mention",
  "mode_op",
  "mode_voiced",
  "nick_0",
  "nick_4",
  "nick_8",
  "nick_12",
  "nick_15",
];

// The ordered chip colors for a theme's swatch preview. A server-
// sanitized payload always carries every key; the `transparent` fallback
// keeps the decorative swatch (and the `string[]` contract) intact if a
// malformed payload ever reaches the client rather than crashing the row.
export function swatchColors(payload: TokenPayload): string[] {
  const colors = payload.colors as Record<string, string | undefined>;
  return SWATCH_KEYS.map((k) => colors[k] ?? "transparent");
}

// owner|admin management gate — controls publish/unpublish + delete
// visibility. Mirrors the server-side authz (owner edits/deletes own;
// admin moderates any). Everyone can still browse + copy + apply, so
// those actions are NOT gated by this.
export function canManageTheme(theme: ThemesWireT, isAdmin: boolean): boolean {
  return theme.mine || isAdmin;
}

// #299 — merge the theme lists that back the gallery view (the published
// gallery + the caller's owned library + the admin-visible stranded built-ins)
// into one list, de-duplicated by id with the FIRST occurrence winning. The
// caller passes them in priority order (gallery first) so the gallery copy's
// order + viewer-relative flags lead; a theme that is BOTH published and owned
// appears once (from the gallery), and the caller's UNPUBLISHED themes — which
// never appear in the published gallery — are surfaced from the owned list.
// This is the root-cause fix for copy/create/save "not showing": those rows
// always persisted, the UI just never listed the owned library alongside the
// gallery.
export function dedupeThemesById(themes: ThemesWireT[]): ThemesWireT[] {
  const seen = new Set<number>();
  const out: ThemesWireT[] = [];
  for (const t of themes) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

// #358 — compute the `{light, dark}` id pair a card-tap should PUT, given the
// current server pair, whether day/night pairing is open, and which slot the
// selector targets. Pure so the assignment core is unit-tested without the DOM:
//   * not paired    → single pick: the tapped theme in both modes (dark null).
//   * paired + day  → replace the day slot, keep the night slot.
//   * paired + night→ replace the night slot, keep the day slot (falling back
//                     to the tapped theme only if no day slot exists yet).
export function nextThemePair(
  cur: { light: number | null; dark: number | null },
  paired: boolean,
  targetSlot: "light" | "dark",
  tappedId: number,
): { light: number; dark: number | null } {
  if (!paired) return { light: tappedId, dark: null };
  if (targetSlot === "light") return { light: tappedId, dark: cur.dark };
  return { light: cur.light ?? tappedId, dark: tappedId };
}
