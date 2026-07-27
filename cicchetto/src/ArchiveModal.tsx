import { type Component, createSignal, For, Show } from "solid-js";
import InlineConfirmButton from "./InlineConfirmButton";
import { deleteArchiveEntry } from "./lib/api";
import {
  archivedBySlug,
  archiveModalOpen,
  loadArchive,
  setArchiveModalOpen,
  visibleArchiveForNetwork,
} from "./lib/archive";
import { token } from "./lib/auth";
import { networks } from "./lib/networks";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { openQueryWindowState } from "./lib/queryWindows";
import { setSelectedChannel } from "./lib/selection";
import NickText from "./NickText";

// #473 — the ONE archive surface, on BOTH form factors.
//
// Supersedes the two pre-#473 archive surfaces: the desktop Sidebar
// `<details class="sidebar-archive">` (one per network, inline in the
// left rail) AND the mobile-only per-network modal (opened by the
// `.mobile-panel-actions` footer chip for a single network). The ruling
// (issue #473) folds both into this modal, opened from the RailActions
// drawer's always-on archive button on every window kind.
//
// Shape: driven by the boolean `archiveModalOpen()` (was the per-network
// slug `archiveModalNetwork` — see lib/archive.ts). When open the modal
// renders EVERY network as a COLLAPSIBLE group (`<details>` per network,
// preserving the per-network browsing the Sidebar `<details>` provided
// instead of a flat cross-network list). Each group's body is
// `visibleArchiveForNetwork(slug, id)`.
//
// Lazy per group, NOT eager: a group loads its rows only when it is
// EXPANDED (the `<details onToggle>` fires `loadArchive(slug)`, exactly
// like the retired Sidebar `<details>`). The list can be O(hundreds) per
// network and the operator rarely opens it, so loading every network at
// modal-open would be a real change in fetch volume — the laziness is
// deliberate (issue #473). A group with zero visible entries after load
// shows an inline "no archived windows" line; the header stays so every
// network is reachable (headers can't be pre-filtered on emptiness
// without eagerly loading, which the lazy contract forbids).
//
// Reuses every UX-1 verb instead of re-implementing them:
//   - `visibleArchiveForNetwork` (lib/archive.ts) for each group's list.
//   - `InlineConfirmButton` for the two-step delete.
//   - `deleteArchiveEntry` (lib/api.ts) for the server call.
// On confirm, the server broadcasts `archive_changed` and the userTopic
// re-fetches `archivedBySlug` — the modal re-renders automatically.
//
// Singleton armed key — `<slug> <target>` composite — mutexes the active
// delete confirm across ALL rows in ALL groups. Disarms on row arming or
// modal close.
//
// Per `feedback_css_block_button_wraps_inline_prefix`: textContent of
// each row IS the load-bearing test signal. We assert on the row's
// rendered name in vitest and Playwright, not on a `::before` sigil.

const ArchiveModal: Component = () => {
  const [armedKey, setArmedKey] = createSignal<string | null>(null);
  const archiveKey = (slug: string, target: string) => `${slug} ${target}`;

  const close = () => {
    setArchiveModalOpen(false);
    setArmedKey(null);
  };

  // UX-6 bucket A — refcounted overlay scroll-lock. Tracks
  // `archiveModalOpen()` (the "is the modal open?" flag). Shared
  // createOverlayLock wiring — see overlayScrollLock.ts for the
  // semantics, including the same-task-close leak fix. #232 — the
  // shared Esc-to-close routes through the same lock (topmost-first,
  // focus-independent).
  createOverlayLock(() => archiveModalOpen(), ".archive-modal", close);

  const handleConfirmDelete = async (slug: string, target: string) => {
    const t = token();
    if (!t) return;
    try {
      await deleteArchiveEntry(t, slug, target);
    } catch {
      // Server delete failed — InlineConfirmButton disarms below on
      // the finally. Operator retries. No toast — modal is dense + a
      // generic banner wouldn't be actionable.
    } finally {
      setArmedKey(null);
    }
  };

  const handleSelectEntry = (slug: string, target: string, kind: "channel" | "query") => {
    // UX-3 Z: query-shaped archive entries must also be re-opened as
    // live query windows. setSelectedChannel alone only switches the
    // UI; it does NOT subscribe cic to the per-channel Phoenix topic.
    // Without the subscribe, any new server broadcast for this target
    // (e.g. NOTICE 401 "No such nick/channel" when the operator sends
    // a PRIVMSG to the archived peer) drops on the floor and the
    // operator sees no feedback. `openQueryWindowState` POSTs to the
    // server which persists the query_windows row and broadcasts
    // `query_window_opened`; cic's subscribe loop re-arms and joins
    // the per-channel topic. Idempotent — no-op if already open.
    if (kind === "query") {
      const net = networks()?.find((n) => n.slug === slug);
      if (net) openQueryWindowState(net.id, target, new Date().toISOString());
    }
    setSelectedChannel({
      networkSlug: slug,
      channelName: target,
      kind,
    });
    close();
  };

  return (
    <Show when={archiveModalOpen()}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc via the shared overlay stack (keybindings → runTopmostOverlayEscape) */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim */}
      <div class="archive-modal-backdrop" onClick={close}>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: inner dialog onClick only stops backdrop-click propagation; Esc closes via the shared overlay stack */}
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="archive-modal-title"
          class="archive-modal"
          onClick={(e) => e.stopPropagation()}
          tabIndex={-1}
        >
          <header class="archive-modal-header">
            <h2 id="archive-modal-title">Archive</h2>
            <button
              type="button"
              class="archive-modal-close"
              aria-label="close archive"
              onClick={close}
            >
              ×
            </button>
          </header>
          {/* One collapsible group per network. Lazy: rows load on the
              group's first expand (mirrors the retired Sidebar
              `<details class="sidebar-archive">`). */}
          <For each={networks() ?? []}>
            {(network) => {
              const entries = () => visibleArchiveForNetwork(network.slug, network.id);
              // Rows load lazily on the group's first expand (onToggle →
              // loadArchive). Distinguish "not loaded yet" (slug key absent
              // from the store) from "loaded, genuinely empty" so an
              // expanding group renders nothing while its fetch is in flight
              // instead of flashing "no archived windows" (a false-empty)
              // before the rows arrive — mirroring the retired Sidebar
              // `<details>`, which rendered an empty list during load.
              const loaded = () => archivedBySlug()[network.slug] !== undefined;
              return (
                <details
                  class="archive-modal-group"
                  data-testid={`archive-modal-group-${network.slug}`}
                  onToggle={(e) => {
                    if ((e.currentTarget as HTMLDetailsElement).open) {
                      void loadArchive(network.slug);
                    }
                  }}
                >
                  <summary class="archive-modal-group-summary">{network.slug}</summary>
                  <Show
                    when={entries().length > 0}
                    fallback={
                      <Show when={loaded()}>
                        <p class="archive-modal-empty muted">no archived windows</p>
                      </Show>
                    }
                  >
                    <ul class="archive-modal-list">
                      <For each={entries()}>
                        {(entry) => {
                          const key = archiveKey(network.slug, entry.target);
                          return (
                            <li class="archive-modal-row">
                              <button
                                type="button"
                                class="archive-modal-entry-btn"
                                onClick={() =>
                                  handleSelectEntry(network.slug, entry.target, entry.kind)
                                }
                              >
                                <span class="archive-modal-kind">{entry.kind}</span>
                                {entry.kind === "query" ? (
                                  <NickText nick={entry.target} extraClass="archive-modal-target" />
                                ) : (
                                  <span class="archive-modal-target">{entry.target}</span>
                                )}
                              </button>
                              <InlineConfirmButton
                                idleLabel="×"
                                confirmLabel="really delete?"
                                armed={armedKey() === key}
                                onArm={() => setArmedKey(key)}
                                onConfirm={() => handleConfirmDelete(network.slug, entry.target)}
                                testId={`archive-modal-delete-${network.slug}-${entry.target}`}
                                extraClass="archive-modal-delete"
                              />
                            </li>
                          );
                        }}
                      </For>
                    </ul>
                  </Show>
                </details>
              );
            }}
          </For>
        </div>
      </div>
    </Show>
  );
};

export default ArchiveModal;
