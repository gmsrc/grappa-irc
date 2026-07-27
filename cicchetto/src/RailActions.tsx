import { type Component, Show } from "solid-js";
import { archiveSlugForSelection } from "./lib/archiveContext";
import { channelKey } from "./lib/channelKey";
import { membersByChannel } from "./lib/members";
import {
  type MobilePanelSetters,
  openAdminPanel,
  openArchivePanel,
  openHomePanel,
  openListPanel,
  openSettingsPanel,
  openThemesPanel,
} from "./lib/mobilePanel";
import { isAdmin } from "./lib/networks";
import { channelPresenceVisible, setChannelPresencePref } from "./lib/presenceFilter";
import { selectedChannel, setSelectedChannel } from "./lib/selection";
import {
  ADMIN_WINDOW_NAME,
  ADMIN_WINDOW_SLUG,
  HOME_WINDOW_NAME,
  HOME_WINDOW_SLUG,
  LIST_WINDOW_NAME,
} from "./lib/windowKinds";

// #473 — RailActions: the ONE labelled button drawer pinned at the BOTTOM of
// the members rail (`.shell-members`). It carries EVERY rail affordance and is
// mounted, unchanged, by BOTH branches of the `isMobile()` split in Shell.tsx —
// one component, one place, same buttons on desktop and mobile. It supersedes
// the two split surfaces the post-#71 rail rework left behind: the
// `ActionCluster` (cog + denoise) that sat at the TOP, and the mobile-only
// `.mobile-panel-actions` footer (home / rooms / themes / admin / archive) that
// sat at the bottom — desktop never got the second group at all (a cog and a
// monkey). See issue #473.
//
// Buttons, in order: home · rooms · themes · archive · settings · admin ·
// denoise. Each carries its NAME as visible text next to the glyph (#473: the
// bare emoji had to be guessed / long-pressed; `denoise` in particular gives
// the 👁/🙈 toggle a name it never had in the UI).
//
// Gating is CAPABILITY-only — the mobile-only form-factor gates are dropped:
//   * home / themes / settings / archive — always.
//   * rooms — needs a network context (`archiveSlugForSelection()`, the shared
//     "which network is this launcher active for" accessor).
//   * admin — `isAdmin()` (single source of truth shared with the Sidebar admin
//     row + SettingsDrawer admin entry).
//   * denoise — channel-gated (a channel window is selected).
//
// #473 — `archive` is ALWAYS shown, like settings — NOT selection-gated. The
// archive rework makes `ArchiveModal` the SINGLE archive surface, grouped
// per network. Gating it on the current selection's network (as the old
// mobile footer chip did) would leave that one surface UNREACHABLE from
// home / mentions / admin (no network → `archiveSlugForSelection()` null),
// which contradicts the ruling. rooms stays selection-gated because it
// navigates to a per-network `$list` window; archive does not.
//
// The window-nav launchers (home / rooms / admin) and the own-signal launchers
// (settings / themes / archive) route through the SAME `lib/mobilePanel` mutex
// helpers used before this change, so the members | settings | archive | none
// invariant is untouched and the helpers stay the single mutex path. On the
// permanent desktop rail the drawer-closing arm of those helpers is a harmless
// no-op (`.shell-members` is a grid child, always visible; the `open` class
// only drives the mobile `position: fixed` drawer) — so ONE handler set is
// correct on both form factors.

export type Props = {
  /**
   * The three Shell-local signals the mobilePanel mutex helpers wrap. The only
   * prop this drawer needs — every other input (selection, isAdmin, network
   * context, presence pref) is read directly from its store, matching the
   * house style (ShellChrome / the former ActionCluster read stores directly).
   */
  setters: MobilePanelSetters;
};

const RailActions: Component<Props> = (props) => {
  // The channel this rail is currently showing, or null on non-channel windows
  // — drives the channel-gated denoise toggle (any channel: the toggle writes a
  // pref that persists to reconnect, so it is meaningful on parked channels
  // too). Mirrors the former Shell `railChannel` memo, now owned here.
  const channel = (): { networkSlug: string; channelName: string } | null => {
    const sel = selectedChannel();
    return sel && sel.kind === "channel"
      ? { networkSlug: sel.networkSlug, channelName: sel.channelName }
      : null;
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: role="group" gives the button cluster an accessible name; biome suggests <fieldset>, a form-control grouping (needs <legend>, paints a border) — wrong for a rail toolbar of action buttons.
    <div class="rail-actions" role="group" aria-label="window actions">
      {/* #291 — home launcher. Always visible; leftmost/topmost. */}
      <button
        type="button"
        class="shell-chrome-btn rail-action rail-action-home"
        aria-label="open home"
        data-testid="mobile-panel-home"
        onClick={() =>
          openHomePanel(props.setters, () =>
            setSelectedChannel({
              networkSlug: HOME_WINDOW_SLUG,
              channelName: HOME_WINDOW_NAME,
              kind: "home",
            }),
          )
        }
      >
        <span class="rail-action-icon" aria-hidden="true">
          {"\u{1F3E0}"}
        </span>
        <span class="rail-action-label">home</span>
      </button>

      {/* #361 — rooms launcher (channel directory / $list). Gated on a network
          context; labelled `rooms` (#473 naming note), testid kept as
          `mobile-panel-list` so existing tests keep pointing at a real thing. */}
      <Show when={archiveSlugForSelection()}>
        {(slug) => (
          <button
            type="button"
            class="shell-chrome-btn rail-action rail-action-rooms"
            aria-label="open rooms"
            data-testid="mobile-panel-list"
            onClick={() =>
              openListPanel(props.setters, () =>
                setSelectedChannel({
                  networkSlug: slug(),
                  channelName: LIST_WINDOW_NAME,
                  kind: "list",
                }),
              )
            }
          >
            <span class="rail-action-icon" aria-hidden="true">
              {"\u{1F4C7}"}
            </span>
            <span class="rail-action-label">rooms</span>
          </button>
        )}
      </Show>

      {/* #75/#332 — themes launcher: opens the settings drawer on the themes
          sub-page (openThemesPanel deep-links via settingsNav). Always. */}
      <button
        type="button"
        class="shell-chrome-btn rail-action rail-action-themes"
        aria-label="open themes"
        data-testid="mobile-panel-themes"
        onClick={() => openThemesPanel(props.setters)}
      >
        <span class="rail-action-icon" aria-hidden="true">
          {"\u{1F3A8}"}
        </span>
        <span class="rail-action-label">themes</span>
      </button>

      {/* #473 — archive launcher. ALWAYS shown (like settings), NOT
          selection-gated: opens the ONE grouped ArchiveModal (all networks,
          collapsible) via the shared archive mutex helper. testid kept as
          `mobile-panel-archive` so the specs that pointed at the retired
          mobile footer chip keep pointing at a real thing. */}
      <button
        type="button"
        class="shell-chrome-btn rail-action rail-action-archive"
        aria-label="open archive"
        data-testid="mobile-panel-archive"
        onClick={() => openArchivePanel(props.setters)}
      >
        <span class="rail-action-icon" aria-hidden="true">
          {"\u{1F4C2}"}
        </span>
        <span class="rail-action-label">archive</span>
      </button>

      {/* #71 INC-2 — settings cog. ALWAYS rendered; the cluster-wide "settings
          reachable from every window kind" rule. testid + aria-label kept
          verbatim: many e2e specs locate it via getByLabel(/open settings/i)
          and the `action-cluster-cog` testid. */}
      <button
        type="button"
        class="shell-chrome-btn rail-action rail-action-cog"
        aria-label="open settings"
        data-testid="action-cluster-cog"
        onClick={() => openSettingsPanel(props.setters)}
      >
        <span class="rail-action-icon" aria-hidden="true">
          {"\u{2699}\u{FE0F}"}
        </span>
        <span class="rail-action-label">settings</span>
      </button>

      {/* UX-6 bucket C — admin launcher. isAdmin()-gated (capability, not form
          factor). Selection-driven: Shell mounts AdminPane on kind "admin". */}
      <Show when={isAdmin()}>
        <button
          type="button"
          class="shell-chrome-btn rail-action rail-action-admin"
          aria-label="open admin"
          data-testid="mobile-panel-admin"
          onClick={() =>
            openAdminPanel(props.setters, () =>
              setSelectedChannel({
                networkSlug: ADMIN_WINDOW_SLUG,
                channelName: ADMIN_WINDOW_NAME,
                kind: "admin",
              }),
            )
          }
        >
          <span class="rail-action-icon" aria-hidden="true">
            {"\u{1F527}"}
          </span>
          <span class="rail-action-label">admin</span>
        </button>
      </Show>

      {/* #222 — per-channel join/part/quit/nick-change suppression toggle
          (denoise). Channel-gated. One tap writes an EXPLICIT pref
          ("show"/"hide") which by the precedence rule WINS over the member-count
          size default, so it pins the channel regardless of size. Reading
          channelPresenceVisible (tracks the pref signal) keeps the icon/accent
          reactive; memberCount feeds the size-default arm for a channel with no
          explicit pref yet. #473 gives it its first visible name: "denoise". */}
      <Show when={channel()}>
        {(ch) => {
          const key = () => channelKey(ch().networkSlug, ch().channelName);
          const memberCount = (): number => (membersByChannel()[key()] ?? []).length;
          const presenceShown = (): boolean => channelPresenceVisible(key(), memberCount());
          const togglePresence = (): void =>
            setChannelPresencePref(key(), presenceShown() ? "hide" : "show");
          return (
            <button
              type="button"
              class="shell-chrome-btn rail-action rail-action-presence-toggle"
              classList={{ "presence-hidden": !presenceShown() }}
              data-testid="presence-toggle"
              aria-pressed={!presenceShown()}
              title={
                presenceShown()
                  ? "Hide join/part/quit for this channel"
                  : "Show join/part/quit for this channel"
              }
              aria-label="denoise join/part/quit signalling"
              onClick={togglePresence}
            >
              <span class="rail-action-icon" aria-hidden="true">
                {presenceShown() ? "\u{1F441}" : "\u{1F648}"}
              </span>
              <span class="rail-action-label">denoise</span>
            </button>
          );
        }}
      </Show>
    </div>
  );
};

export default RailActions;
