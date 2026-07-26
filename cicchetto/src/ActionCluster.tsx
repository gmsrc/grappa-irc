import { type Component, Show } from "solid-js";
import { channelKey } from "./lib/channelKey";
import { membersByChannel } from "./lib/members";
import { channelPresenceVisible, setChannelPresencePref } from "./lib/presenceFilter";

// #71 INC-2 — the right-rail action cluster: the window-scoped button group R1
// makes a PERMANENT surface. Shell.tsx mounts it in the always-present rail
// (desktop right column / mobile drawer) so its buttons are reachable from
// EVERY window kind. It ships carrying exactly two affordances:
//
//   * settings cog (⚙) — ALWAYS rendered. The cluster-wide "settings cog
//     reachable from every window kind" rule (previously ShellChrome's job)
//     now lives here; R1's permanent rail is what makes that reachable on the
//     non-channel tabs (home / server / list / mentions / admin) too.
//   * presence toggle (👁/🙈) — CHANNEL-GATED: rendered only when the rail is
//     showing a channel window (`props.channel` non-null). Moved verbatim out
//     of TopicBar (#222 lived there); a topic bar is not a per-window action
//     surface, and "one design" wants the toggle in the cluster on both form
//     factors.
//
// Intentionally a THIN flex group of buttons. R1's stated future is for the
// rail to ALSO carry per-tab-kind context (server → /lusers, query → /whois).
// That content grafts in as SIBLINGS of this cluster inside the rail container
// (Shell.tsx), NOT here — this component stays "just the buttons" (vjt ruling,
// issue #71 comment 5084202718). Do NOT add contextual content to it.

export type Props = {
  /** Opens the SettingsDrawer. Required — the cog is always rendered. */
  onOpenSettings: () => void;
  /**
   * The channel this rail is currently showing, or null on non-channel
   * windows. Drives the channel-gated presence toggle: null ⇒ cog only.
   */
  channel: { networkSlug: string; channelName: string } | null;
};

const ActionCluster: Component<Props> = (props) => {
  return (
    // biome-ignore lint/a11y/useSemanticElements: role="group" gives the button cluster an accessible name; biome suggests <fieldset>, a form-control grouping (needs <legend>, paints a border) — wrong for a rail toolbar of action buttons.
    <div class="action-cluster" role="group" aria-label="window actions">
      <Show when={props.channel}>
        {(ch) => {
          // #222 — per-channel join/part/quit/nick-change suppression toggle
          // (moved verbatim from TopicBar). One tap writes an EXPLICIT pref
          // ("show"/"hide") which by the precedence rule WINS over the member
          // count size default, so it pins the channel regardless of size.
          // Reading channelPresenceVisible (which tracks the pref signal) keeps
          // the icon/label reactive; memberCount feeds the size-default arm for
          // a channel with no explicit pref yet.
          const key = () => channelKey(ch().networkSlug, ch().channelName);
          const memberCount = (): number => (membersByChannel()[key()] ?? []).length;
          const presenceShown = (): boolean => channelPresenceVisible(key(), memberCount());
          const togglePresence = (): void =>
            setChannelPresencePref(key(), presenceShown() ? "hide" : "show");
          return (
            <button
              type="button"
              class="shell-chrome-btn action-cluster-presence-toggle"
              classList={{ "presence-hidden": !presenceShown() }}
              data-testid="presence-toggle"
              aria-pressed={!presenceShown()}
              title={
                presenceShown()
                  ? "Hide join/part/quit for this channel"
                  : "Show join/part/quit for this channel"
              }
              aria-label="filter join/part/quit signalling"
              onClick={togglePresence}
            >
              {presenceShown() ? "👁" : "🙈"}
            </button>
          );
        }}
      </Show>
      <button
        type="button"
        class="shell-chrome-btn action-cluster-cog"
        aria-label="open settings"
        data-testid="action-cluster-cog"
        onClick={props.onOpenSettings}
      >
        {"\u{2699}\u{FE0F}"}
      </button>
    </div>
  );
};

export default ActionCluster;
