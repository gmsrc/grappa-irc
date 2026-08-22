import type { ConnectionState } from "../lib/api";
import { connectionStateEmoji } from "../lib/connectionStateEmoji";
import type { Tone } from "./AdminBadge";

// Admin redesign (2026-08-07 plan, Layer 4) — DB-canonical
// `connection_state` → `AdminBadge` tone. The redesigned pane renders
// this state as a theme-derived toned badge instead of the emoji glyph
// (an emoji is a font-dependent picture: it can't follow the theme and
// renders differently per platform), so the tone is what the operator
// actually reads. Two tabs show the same field — Visitors per network,
// Credentials per binding — and a second copy of the mapping is exactly
// how the two would drift into disagreeing about what "parked" looks
// like.
//
// `connectionStateEmoji` stays the source of truth for the WORD, and
// this keys off that word rather than off the raw state: the fallback
// for an unrecognised value is then shared too, so a future server-side
// state degrades to `neutral` here for the same reason it degrades to ⚪
// there — visibly, never a throw.
//
// The tones mirror what each state MEANS to an operator, not a severity
// ladder: `parked` is a user-driven pause, not a fault, so it warns
// rather than alarms; only `failed` (a server-set permanent error) is
// danger.
const BY_LABEL: Record<string, Tone> = {
  connected: "ok",
  // #1675 — `failing` is danger and not warn, on the same
  // meaning-not-severity reading: it is a genuine outage the operator
  // may have to fix (a wrong endpoint, an unverifiable certificate),
  // whereas `parked` is somebody choosing to pause. That the bouncer
  // keeps retrying does not make it less broken, and pairing it with
  // the deliberate pause would say it is.
  failing: "danger",
  parked: "warn",
  failed: "danger",
  unknown: "neutral",
};

export function connectionTone(state: ConnectionState | null): Tone {
  return BY_LABEL[connectionStateEmoji(state).label] ?? "neutral";
}
