import type { ConnectionState } from "./api";

// ADMIN-LAYOUT-FIX (2026-07-12) — DB-canonical connection-state → glyph
// map for the admin Visitors tab per-network cell. Gemello of
// timeFormat.ts (#217) / the EMOJI_KIND map in mediaLink.ts: a closed set
// modelled as a typed record, never an inline `switch` in the TSX.
//
// ## The closed set is the server's, not ours
//
// The states are `Grappa.Networks.Credential.connection_state()` =
// `:connected | :failing | :parked | :failed`, encoded over JSON as the
// string discriminator and typed in api.ts as `ConnectionState` (a
// re-export of the GENERATED union, so the server's set is the only
// source and this map is exhaustive by tsc rather than by vigilance).
// There is still NO `:disconnected` / `:connecting` at the DB level —
// those transient runtime sub-states live in Session.Server GenServer
// state and reach cic as the #100 `connection_progress` overlay, never
// as this wire field. So the map keys are EXACTLY the four real values;
// anything else degrades to the neutral ⚪ fallback — visibly, never a
// throw. Note
// `AdminVisitorNetwork.connection_state` is NON-nullable (api.ts), so the
// `null` arm below is defensive only; the U-0 honesty signal is carried by
// `net.live_state` (nullable), a SEPARATE field the LiveBadge renders.
//
// ## Two truths, two columns
//
// This glyph is for the DB-canonical `net.connection_state` ONLY. It does
// NOT replace or derive from the LiveBadge (`● N chan`), which renders the
// SEPARATE live-pid truth (`net.live_state`, nullable) per CLAUDE.md "DB
// state and live state are separate sources of truth". Both render side by
// side in the same cell.
//
// ## a11y + test seam
//
// A bare glyph is unreadable to a screen reader AND useless as a vitest
// assertion (codepoint fragility). Each entry pairs the glyph with a word
// `label` used as the `title`/`aria-label` in the TSX and asserted by the
// table test — assert the word, not the codepoint.

export type ConnectionStateGlyph = {
  glyph: string;
  label: string;
};

// 🟢 connected — registered upstream (001 RPL_WELCOME seen).
// ⚠️  failing   — #1675: the session is alive and retrying, but the link
//                is NOT registered (refused / timed out / TLS unusable).
//                Distinct from 🔴: this one is coming back on its own if
//                the upstream lets it, and the row carries the cause in
//                `connection_state_reason`.
// ⏸️  parked    — user-driven /disconnect or /quit; paused, not an error.
// 🔴 failed     — server-set permanent error (k-line 465 / SASL 904/906).
const GLYPHS: Record<ConnectionState, ConnectionStateGlyph> = {
  connected: { glyph: "🟢", label: "connected" },
  failing: { glyph: "⚠️", label: "failing" },
  parked: { glyph: "⏸️", label: "parked" },
  failed: { glyph: "🔴", label: "failed" },
};

// ⚪ neutral fallback for a defensive `null` or an unrecognised string —
// a future server state cic hasn't shipped a glyph for. Both degrade
// visibly, never throw.
const UNKNOWN: ConnectionStateGlyph = { glyph: "⚪", label: "unknown" };

export function connectionStateEmoji(state: ConnectionState | null): ConnectionStateGlyph {
  if (state === null) return UNKNOWN;
  return GLYPHS[state] ?? UNKNOWN;
}
