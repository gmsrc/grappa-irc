import type { Channel } from "phoenix";
import { createSignal } from "solid-js";
import { narrowAdminOverview } from "./wireNarrow";
import type { AdminOverviewWireT } from "./wireTypes";

// #1073 / #1075 — the admin top bar's live projection.
//
// The server exposes the same five facts through two doors (one feature,
// every door): `GET /admin/overview` and an `"overview"` push on the EXISTING
// admin channel (`grappa:admin:events`, already joined by `adminEvents.ts`),
// re-sent on a timer because `loadavg` is a SAMPLED quantity with no event to
// hang off. cic takes the push door only: the bar exists exactly as long as
// the channel does, so the join push is its cold start and the tick is its
// refresh — a REST fetch on mount would duplicate the first push.
//
// This module owns ONLY the store + the channel handler. Rather than open a
// second admin channel, the handler is installed on the SAME channel
// `adminEvents.ts` owns — `installAdminEvents(channel)` calls
// `installAdminOverview(channel)`, `uninstallAdminEvents()` calls
// `resetAdminOverview()` — exactly as `sessionLog.ts` (#215) does. One
// channel, three consumers, no second WS join.
//
// Per CLAUDE.md "Window state model lives on the server" — this store MIRRORS
// a server-sampled projection; cic NEVER originates or derives it.
//
// ## A snapshot, not a ring
//
// Unlike its two channel-mates, each push REPLACES the previous value: the
// server re-samples all five facts every interval, so there is no history to
// accumulate and the bar wants the latest reading. `null` means "no push has
// landed yet" and the bar renders no stats at all — placeholder zeroes would
// be the same lie as coercing an absent loadavg to 0.00, briefly, on every
// console open.

const [overview, setOverview] = createSignal<AdminOverviewWireT | null>(null);
export const adminOverview = overview;

let installed: Channel | null = null;

// A malformed push KEEPS the last good reading rather than nulling the store.
// Blanking the bar on a skewed tick would hide four good stats for one bad
// field, and the next honest tick is only an interval away.
function ingest(raw: unknown): void {
  const next = narrowAdminOverview(raw);
  if (next === null) {
    console.warn("[adminOverview] dropped malformed overview payload", raw);
    return;
  }
  setOverview(next);
}

// Install the `overview` handler on the admin channel. Idempotent for the
// lifetime of a Channel instance (mirror of `installSessionLog`).
export function installAdminOverview(channel: Channel): void {
  if (installed === channel) return;
  installed = channel;
  channel.on("overview", (payload: unknown) => {
    if (installed !== channel) return;
    ingest(payload);
  });
}

// Clear the store + drop the channel reference so the next admin-pane open
// starts from the fresh join push. The channel itself is `leave()`d by
// `uninstallAdminEvents` — the shared channel owner — so this only resets the
// view state.
export function resetAdminOverview(): void {
  installed = null;
  setOverview(null);
}
