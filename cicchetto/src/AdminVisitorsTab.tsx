import { type Component, createSignal, For, onMount, Show } from "solid-js";
import AdminBadge from "./admin/AdminBadge";
import AdminCard from "./admin/AdminCard";
import AdminDetailPanel from "./admin/AdminDetailPanel";
import AdminFacts from "./admin/AdminFacts";
import AdminRowName from "./admin/AdminRowName";
import { AdminEmpty, AdminError } from "./admin/AdminStatus";
import AdminTable from "./admin/AdminTable";
import { connectionTone } from "./admin/connectionTone";
import { useRefreshSlot } from "./admin/refreshSlot";
import InlineConfirmButton from "./InlineConfirmButton";
import {
  type AdminVisitor,
  type AdminVisitorNetwork,
  ApiError,
  adminDeleteVisitor,
  adminDisconnectSession,
  adminListVisitors,
  adminReconnectSession,
  adminVisitorSessionId,
} from "./lib/api";
import { token } from "./lib/auth";
import { connectionStateEmoji } from "./lib/connectionStateEmoji";

// M-cluster M-8 — Visitors admin tab. Fetches GET /admin/visitors
// (M-4 endpoint, live) and renders one row per visitor with an
// inline-confirm Delete button that fires DELETE /admin/visitors/:id
// (M-3 endpoint, live).
//
// State model:
//   * `visitors: AdminVisitor[] | null` — null = pre-first-fetch
//     (distinct from `[]` = "fetched, no visitors"). Driven by
//     `refresh()` not `createResource` so the splice-after-delete
//     semantics + error-while-preserving-data are explicit.
//   * `confirmingId: string | null` — per-row inline-confirm state.
//     Sticky (no timeout, no global click reset, no cancel button)
//     per MD4 + design Q2. Switching rows re-arms the new row.
//   * `error` / `loading` — surfaces for the refresh button banner.
//
// Inline-confirm state machine (per design Q6):
//   idle ──Delete(X)──▶ armed(X)
//   armed(X) ──Delete(X)──▶ pending(X) ──204──▶ idle (row gone)
//                                          └──err──▶ idle (banner)
//   armed(X) ──Delete(Y, Y≠X)──▶ armed(Y)
//
// Per `feedback_solidjs_for_ref_leak`: NO let-bound refs inside the
// `<For>` row. The delete handler closes over `v.id` (string copy)
// so even after splice the closure holds a primitive, not a DOM
// pointer.
//
// Per `feedback_css_block_button_wraps_inline_prefix`: the delete
// button's text transitions are the load-bearing UX signal. vitest
// + Playwright both assert textContent directly.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.
// AdminPane's mount gate (M-7 isAdmin() predicate) is the
// reachability boundary; non-admin + visitor can't get here. Per-
// class loop applies at the M-7 layer, not here.
//
// M-8 ships the minimum useful surface. M-9 enriches with richer
// introspection (mailbox_len, memory_bytes, pid_inspect,
// introspection_degraded detail). M-11 wires
// `grappa:admin:events` so the list auto-updates when other
// admins delete or visitors reap; until then a refresh button is
// the only re-fetch surface.

const AdminVisitorsTab: Component = () => {
  const [visitors, setVisitors] = createSignal<AdminVisitor[] | null>(null);
  const [confirmingId, setConfirmingId] = createSignal<string | null>(null);
  // #269 — per-(visitor, network) toggle armed-state, keyed
  // `"<visitor_id>:<network_slug>"`. Disjoint from `confirmingId` (the
  // Delete-column arm) so a Disconnect/Reconnect arm on one network row
  // doesn't fight the Delete arm — different columns, different verbs.
  const [confirmingToggleKey, setConfirmingToggleKey] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  // Which row's detail panel is open. Mobile-only in effect: on desktop
  // every column is on screen and the opener is not rendered.
  const [detailId, setDetailId] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const refresh = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    setLoading(true);
    setError(null);
    // Reset inline-confirm state so a refresh can't leave a stale
    // armed-state pointing at a row the server-side list no longer
    // contains (other admin deleted; visitor reaped). Maintains the
    // "armed row exists in `visitors()`" invariant required by the
    // M-11 grappa:admin:events live-refit.
    setConfirmingId(null);
    setConfirmingToggleKey(null);
    try {
      const next = await adminListVisitors(t);
      setVisitors(next);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "fetch_failed";
      setError(code);
    } finally {
      setLoading(false);
    }
  };

  const onDeleteConfirm = async (v: AdminVisitor): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminDeleteVisitor(t, v.id);
      // Splice (NOT refetch) — keeps scroll position + avoids flash.
      const cur = visitors();
      if (cur !== null) setVisitors(cur.filter((x) => x.id !== v.id));
      setConfirmingId(null);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "delete_failed";
      setError(code);
      setConfirmingId(null);
    }
  };

  // #269 — per-(visitor, network) toggle arm key. One toggle per network
  // row (Disconnect ⇄ Reconnect are mutually exclusive by live_state), so
  // the slug is enough — no action-kind discriminant needed in the key.
  const toggleKey = (v: AdminVisitor, net: AdminVisitorNetwork): string =>
    `${v.id}:${net.network_slug}`;

  // #269 — fire the per-network toggle. The action is chosen by LIVE truth
  // (`net.live_state`), NOT the DB `connection_state`: a live session
  // Disconnects (reusing the existing POST .../disconnect endpoint), a
  // downed one (live_state === null) Reconnects (POST .../reconnect). Both
  // build the composite `visitor:<id>:<network_id>` id server-side keys on.
  const runToggle = async (v: AdminVisitor, net: AdminVisitorNetwork): Promise<void> => {
    const t = token();
    if (t === null) return;
    const live = net.live_state !== null;
    const kind = live ? "disconnect" : "reconnect";
    const fn = live ? adminDisconnectSession : adminReconnectSession;
    setError(null);
    try {
      await fn(t, adminVisitorSessionId(v, net));
      setConfirmingToggleKey(null);
      // Re-fetch (NOT splice) — the action mutates live BEAM state the
      // /admin/visitors response reflects on the next call: Disconnect
      // drops the pid → live_state:null; Reconnect spawns it →
      // live_state non-null. The row STAYS; only its per-network
      // live_state flips, which re-derives the toggle affordance.
      await refresh();
    } catch (e) {
      // Prefix with the verb so the operator can tell a failed disconnect
      // from a failed reconnect (mirrors AdminSessionsTab's `${kind}: ${code}`).
      const code = e instanceof ApiError ? e.code : "request_failed";
      setError(`${kind}: ${code}`);
      setConfirmingToggleKey(null);
    }
  };

  // The pane header renders this tab's refresh (see
  // `admin/refreshSlot.ts`): the toolbar that used to hold it said
  // nothing the nav above does not already say.
  useRefreshSlot({
    onRefresh: () => {
      void refresh();
    },
    busy: loading,
    label: "refresh visitors list",
    testId: "admin-visitors-refresh",
  });

  const detailVisitor = (): AdminVisitor | undefined =>
    (visitors() ?? []).find((v) => v.id === detailId());

  onMount(() => {
    void refresh();
  });

  return (
    <div class="admin-visitors-tab">
      <div class="adm-scroll">
        <Show when={error() !== null}>
          <AdminError message={error() ?? ""} testId="admin-visitors-error" />
        </Show>

        <Show when={visitors() === null && error() === null}>
          <AdminEmpty message="loading…" />
        </Show>

        <Show when={visitors() !== null && (visitors() ?? []).length === 0}>
          <AdminEmpty message="no visitors" testId="admin-visitors-empty" />
        </Show>

        <Show when={detailVisitor()}>
          {(v) => (
            <AdminDetailPanel
              title={v().networks[0]?.nick ?? "visitor"}
              subtitle="the columns the table drops on a phone"
              onClose={() => setDetailId(null)}
              closeLabel="close visitor details"
              data-testid={`admin-visitor-detail-${v().id}`}
            >
              <AdminFacts
                facts={[
                  { label: "ip", value: v().ip ?? "—" },
                  { label: "expires", value: renderExpires(v()) },
                  { label: "joined", value: renderInserted(v().inserted_at) },
                ]}
              />
            </AdminDetailPanel>
          )}
        </Show>

        <Show when={visitors() !== null && (visitors() ?? []).length > 0}>
          <AdminCard
            hostsRefresh
            title="Visitors"
            subtitle={`${(visitors() ?? []).length} visitors`}
            data-testid="admin-visitors-table-card"
          >
            <AdminTable data-testid="admin-visitors-table">
              <thead>
                <tr>
                  {/* "id", not "identified": the header was the widest
                      thing in a one-dot column and it was squeezing the
                      actions column until Disconnect read as "Disc". */}
                  <th>id</th>
                  <th class="adm-table-grow">networks (state · nick)</th>
                  {/* Secondary below 900px — into the row's detail panel.
                      The networks cell IS the visitor's identity here
                      (there is no name column), so it stays, and the
                      identified dot is one dot wide. */}
                  <th class="adm-col-detail">ip</th>
                  <th class="adm-col-detail">expires</th>
                  <th class="adm-col-detail">joined</th>
                  <th class="adm-table-sticky-actions">actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={visitors() ?? []}>
                  {(v) => (
                    <tr class="admin-visitors-row" data-testid={`admin-visitor-row-${v.id}`}>
                      <td>
                        {/* A dot, like every other state in the pane. Colour
                            alone is not an accessible answer to a yes/no
                            question, so the `aria-label` carries the word —
                            no visually-hidden copy, same reasoning as
                            `NetworkStateEmoji` below. Neutral rather than
                            danger for "no": an anonymous visitor is the
                            normal case, not a fault. */}
                        <AdminBadge
                          tone={v.identified ? "ok" : "neutral"}
                          class="adm-badge--dot"
                          ariaLabel={v.identified ? "identified" : "not identified"}
                        >
                          {""}
                        </AdminBadge>
                      </td>
                      <td>
                        {/* #211 phase 7 — a visitor is multi-network; render
                            one line per attached network with its own
                            live-state badge + nick + slug. Empty = a
                            credential-less identity. */}
                        <Show
                          when={v.networks.length > 0}
                          fallback={<span class="muted">no networks</span>}
                        >
                          <ul class="admin-visitor-networks">
                            <For each={v.networks}>
                              {(net) => (
                                <li
                                  data-testid={`admin-visitor-network-${v.id}-${net.network_slug}`}
                                >
                                  <LiveBadge live={net.live_state} />
                                  <span class="admin-visitor-network-nick">{net.nick}</span>
                                  <span class="admin-visitor-network-slug">{net.network_slug}</span>
                                  <NetworkStateEmoji state={net.connection_state} />
                                </li>
                              )}
                            </For>
                          </ul>
                        </Show>
                        {/* The opener sits at the END of this cell, not on
                            a name column, because a visitor HAS no name
                            column — its identity is the per-network nick
                            list above. Mobile-only, like every other
                            `AdminRowName`. */}
                        <AdminRowName
                          open={detailId() === v.id}
                          onToggle={() => setDetailId(detailId() === v.id ? null : v.id)}
                          label={`details for visitor ${v.id}`}
                          testId={`admin-visitor-details-${v.id}`}
                        >
                          details
                        </AdminRowName>
                      </td>
                      <td class="adm-col-detail">{v.ip ?? "—"}</td>
                      <td class="adm-col-detail">{renderExpires(v)}</td>
                      <td class="adm-col-detail">{renderInserted(v.inserted_at)}</td>
                      <td class="adm-table-sticky-actions">
                        {/* #269 — the per-network Disconnect ⇄ Reconnect toggle
                            lives HERE, ahead of Delete, so the actions column
                            reads the same as the Sessions tab's.

                            It stays per-NETWORK, because that is what the verb
                            acts on: a visitor attached to two networks gets two
                            buttons, each naming its network so the pair is never
                            ambiguous. With one network — the common case — the
                            cell is Disconnect + Delete, exactly like Sessions.

                            The affordance keys off LIVE truth (net.live_state),
                            NOT the DB connection_state, so a `:connected` row
                            whose pid is gone correctly offers Reconnect. */}
                        <For each={v.networks}>
                          {(net) => (
                            <InlineConfirmButton
                              idleLabel={`${net.live_state !== null ? "Disconnect" : "Reconnect"}${
                                v.networks.length > 1 ? ` ${net.network_slug}` : ""
                              }`}
                              confirmLabel="Confirm"
                              armed={confirmingToggleKey() === toggleKey(v, net)}
                              onArm={() => setConfirmingToggleKey(toggleKey(v, net))}
                              onConfirm={() => runToggle(v, net)}
                              testId={`admin-visitor-toggle-${v.id}-${net.network_slug}`}
                              extraClass={
                                net.live_state !== null ? "disconnect-btn" : "reconnect-btn"
                              }
                            />
                          )}
                        </For>
                        <InlineConfirmButton
                          idleLabel="Delete"
                          confirmLabel="Confirm"
                          armed={confirmingId() === v.id}
                          onArm={() => setConfirmingId(v.id)}
                          onConfirm={() => onDeleteConfirm(v)}
                          testId={`admin-visitor-delete-${v.id}`}
                          extraClass="delete-btn"
                        />
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </AdminTable>
          </AdminCard>
        </Show>
      </div>
    </div>
  );
};

// M-8 live_state badge — three visual states. M-9 will add a
// detail surface for mailbox_len / memory_bytes / pid_inspect /
// introspection_degraded; M-8 keeps the per-row rendering minimal.
const LiveBadge: Component<{ live: AdminVisitorNetwork["live_state"] }> = (props) => {
  if (props.live === null) {
    // U-0 honesty signal per `feedback_no_silent_drops_closed`.
    // DB intent active, BEAM has no pid for this visitor.
    return (
      <AdminBadge
        tone="danger"
        class="live-badge none"
        ariaLabel="BEAM has no pid for this visitor"
      >
        BEAM has no pid
      </AdminBadge>
    );
  }
  if (props.live.alive === false) {
    return (
      <AdminBadge
        tone="warn"
        class="live-badge dead"
        ariaLabel="pid registered but Session.Server is dead"
      >
        pid registered but dead
      </AdminBadge>
    );
  }
  const channels = props.live.joined_channels;
  // `channels === null` means introspection of the joined_channels
  // field timed out — `introspection_degraded` carries the atom
  // names but M-8 doesn't surface per-field degradation detail.
  // M-9 (Sessions tab) renders the full degradation list.
  const count = channels === null ? "?" : channels.length;
  return (
    <AdminBadge tone="ok" class="live-badge alive" ariaLabel={`alive on ${count} channels`}>
      {count} chan
    </AdminBadge>
  );
};

// ADMIN-LAYOUT-FIX (2026-07-12) — the DB-canonical connection_state
// glyph. SEPARATE truth from LiveBadge above: this reflects
// `net.connection_state` (Networks.Credential, the DB intent), NOT the
// live pid. Per CLAUDE.md "DB state and live state are separate sources
// of truth" both render in the cell. The word (`title` + `aria-label`)
// is the a11y text AND the vitest seam; the glyph map lives in the pure
// connectionStateEmoji.ts so an unexpected value degrades to ⚪, never
// throws.
// The admin console shows this state as a toned badge rather than the
// emoji glyph. An emoji is a font-dependent picture: it can't follow the
// theme, it renders differently per platform, and it sits at odds with
// every other status in the redesigned pane. `connectionStateEmoji`
// stays the source of truth for the WORD — the a11y text and the vitest
// seam, asserted by label rather than codepoint — and keeps its glyph
// for `ServerInfoCard`, which is IRC-client chrome and outside this
// redesign. The word → tone mapping lives in `admin/connectionTone.ts`
// because Credentials renders the same field and a second copy is how
// the two tabs would drift.

const NetworkStateEmoji: Component<{ state: AdminVisitorNetwork["connection_state"] }> = (
  props,
) => {
  const label = () => connectionStateEmoji(props.state).label;
  return (
    <AdminBadge
      tone={connectionTone(props.state)}
      class="admin-visitor-network-state adm-badge--dot"
      ariaLabel={label()}
    >
      {/* No text child. The dot carries the state visually and the
          `aria-label` carries it to assistive tech — and since aria-label
          OVERRIDES the subtree for the accessible name, a visually-hidden
          copy of the same word would be dead weight that also re-leaks the
          raw state into `textContent`, which is exactly what the
          ADMIN-LAYOUT-FIX assertion below forbids. */}
      {""}
    </AdminBadge>
  );
};

// expires_at presentation. #211 phase 7 — "registered/permanent" is
// DERIVED from the credentials, NOT `is_nil(expires_at)`. The server's
// `identified` field (admin_wire.ex:81) is
// `Enum.any?(per_network, fn {cred, _} -> cred.password_encrypted != nil end)`
// — a visitor who committed a NickServ password on ANY network. Phase 7
// STOPPED clearing `expires_at` on commit_password/3 (DESIGN_NOTES
// 2026-07-12), so a registered visitor now carries an anon-shaped
// sliding `expires_at` AND `identified: true`. Keying the display off
// `expires_at === null` would tell the operator a registered visitor is
// counting down to reaping (it isn't — the Reaper excludes registered
// via the derived NOT-IN subquery). So trust `v.identified` first; the
// legacy `expires_at IS NULL` case only fires for pre-phase-7 permanent
// rows. The "(NickServ)" parenthetical is the Bucket-D honesty cue:
// "indefinite because identified" vs "indefinite because of a bug".
function renderExpires(v: AdminVisitor): string {
  if (v.identified) return "indefinite (NickServ)";
  if (v.expires_at === null) return "indefinite (legacy)";
  const diffMs = new Date(v.expires_at).getTime() - Date.now();
  if (diffMs <= 0) return "expired";
  return formatRelativeFuture(diffMs);
}

function renderInserted(insertedAt: string): string {
  const diffMs = Date.now() - new Date(insertedAt).getTime();
  if (diffMs < 1000) return "just now";
  return `${formatRelativeMagnitude(diffMs)} ago`;
}

function formatRelativeFuture(diffMs: number): string {
  return `in ${formatRelativeMagnitude(diffMs)}`;
}

function formatRelativeMagnitude(diffMs: number): string {
  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

export default AdminVisitorsTab;
