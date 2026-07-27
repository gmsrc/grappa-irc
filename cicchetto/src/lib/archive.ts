import { createSignal } from "solid-js";
import { type ArchiveEntry, listArchive } from "./api";
import { token } from "./auth";
import { type ChannelKey, decodeChannelKey } from "./channelKey";
import { identityScopedStore } from "./identityScopedStore";
import { channelsBySlug } from "./networks";
import { normalizeNick } from "./nickEquals";
import { queryWindowsByNetwork } from "./queryWindows";
import { windowStateByChannel } from "./windowState";

// Per-network archive store. Source-of-truth for cic's per-network
// Archive collapsible groups in `ArchiveModal` (#473; pre-#473 this
// backed the Sidebar `<details>` archive section, CP15 B4).
//
// Lifecycle:
//   1. On user expand of a network's `<details>` group in ArchiveModal,
//      its `onToggle` calls `loadArchive(slug)` which fetches GET /archive
//      and writes the entries into `archivedBySlug()[slug]`. Lazy by
//      design — the list can be O(hundreds) per network and the user
//      rarely opens it.
//   2. Re-loading the same slug is a deliberate refresh (no double-load
//      gate like `members.loadedChannels`); the user re-expanding signals
//      "give me the current state."
//   3. Identity rotation flushes the whole store via `clearArchive` —
//      registered as the identityScopedStore reset (dup-A3 close).
//
// Sort order: server-side `Scrollback.list_archive/3` already returns
// entries sorted by `last_activity` DESC. The store preserves the wire
// order; the renderer is pure pass-through.

const exports_ = identityScopedStore((onIdentityChange) => {
  const [archivedBySlug, setArchivedBySlug] = createSignal<Record<string, ArchiveEntry[]>>({});
  // #473 — boolean open/closed flag for the ONE archive modal. Was the
  // per-network slug signal `archiveModalNetwork` (UX-2): back then the
  // modal showed a single network, so the slug doubled as the open flag.
  // The archive rework makes `ArchiveModal` the SINGLE archive surface on
  // both form factors, rendering EVERY network as a collapsible group, so
  // the modal no longer tracks a network — only whether it is visible.
  // Read by `ArchiveModal.tsx`; written by the `RailActions` archive
  // button (via `mobilePanel.openArchivePanel`) + the modal's close
  // affordances, and cleared by the mutex helpers in `mobilePanel.ts`.
  //
  // Lives INSIDE the identityScopedStore so token rotation closes any
  // open modal alongside `archivedBySlug` flush — otherwise a previous
  // identity's modal could linger on top of the new identity's shell.
  const [archiveModalOpen, setArchiveModalOpen] = createSignal<boolean>(false);

  const clearArchive = (): void => {
    setArchivedBySlug({});
    setArchiveModalOpen(false);
  };

  // Identity-transition cleanup. A token rotation MUST flush the prior
  // identity's archive cache AND close any open modal before the new
  // identity's first load fires.
  onIdentityChange(clearArchive);

  const loadArchive = async (slug: string): Promise<void> => {
    const t = token();
    if (!t) return;
    try {
      const entries = await listArchive(t, slug);
      setArchivedBySlug((prev) => ({ ...prev, [slug]: entries }));
    } catch {
      // Leave the prior entries (if any) in place. Sidebar's renderer
      // tolerates an absent slug key as "not loaded yet"; a transient
      // failure shouldn't blank the user's previously-rendered list.
    }
  };

  return {
    archivedBySlug,
    archiveModalOpen,
    loadArchive,
    clearArchive,
    setArchiveModalOpen,
  };
});

export const archivedBySlug = exports_.archivedBySlug;
export const archiveModalOpen = exports_.archiveModalOpen;
export const loadArchive = exports_.loadArchive;
export const clearArchive = exports_.clearArchive;
export const setArchiveModalOpen = exports_.setArchiveModalOpen;

// UX-2 — shared archive-visibility filter. Pre-UX-2 lived inline in
// `Sidebar.tsx` as `visibleArchiveForNetwork/2`; UX-2 lifted it here so
// the (then-two) archive surfaces could share one verb. #473 collapsed
// those surfaces into ONE — `ArchiveModal` is now the sole caller, using
// it for each per-network group's list — but it stays a standalone verb
// (a re-JOINed channel or re-opened query must not appear in the archive).
//
// CP15 B5 contract preserved: render-time derivation, backing
// `archivedBySlug` cache untouched. Server-side `Scrollback.list_archive/3`
// does the same exclusion via active_keyset, but the client-side cache
// survives JOIN echoes; re-JOIN of an archived channel would otherwise
// dup the row in active + archive sections.
//
// UX-5 bucket BK (2026-05-19): ALSO exclude anything in
// `windowStateByChannel` for the slug. Pseudo-rows (pending/failed/
// kicked/parked rendered via Sidebar.pseudoChannelsForNetwork) carry
// scrollback persisted by Session.Server's `:join_failed` arm, so
// without this filter a failed JOIN appears in BOTH the active sidebar
// (pseudo-row) AND the archive section (notice row qualifies as
// archived because the channel isn't in Session.list_channels). One
// window, one surface. Operator clicks × on the pseudo-row → forceParted
// drops the windowState key → this filter releases → archive shows
// the row.
export function visibleArchiveForNetwork(slug: string, networkId: number): ArchiveEntry[] {
  const entries = archivedBySlug()[slug] ?? [];
  if (entries.length === 0) return entries;
  // #372: fold every comparison key under rfc1459 (`normalizeNick` — the
  // single client mirror of the server fold, letters + bracket chars). A
  // service that replied as `DebugServ` archives under that casing while
  // the open window is `debugserv`; a raw `Set.has` would leave the
  // archived split visible. Folding both sides collapses the casing so an
  // active window suppresses its archived variant. Idempotent on channel
  // names (already server-canonical) and ASCII-only (non-ASCII case
  // variants stay distinct, matching the ircd + the server's fold).
  const liveChannels = new Set((channelsBySlug()?.[slug] ?? []).map((c) => normalizeNick(c.name)));
  const liveQueries = new Set(
    (queryWindowsByNetwork()[networkId] ?? []).map((qw) => normalizeNick(qw.targetNick)),
  );
  const pseudoNames = new Set<string>();
  for (const key of Object.keys(windowStateByChannel())) {
    const decoded = decodeChannelKey(key as ChannelKey);
    if (decoded === null || decoded.slug !== slug) continue;
    pseudoNames.add(normalizeNick(decoded.name));
  }
  return entries.filter((entry) => {
    const folded = normalizeNick(entry.target);
    if (pseudoNames.has(folded)) return false;
    if (entry.kind === "channel") return !liveChannels.has(folded);
    return !liveQueries.has(folded);
  });
}
