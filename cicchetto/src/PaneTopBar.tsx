import type { Component, JSX } from "solid-js";

/**
 * #1073 — the pane top bar, extracted from `TopicBar` so the admin console can
 * render THE SAME BAR rather than a lookalike rebuilt on the `--adm-*` layer.
 * vjt: *"la top bar admin dev'esser possibilmente la stessa barra che abbiamo
 * per i canali, solo con dentro roba diversa"*.
 *
 * What is shared is the BAND, and the band turned out to be small and entirely
 * channel-agnostic: a flex row carrying `--pane-chrome-inset-*` padding, a
 * bottom border, a `flex: 1` content slot, and the ☰ as its LAST child. What
 * is channel-specific — the namebox, the mode string, the topic strip and the
 * two modals — never belonged to the band at all, and stays in `TopicBar`.
 *
 * `TopicBar`'s own props are `networkSlug`, `channelName` and
 * `onToggleMembers`; everything else it renders is derived from stores. So the
 * component could never have been handed different content, which is why this
 * is an extraction and not a parameterisation.
 *
 * ## The ☰ side comes for free, and that is the point
 *
 * The admin ☰ was never a second hamburger — `AdminPane` mounts the very same
 * `RailOpenerButton` non-channel windows use. The two surfaces disagreed about
 * the SIDE because their hosts differ: `.shell-chrome` is a zero-height
 * `justify-content: flex-end` floater, while `.admin-pane-header` was a real
 * band that put its opener FIRST. Hosting admin on this bar resolves the
 * placement by construction — the glyph is last here — instead of by another
 * CSS override. `TopicBar.test.tsx` pins that ordering (#1073
 * characterization) precisely because an innocent reshuffle of this JSX would
 * otherwise move both bars at once.
 *
 * ## One band in, one band out
 *
 * The reason `AdminPane` hosts its opener inline at all (`AdminPane.tsx`) is
 * that the admin window must show ONE band of chrome rather than a near-empty
 * `.shell-chrome` row stacked above the pane's own header — Shell suppresses
 * that row for the admin kind. Moving admin onto this bar preserves that: the
 * bar IS the one band.
 *
 * `railLabel` is a required prop rather than a default because the two hosts
 * genuinely name the same door differently — the channel bar's ☰ has always
 * been *"open members sidebar"*, and changing it would rewrite the eight specs
 * that click it by that name.
 */
export type Props = {
  /**
   * The bar's left group, rendered inside `.topic-bar-header`. That wrapper
   * carries `flex: 1; min-width: 0`, so a caller wanting ellipsis gets the
   * chain for free; it also carries `align-items: flex-start`, which exists
   * for #344's intra-block line registration on the channel bar.
   */
  children: JSX.Element;
  onOpenRail: () => void;
  /** Accessible name for the ☰ — the two hosts word this door differently. */
  railLabel: string;
};

const PaneTopBar: Component<Props> = (props) => {
  return (
    <div class="topic-bar">
      <div class="topic-bar-header">{props.children}</div>
      {/* #881 — UNCONDITIONAL. This ☰ is not a members toggle, it is the rail
          door: on mobile it opens `.shell-members`, the permanent right rail
          hosting Archive, Settings, Rooms and Admin. It used to sit behind
          `windowIsJoined` on the premise that it toggled a member list, and
          that gate took the whole navigation with it, stranding a
          `:failed`/`:kicked`/`:parked` window with no way out. Joinedness
          gates the LIST, never the DOOR. */}
      <button
        type="button"
        class="topic-bar-hamburger shell-chrome-btn"
        aria-label={props.railLabel}
        onClick={props.onOpenRail}
      >
        {"\u{2630}"}
      </button>
    </div>
  );
};

export default PaneTopBar;
