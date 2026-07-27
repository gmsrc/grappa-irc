import { type Component, createSignal, For, Show } from "solid-js";
import CloseButton from "./CloseButton";
import InlineConfirmButton from "./InlineConfirmButton";
import { deleteArchiveEntry, ownNickForNetwork } from "./lib/api";
import { loadArchive, visibleArchiveForNetwork } from "./lib/archive";
import { token } from "./lib/auth";
import { awayByNetwork } from "./lib/awayStatus";
import { channelKey } from "./lib/channelKey";
import { mentionCounts } from "./lib/mentions";
import { mentionsBundleBySlug } from "./lib/mentionsWindow";
import { channelsBySlug, isAdmin, networkBySlug, networks, user } from "./lib/networks";
import { pseudoChannelsForNetwork } from "./lib/pseudoChannels";
import { openQueryWindowState, queryWindowsByNetwork } from "./lib/queryWindows";
import { reconnectingByNetwork } from "./lib/reconnectingStatus";
import { requestScrollToBottom } from "./lib/scrollToBottomCommand";
import {
  eventsUnread,
  isActiveSelection,
  messagesUnread,
  selectedChannel,
  setSelectedChannel,
} from "./lib/selection";
import { openUmodeModal } from "./lib/umodeModal";
import { umodesForNetwork } from "./lib/umodes";
import {
  closeQueryWindow,
  confirmDisconnectNetwork,
  confirmLeaveChannel,
  dismissPseudoWindow,
} from "./lib/windowClose";
import type { WindowKind } from "./lib/windowKinds";
import {
  ADMIN_WINDOW_NAME,
  ADMIN_WINDOW_SLUG,
  HOME_WINDOW_NAME,
  HOME_WINDOW_SLUG,
  LIST_WINDOW_NAME,
  SERVER_WINDOW_NAME,
} from "./lib/windowKinds";
import { windowStateByChannel } from "./lib/windowState";
import NickText from "./NickText";

// Left-pane sidebar: network → window tree. Renders ordered windows:
//   1. Server (always present, not closeable)
//   2. Channels (from IRC JOIN state; closeable via PART)
//   3. Query windows (DM targets; closeable via close_query_window event)
//   4. Ephemeral pseudo-windows (list, mentions) when present
//
// Close behavior per kind (spec #6):
//   - server   → no X button rendered
//   - channel  → X button → postPart REST (PART IRC command)
//   - query    → X button → closeQueryWindowState (server deletes row)
//   - list     → X button → client-side dismiss (no server call)
//   - mentions → X button → client-side dismiss (no server call)
//
// UX-5 bucket A (2026-05-19) — `onSelect` prop dropped. Pre-bucket
// Shell.tsx fired it from the desktop branch to auto-close the
// sidebar drawer when the operator picked a channel. The desktop
// sidebar is always-visible (no drawer to close) and the mobile
// branch never mounts Sidebar (uses BottomBar instead). The prop
// had no remaining consumer.
//
// CP15 B5 — windowState visual cues:
//   * Channel/query rows whose state ∈ {failed, kicked, parked} get
//     `.sidebar-window-greyed` so the operator sees the row is no
//     longer live (the row stays in place to keep history
//     accessible — archiving on every failure would punish the
//     victim and lose the scrollback).
//   * Pending channels NOT yet in `channelsBySlug` (operator just
//     clicked JOIN; awaiting upstream echo) render as a synthetic
//     pending sidebar row for immediate feedback. When the server
//     echoes JOIN, channelsBySlug refetches via the channels_changed
//     heartbeat and the row continues life under the channelsBySlug
//     branch (state transitions pending → joined; greyed class falls
//     off). The dedup gate skips the synthetic row when the channel
//     is already in channelsBySlug.
//
// CP19 T32 parked-window — per-network derivation overlay:
//   When the network's credential `connection_state ∈ {parked, failed}`
//   the network header gets `.sidebar-network-greyed` AND every channel/
//   query row under it derives as greyed regardless of its individual
//   `windowStateByChannel` entry. Source of truth is
//   `networkBySlug[slug].connection_state` (refreshed via the user-topic
//   `connection_state_changed` event → `refetchNetworks()` arm). Per
//   CLAUDE.md "Don't duplicate state — derive it" — we don't emit
//   per-window `:parked` events from `Session.Server.terminate/2`; cic
//   derives the cascade from the network-level state.

const NOT_JOINED_STATES = new Set(["invited", "failed", "kicked", "parked"]);
const NETWORK_GREYED_STATES = new Set(["parked", "failed"]);

export type Props = Record<string, never>;

const Sidebar: Component<Props> = () => {
  // UX-1 (2026-05-17) — singleton armed-key for archive delete confirm.
  // Mirrors AdminSessionsTab / AdminVisitorsTab — one armed row at a
  // time across the WHOLE sidebar (across every network's archive
  // section). Key shape: `"<slug> <target>"`. Space separator is safe
  // here because network slugs and IRC targets cannot contain raw
  // spaces (RFC 1459 section 2.2 + Networks.Network.changeset slug).
  const [armedArchiveKey, setArmedArchiveKey] = createSignal<string | null>(null);
  const archiveKey = (slug: string, target: string) => `${slug} ${target}`;

  const isSelected = (slug: string, name: string): boolean => {
    const s = selectedChannel();
    return s !== null && s.networkSlug === slug && s.channelName === name;
  };

  // CP19 T32: network-level greyed when the credential is parked or
  // failed. Drives both the network header `.sidebar-network-greyed`
  // class AND the cascading per-channel/per-query overlay in
  // `isGreyed/2` below.
  //
  // Bucket F H4: only UserNetwork carries connection_state. Narrow on
  // network.kind first; visitor networks are never greyed at the
  // network level (visitors have no credential row to park / fail).
  const isNetworkGreyed = (slug: string): boolean => {
    const net = networkBySlug(slug);
    return net?.kind === "user" && NETWORK_GREYED_STATES.has(net.connection_state);
  };

  const isGreyed = (slug: string, name: string): boolean => {
    if (isNetworkGreyed(slug)) return true;
    const s = windowStateByChannel()[channelKey(slug, name)];
    return s !== undefined && NOT_JOINED_STATES.has(s);
  };

  const networkReason = (slug: string): string | undefined => {
    const net = networkBySlug(slug);
    if (net?.kind !== "user") return undefined;
    return net.connection_state_reason ?? undefined;
  };

  // Synthetic non-joined window rows come from the shared projection in
  // `lib/pseudoChannels.ts` (extracted #71 INC-3 so the mobile BottomBar
  // `:invited` tab derives from the SAME source — one code path, not two
  // parallel projections). Rationale for the joined-exclusion, the
  // channelsBySlug dedup, and the query-target filter lives there.

  const handleClick = (slug: string, name: string, kind: WindowKind) => {
    const target = { networkSlug: slug, channelName: name, kind };
    // #243 — re-tapping the ALREADY-active row is a "jump to latest": fire
    // the scroll-to-bottom command (ScrollbackPane is the only subscriber
    // and it only mounts for scrollback windows, so this self-gates — a
    // re-tap on home/admin/list is a harmless no-op). Compute BEFORE the
    // setter (which is idempotent on a re-tap anyway). A tap that SWITCHES
    // windows leaves existing behaviour untouched.
    if (isActiveSelection(target)) requestScrollToBottom();
    setSelectedChannel(target);
  };

  // #229 — compact umode string for the network-header indicator, e.g.
  // "+iS". Empty when the session reports no umodes (parked / pre-connect /
  // genuinely no umodes) so the indicator hides. Reads the reactive
  // umodesForNetwork store — updates live on 221 / self-MODE echoes.
  const umodeIndicator = (networkId: number): string => {
    const modes = umodesForNetwork(networkId);
    return modes.length > 0 ? `+${modes.join("")}` : "";
  };

  // #195 — the × on a channel row opens an explicit "leave #channel?" confirm
  // modal (windowClose.confirmLeaveChannel → PART on Yes), replacing the
  // removed #172 hold-to-close gesture.
  const handleCloseChannel = (slug: string, channelName: string) => {
    confirmLeaveChannel(slug, channelName);
  };

  const handleCloseQuery = (networkId: number, targetNick: string) => {
    closeQueryWindow(networkId, targetNick);
  };

  // #71 INC-3 — pseudo-row × (pending/failed/kicked/parked) routes through
  // the shared `dismissPseudoWindow` verb in windowClose.ts (drops the
  // windowState key + redirects a focused row to $server). Extracted so the
  // desktop Sidebar and the mobile BottomBar dismiss identically — no inline
  // duplication left behind.

  // UX-4 bucket D — close the server window for a network. Routes
  // through windowClose.ts → visitor branches to quitAll (nuclear: park
  // every network + logout); registered PATCHes the one network to
  // `:parked`. Selection auto-redirects to home via the
  // `connection_state_changed` arm in selection.ts (one effect, all
  // park triggers).
  // #195 — the × on a network-header row opens an explicit "Disconnect from
  // <slug>?" confirm modal (windowClose.confirmDisconnectNetwork →
  // park/quit on Yes), same gate as the channel leave.
  const handleCloseNetwork = (slug: string) => {
    confirmDisconnectNetwork(slug);
  };

  // UX-1 (2026-05-17) — confirmed delete of an archive entry. Both
  // channel-shaped + query-shaped targets get the delete affordance
  // per vjt scope decision. Server dispatches by sigil on its end;
  // cic hands over the user-facing target string as-is. On success
  // the server broadcasts `archive_changed` and the userTopic
  // dispatcher re-fetches archivedBySlug for this network — no need
  // for an optimistic mutation here.
  const handleConfirmArchiveDelete = async (slug: string, target: string) => {
    const t = token();
    if (!t) return;
    try {
      await deleteArchiveEntry(t, slug, target);
    } catch {
      // Server-side delete failed (network blip, 4xx). Leave the row;
      // the operator can retry. The InlineConfirmButton disarms on the
      // next sibling arming or refresh. No toast — Sidebar is dense
      // and a generic error wouldn't tell the user anything actionable.
    } finally {
      setArmedArchiveKey(null);
    }
  };

  // Archive visibility filter is shared with BottomBar/ArchiveModal —
  // see `lib/archive.ts` visibleArchiveForNetwork. Pre-UX-2 lived
  // inline here.

  return (
    <>
      {/* UX-4 bucket B — `$home` pinned ABOVE all networks. Identity-
          scoped (NOT per-network), so it lives OUTSIDE the per-network
          `<For>` loop. Both visitor + registered identities see this
          row; HomePane internally branches on `homeData()`. */}
      <ul class="sidebar-home-section">
        <li classList={{ selected: isSelected(HOME_WINDOW_SLUG, HOME_WINDOW_NAME) }}>
          <button
            type="button"
            class="sidebar-window-btn sidebar-home-btn"
            onClick={() => handleClick(HOME_WINDOW_SLUG, HOME_WINDOW_NAME, "home")}
          >
            <span class="sidebar-home-emoji" aria-hidden="true">
              🏠
            </span>
            <span class="sidebar-channel-name">Home</span>
          </button>
        </li>
      </ul>

      {/* UX-4 bucket N — `$admin` pinned between Home and the first
          network's `$server` row. Identity-scoped (NOT per-network)
          AND admin-only (gated on `isAdmin()` — single source of truth
          shared with Shell.tsx pane dispatcher + SettingsDrawer.tsx
          drawer entry). Non-admin operators see no row at all and
          cannot reach the AdminPane by hand-crafting a selection
          (Shell's `<Show when={isAdmin()}>` gates the mount too). */}
      <Show when={isAdmin()}>
        <ul class="sidebar-admin-section">
          <li classList={{ selected: isSelected(ADMIN_WINDOW_SLUG, ADMIN_WINDOW_NAME) }}>
            <button
              type="button"
              class="sidebar-window-btn sidebar-admin-btn"
              data-testid="sidebar-admin-row"
              onClick={() => handleClick(ADMIN_WINDOW_SLUG, ADMIN_WINDOW_NAME, "admin")}
            >
              <span class="sidebar-admin-emoji" aria-hidden="true">
                🔧
              </span>
              <span class="sidebar-channel-name">admin</span>
            </button>
          </li>
        </ul>
      </Show>

      <Show
        when={(networks()?.length ?? 0) > 0}
        fallback={<p class="muted sidebar-empty">no networks</p>}
      >
        <For each={networks()}>
          {(network) => (
            <>
              <ul
                class={`sidebar-network-section${isNetworkGreyed(network.slug) ? " sidebar-network-greyed" : ""}`}
              >
                {/* UX-4 bucket C — network header + server window collapsed
                  into a single row. The old per-network `<h3>` is gone; this
                  row IS both the network grouping label AND the server-window
                  selector. Click sets `selectedChannel.kind = "server"` with
                  channel = `$server`. The `.sidebar-network-header` class
                  keeps the row visually distinct from the indented per-channel
                  rows below via accent color + shallower left padding. */}
                <li
                  class="sidebar-network-header"
                  classList={{ selected: isSelected(network.slug, SERVER_WINDOW_NAME) }}
                  data-window-name={SERVER_WINDOW_NAME}
                >
                  <button
                    type="button"
                    onClick={() => handleClick(network.slug, SERVER_WINDOW_NAME, "server")}
                    class="sidebar-window-btn"
                  >
                    {/* #71 INC-1 — the leading ⚙️ network-emoji is REMOVED.
                      It made the server line read reverse-indented against the
                      channels below (issue #71 "server row affordance"). The
                      slug now leads the row; the header is distinguished as the
                      group parent by weight + background (CSS), and a per-network
                      grouping rail ties the channels to it. The settings cog is
                      NOT here — it lives in the right-bar action cluster (INC-2 /
                      brief comment 5083762039). */}
                    <span
                      class="sidebar-channel-name"
                      title={
                        isNetworkGreyed(network.slug) ? networkReason(network.slug) : undefined
                      }
                    >
                      {network.slug}
                    </span>
                    {/* C8.3 — away visual indicator. Surfaces on the
                      collapsed network-header row when the user is in away
                      state on this network. Driven by `away_confirmed`
                      server event via awayStatus.ts.
                      #276 — the VISIBLE label is the 💤 (zzz) emoji, not the
                      word "away". The accessible name stays the WORD "away"
                      (aria-label) so a screen reader announces the state, not
                      the emoji's "sleeping symbol" glyph name. */}
                    <Show when={awayByNetwork()[network.slug]}>
                      <span class="sidebar-away-badge" role="img" aria-label="away" title="away">
                        {"💤"}
                      </span>
                    </Show>
                    {/* #100 — transient reconnect indicator. Surfaces on the
                      network-header row while a Session (re)establishes the
                      upstream socket after a drop. Driven by the
                      `connection_progress` server event via
                      reconnectingStatus.ts; presentational overlay only (the
                      durable connection_state is unchanged). Clears on 001. */}
                    <Show when={reconnectingByNetwork()[network.slug]}>
                      <span class="sidebar-reconnecting-badge" data-testid="reconnecting-badge">
                        reconnecting…
                      </span>
                    </Show>
                    {/* CP13 — server-window receives :notice rows for server-routed
                      numerics + NickServ + MOTD + ChanServ-fallback. Same badge
                      treatment as channels so unread counts surface uniformly. */}
                    {(() => {
                      const key = channelKey(network.slug, SERVER_WINDOW_NAME);
                      return (
                        <>
                          <Show when={(messagesUnread()[key] ?? 0) > 0}>
                            <span class="sidebar-msg-unread">{messagesUnread()[key]}</span>
                          </Show>
                          <Show when={(eventsUnread()[key] ?? 0) > 0}>
                            <span class="sidebar-events-unread">{eventsUnread()[key]}</span>
                          </Show>
                          <Show when={(mentionCounts()[key] ?? 0) > 0}>
                            <span class="sidebar-mention">@{mentionCounts()[key]}</span>
                          </Show>
                        </>
                      );
                    })()}
                  </button>
                  {/* #229 — umode indicator + tap target. Shows the
                    operator's own umodes compactly (e.g. "+iS") and opens
                    the umode viewer/editor modal on tap — the tap entry
                    point alongside `/umode` and `/mode <ownnick>`. A
                    <button> not a <span> (keyboard-reachable, no
                    noStaticElementInteractions — #220 lesson). Rendered
                    when the store holds at least one umode for this network.
                    Like the isupport store, umodesByNetwork is last-write-
                    wins and NOT cleared on park/disconnect — a network that
                    was live keeps its stale indicator on the greyed row
                    until the next connect's 221/cold-snapshot re-seeds it
                    (a never-connected network shows nothing). */}
                  <Show when={umodeIndicator(network.id).length > 0}>
                    <button
                      type="button"
                      class="sidebar-umode-indicator"
                      title={`user modes: ${umodeIndicator(network.id)}`}
                      aria-label={`view your user modes on ${network.slug}`}
                      onClick={() => openUmodeModal(network.slug)}
                    >
                      {umodeIndicator(network.id)}
                    </button>
                  </Show>
                  {/* UX-4 bucket D — × button on the network-header row
                    closes the server window which == /disconnect for
                    registered users (one network parked → selection
                    redirects to home) and == /quit for visitors (all
                    networks parked + logout). Routing in
                    windowClose.disconnectNetwork; selection redirect
                    in selection.ts. */}
                  <CloseButton
                    class="sidebar-close"
                    ariaLabel={`Disconnect ${network.slug}`}
                    onConfirm={() => handleCloseNetwork(network.slug)}
                  />
                </li>

                {/* #84 — per-network channel directory (/list). Selects the `$list`
                  pseudo-window (kind "list"); no scrollback fetch (KIND_HAS_SCROLLBACK
                  .list = false). Browse + one-click join via DirectoryPane. */}
                <li
                  class="sidebar-list-row"
                  classList={{ selected: isSelected(network.slug, LIST_WINDOW_NAME) }}
                  data-window-name={LIST_WINDOW_NAME}
                >
                  <button
                    type="button"
                    onClick={() => handleClick(network.slug, LIST_WINDOW_NAME, "list")}
                    class="sidebar-window-btn"
                  >
                    <span class="sidebar-network-emoji" aria-hidden="true">
                      📇
                    </span>
                    <span class="sidebar-channel-name">channels</span>
                  </button>
                </li>

                {/* #71 INC-2 — mentions row. Desktop replacement for the
                  ShellChrome @ open-mentions button, which now stays MOBILE-only
                  (mobile has no sidebar). Rendered ONLY when this network carries
                  a mentions bundle (the "you were /away" snapshot) — nothing to
                  open otherwise, the SAME gate the @ button used. A direct <li>
                  of THIS network <ul>, so it inherits the per-network grouping
                  rail exactly like a channel row (and unlike the archive <ul>,
                  which shares .sidebar-network-section but is scoped OUT of the
                  rail via :not(.sidebar-archive-list)). Selects the mentions
                  pseudo-window (kind "mentions", empty channel name) through the
                  same handleClick verb every row uses — one selection door. */}
                <Show when={mentionsBundleBySlug()[network.slug]}>
                  <li
                    class="sidebar-mentions-row"
                    classList={{ selected: isSelected(network.slug, "") }}
                    data-testid={`sidebar-mentions-row-${network.slug}`}
                  >
                    <button
                      type="button"
                      onClick={() => handleClick(network.slug, "", "mentions")}
                      class="sidebar-window-btn"
                    >
                      <span class="sidebar-network-emoji" aria-hidden="true">
                        @
                      </span>
                      <span class="sidebar-channel-name">mentions</span>
                    </button>
                  </li>
                </Show>

                {/* Channel windows */}
                <For each={channelsBySlug()?.[network.slug] ?? []}>
                  {(channel) => {
                    const key = channelKey(network.slug, channel.name);
                    return (
                      <li
                        classList={{ selected: isSelected(network.slug, channel.name) }}
                        data-window-name={channel.name}
                      >
                        <button
                          type="button"
                          onClick={() => handleClick(network.slug, channel.name, "channel")}
                          class={`sidebar-window-btn${isGreyed(network.slug, channel.name) ? " sidebar-window-greyed" : ""}`}
                        >
                          <span
                            class="sidebar-channel-name"
                            classList={{ parted: !channel.joined }}
                          >
                            {channel.name}
                          </span>
                          <Show when={(messagesUnread()[key] ?? 0) > 0}>
                            <span class="sidebar-msg-unread">{messagesUnread()[key]}</span>
                          </Show>
                          <Show when={(eventsUnread()[key] ?? 0) > 0}>
                            <span class="sidebar-events-unread">{eventsUnread()[key]}</span>
                          </Show>
                          <Show when={(mentionCounts()[key] ?? 0) > 0}>
                            <span class="sidebar-mention">@{mentionCounts()[key]}</span>
                          </Show>
                        </button>
                        <CloseButton
                          class="sidebar-close"
                          ariaLabel={`Close ${channel.name}`}
                          onConfirm={() => handleCloseChannel(network.slug, channel.name)}
                        />
                      </li>
                    );
                  }}
                </For>

                {/* CP15 B5/B6 — synthetic channel rows: entries the operator
                  is aware of (windowState carries the key) but that aren't
                  in channelsBySlug yet. State drives the styling: pending
                  shows the optimistic-feedback class while the upstream
                  echo is in flight; failed/kicked/parked show the greyed
                  class so a rejected JOIN (invite-only / banned / keyed)
                  still surfaces as a row instead of vanishing. The dedup
                  gate in pseudoChannelsForNetwork drops any key already
                  in channelsBySlug — channelsBySlug branch wins.

                  Joined state is excluded — see pseudoChannelsForNetwork
                  comment. PHASE 1.1's joined-arm produced ghost rows on
                  PART (no cross-topic ordering between channels_changed
                  and per-channel PART broadcasts). Reverted; cp15-b5
                  gates on per-channel join-line wire-truth instead. */}
                <For each={pseudoChannelsForNetwork(network.slug, network.id)}>
                  {(row) => (
                    <li
                      classList={{ selected: isSelected(network.slug, row.name) }}
                      data-window-name={row.name}
                      // #78 redo: expose the discrete pseudo-row state as a
                      // stable test seam (same pattern as data-window-name /
                      // data-kind). `.sidebar-window-greyed` alone is shared
                      // by EVERY not-joined state (pending/invited/failed/
                      // kicked/parked), so an e2e asserting only the greyed
                      // class can't tell an :invited row from any other greyed
                      // one — exactly the vacuity that let the old b2 invite
                      // spec pass while the :invited derivation was suspect.
                      // Production rendering is unchanged.
                      data-window-state={row.state}
                    >
                      <button
                        type="button"
                        onClick={() => handleClick(network.slug, row.name, "channel")}
                        class={
                          row.state === "pending"
                            ? "sidebar-window-btn sidebar-window-pending"
                            : "sidebar-window-btn sidebar-window-greyed"
                        }
                      >
                        <span
                          class="sidebar-channel-name"
                          classList={{ pending: row.state === "pending" }}
                        >
                          {row.name}
                        </span>
                      </button>
                      {/* UX-5 bucket BK (2026-05-19): × on every pseudo-row.
                        Pre-BK pseudo-rows were uncloseable — a failed JOIN
                        left a sticky greyed row + a duplicate archive
                        entry (visibleArchiveForNetwork filtered only live
                        channelsBySlug/queryWindowsByNetwork, not
                        windowStateByChannel). Now × calls forceParted
                        (via dismissPseudoWindow) → drops the windowState
                        key unconditionally → row vanishes;
                        visibleArchiveForNetwork's pseudo-name filter
                        releases so the archive section shows the row
                        instead (single surface per window). */}
                      {/* #172: pseudo-row dismiss is a LOCAL projection clear
                        (forceParted), sidebar-only + desktop-only — the mobile
                        fat-finger problem never reaches it. It rides the same
                        <CloseButton> anyway (touch-gate is free; a desktop
                        mouse click stays instant) so every × is one code path
                        — no half-migrated second pattern. */}
                      <CloseButton
                        class="sidebar-close"
                        ariaLabel={`Close ${row.name}`}
                        onConfirm={() => dismissPseudoWindow(network.slug, row.name)}
                      />
                    </li>
                  )}
                </For>

                {/* Query (DM) windows */}
                <For each={queryWindowsByNetwork()[network.id] ?? []}>
                  {(qw) => {
                    const key = channelKey(network.slug, qw.targetNick);
                    return (
                      <li
                        classList={{ selected: isSelected(network.slug, qw.targetNick) }}
                        data-window-name={qw.targetNick}
                      >
                        <button
                          type="button"
                          onClick={() => handleClick(network.slug, qw.targetNick, "query")}
                          class={`sidebar-window-btn${isGreyed(network.slug, qw.targetNick) ? " sidebar-window-greyed" : ""}`}
                        >
                          <NickText nick={qw.targetNick} extraClass="sidebar-channel-name" />
                          <Show when={(messagesUnread()[key] ?? 0) > 0}>
                            <span class="sidebar-msg-unread">{messagesUnread()[key]}</span>
                          </Show>
                          <Show when={(eventsUnread()[key] ?? 0) > 0}>
                            <span class="sidebar-events-unread">{eventsUnread()[key]}</span>
                          </Show>
                          <Show when={(mentionCounts()[key] ?? 0) > 0}>
                            <span class="sidebar-mention">@{mentionCounts()[key]}</span>
                          </Show>
                        </button>
                        <CloseButton
                          class="sidebar-close"
                          ariaLabel={`Close DM with ${qw.targetNick}`}
                          onConfirm={() => handleCloseQuery(network.id, qw.targetNick)}
                        />
                      </li>
                    );
                  }}
                </For>
              </ul>

              {/* #71 INC-1 — own-nick footer. Surfaces the operator's IRC
                nick on THIS network — previously shown nowhere in the UI
                (issue #71 "Show the user's own nick"). Rendered per-network
                (last element of each group, below the grouping rail) so it
                degrades correctly to multi-network: each group states who you
                are on that network. Sourced from the canonical
                `ownNickForNetwork(net, me)` so the DISPLAY can never drift
                from the self-detection / DM-routing nick (the `displayNick`
                per-network footgun documented in api.ts). Non-interactive —
                identity, not a window row (no `.sidebar-window-btn`). Hidden
                when `me` is null (logged out) — the helper returns null. */}
              <Show when={ownNickForNetwork(network, user())}>
                {(nick) => (
                  <div class="sidebar-own-nick" data-testid={`sidebar-own-nick-${network.slug}`}>
                    <span class="sidebar-own-nick-emoji" aria-hidden="true">
                      👤
                    </span>
                    {/* The 👤 is aria-hidden (its glyph name is noise); this
                      sr-only prefix gives a screen reader the context that the
                      following nick is the operator's OWN identity on this
                      network, not a peer. Mirrors the away-badge aria-label
                      pattern (visible glyph hidden, meaning spoken). */}
                    <span class="sr-only">your nick: </span>
                    <span class="sidebar-own-nick-name">{nick()}</span>
                  </div>
                )}
              </Show>

              {/* CP15 B4 — Archive section, collapsed by default. Lazy fetch
                on first expand via the toggle event; entries clickable to
                set selection. Channel kind keeps the channel-shaped name;
                query kind opens the DM window for the target nick.

                UX-5 BH (2026-05-19) — lifted out of the legacy
                `<section class="sidebar-network">` wrapper that BH
                killed; now a flat sibling of the per-network `<ul>`
                inside the `<For>`. Per-network archive semantics
                preserved (one `<details>` per network). */}
              <details
                class="sidebar-archive"
                onToggle={(e) => {
                  if ((e.currentTarget as HTMLDetailsElement).open) {
                    void loadArchive(network.slug);
                  }
                }}
              >
                <summary>Archive</summary>
                {/* UX-5 BH (post-bundle fix) — the canonical row style
                    in `themes/default.css` is scoped to
                    `.sidebar-network-section li .sidebar-window-btn`.
                    Inheriting that class on the archive's inner `<ul>`
                    restores monospace + dark-theme styling for archived
                    rows (without it, the UA defaults bleed through —
                    white background, system serif font, etc). */}
                <ul class="sidebar-network-section sidebar-archive-list">
                  <For each={visibleArchiveForNetwork(network.slug, network.id)}>
                    {(entry) => {
                      const key = archiveKey(network.slug, entry.target);
                      return (
                        <li class="sidebar-archive-row" data-window-name={entry.target}>
                          <button
                            type="button"
                            class="sidebar-window-btn"
                            onClick={() => {
                              // UX-3 Z: re-open archived query window as live
                              // so cic subscribes to the per-channel topic and
                              // receives server broadcasts (NOTICE 401, etc.).
                              // Idempotent — no-op if already open.
                              if (entry.kind === "query") {
                                openQueryWindowState(
                                  network.id,
                                  entry.target,
                                  new Date().toISOString(),
                                );
                              }
                              handleClick(
                                network.slug,
                                entry.target,
                                entry.kind === "channel" ? "channel" : "query",
                              );
                            }}
                          >
                            {entry.kind === "query" ? (
                              <NickText
                                nick={entry.target}
                                extraClass="sidebar-channel-name parted"
                              />
                            ) : (
                              <span class="sidebar-channel-name parted">{entry.target}</span>
                            )}
                          </button>
                          <InlineConfirmButton
                            idleLabel="×"
                            confirmLabel="really delete?"
                            armed={armedArchiveKey() === key}
                            onArm={() => setArmedArchiveKey(key)}
                            onConfirm={() => handleConfirmArchiveDelete(network.slug, entry.target)}
                            testId={`archive-delete-${network.slug}-${entry.target}`}
                            extraClass="sidebar-archive-delete"
                          />
                        </li>
                      );
                    }}
                  </For>
                </ul>
              </details>
            </>
          )}
        </For>
      </Show>
    </>
  );
};

export default Sidebar;
