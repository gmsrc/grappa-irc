import { type ChannelKey, decodeChannelKey } from "./channelKey";
import { channelsBySlug } from "./networks";
import { queryWindowsByNetwork } from "./queryWindows";
import { windowStateByChannel } from "./windowState";

// Synthetic window rows: keys with windowState != "joined" whose
// (slug, name) is NOT yet in channelsBySlug AND not a known query
// (DM) target for this network. Returns name + state tuples so the
// JSX can render the right classList branch (pending styling vs
// greyed) without a second windowState lookup.
//
// The projection covers ALL non-joined states — pending, invited
// (#78), failed, kicked, parked — under the same rule: cic mirrors a
// row whenever the operator is aware of the channel (windowState
// carries the key) but channelsBySlug doesn't. Without this, a failed JOIN
// (invite-only / banned / +k miss) leaves the operator with no
// sidebar entry at all: the pending row vanishes when state flips
// to failed and the channelsBySlug branch never receives the
// channel since the JOIN was rejected. Intent doc:
// "Sidebar entry greyed/dim" on every failed/kicked/parked window.
//
// The joined state is INTENTIONALLY EXCLUDED. PHASE 1.1 added a
// joined arm here to bridge the small per-channel-`joined` →
// user-topic-`channels_changed` window so cp15-b5 wouldn't flash an
// empty sidebar between the two broadcasts. That arm violated the
// "SOURCE state must clear at switch BEFORE TARGET decisions" rule
// (memory feedback_target_window_ux_rule) and produced a ghost-row
// regression on PART: when channels_changed arrived BEFORE the
// per-channel `kind:"message"` part broadcast (no cross-topic
// ordering guarantee at the WS edge), channelsBySlug dropped the
// channel while windowState still carried `joined` — sidebar
// synthesized a ghost row that lingered until the next render tick.
// Bug B (M9 X-button PART) reproduced this. Reverted to the
// pre-PHASE-1.1 shape; cp15-b5 now gates on the WS-truth signal
// (per-channel join-line in scrollback) instead of the sidebar row
// existence to avoid the same flake.
//
// Query (DM) targets are filtered out — windowState may carry a
// (slug, nick) entry too (the kicked/away projection plays nicely
// with DMs), but the dedicated query-windows branch handles their
// rendering. Without this filter, the synthetic loop would dup-render
// every greyed query target as a "ghost" channel row.
//
// #71 INC-3 — this is the ONE shared projection (the single code path)
// behind BOTH the desktop Sidebar pseudo-rows AND the mobile BottomBar
// `:invited` tab. Extracted from Sidebar so the two navs derive from
// the same source rather than two parallel projections. A consumer MAY
// narrow the returned set by state as a presentation choice — BottomBar
// renders only `invited` (see DESIGN_NOTES 2026-07-26 #71 INC-3) — but
// that filter is a different rendering of one source, NOT a second
// projection.

export type PseudoRow = {
  name: string;
  state: "pending" | "invited" | "failed" | "kicked" | "parked";
};

export function pseudoChannelsForNetwork(slug: string, networkId: number): PseudoRow[] {
  const states = windowStateByChannel();
  const live = new Set((channelsBySlug()?.[slug] ?? []).map((c) => c.name));
  const queries = new Set((queryWindowsByNetwork()[networkId] ?? []).map((qw) => qw.targetNick));
  const out: PseudoRow[] = [];
  for (const [key, state] of Object.entries(states)) {
    if (state === "joined") continue;
    // Codebase audit cic M4 — paired decoder over open-coded
    // `key.startsWith(prefix) + key.slice(prefix.length)`. The
    // composite-key shape is owned by `lib/channelKey.ts`; one site
    // here + one in `subscribe.ts` would otherwise drift if the
    // shape ever changed.
    const decoded = decodeChannelKey(key as ChannelKey);
    if (decoded === null || decoded.slug !== slug) continue;
    const name = decoded.name;
    if (live.has(name)) continue;
    if (queries.has(name)) continue;
    out.push({ name, state: state as PseudoRow["state"] });
  }
  return out;
}
