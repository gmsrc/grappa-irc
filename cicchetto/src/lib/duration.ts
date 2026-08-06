// Human-readable duration formatting. Lifted from WhoisCard's private
// `formatIdle` (#474) so the WHOIS idle row and the server-info rail card
// render the same "45s" / "1m" / "4h 12m" / "2d 3h" shape from ONE
// implementation — never a copy-with-tweaks. cic owns the human strings
// (per `feedback_no_localized_strings_server_side`); the server emits only
// typed seconds / ISO instants.

/**
 * Format an elapsed span (in whole seconds) as a compact human string:
 *   <60s → "45s"; <60m → "12m"; <24h → "4h 12m"; else → "2d 3h".
 * Returns null for a null input so callers can `<Show>`-gate the row.
 */
export function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * Format the span between a wire ISO-8601 instant and `nowMs` (epoch ms)
 * as a human duration — e.g. a network's `connection.connected_at`
 * rendered as "connected for 4h 12m".
 *
 * Returns null for a null or unparseable timestamp (prefer omitting the
 * row over a confident-wrong value, per the #474 facts-only rule). A
 * future timestamp (clock skew) clamps to "0s" rather than going negative.
 */
export function formatDurationSince(iso: string | null, nowMs: number): string | null {
  if (iso === null) return null;
  const thenMs = Date.parse(iso);
  if (Number.isNaN(thenMs)) return null;
  const seconds = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  return formatDuration(seconds);
}
