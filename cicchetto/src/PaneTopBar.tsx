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
 *
 * ## #1697 — the trailing control became a SLOT, and the ☰ became a passenger
 *
 * The third host is the rail's radio picker, and it is the one that broke the
 * "extraction, not parameterisation" reading above. Two measured reasons, and
 * either alone is decisive: the picker's trailing control must be a ✕ (a
 * rail-opener inside the already-open rail is a door to the floor you are
 * standing on), and `.topic-bar .topic-bar-hamburger` is `display: none` on
 * desktop — so a picker inheriting the ☰ would lose its only dismiss control
 * to a CSS rule written for a different host.
 *
 * So `trailing` is a slot, and the ☰ moved out into `PaneTopBarRailOpener`,
 * which both original hosts render. The emitted markup is unchanged for them,
 * which is why #1073's ordering pin in `TopicBar.test.tsx` and the accessible
 * name in `AdminPane.test.tsx` stay green without an edit — the extraction's
 * invariant (the trailing child is what puts the control on the right) is now
 * stated by the slot rather than by the hard-coded button.
 *
 * The slot is REQUIRED, not defaulted to the ☰: a default would let a new host
 * inherit a rail door it never asked for, silently, which is the degradation
 * pattern this codebase bans.
 */
export type Props = {
  /**
   * The bar's left group, rendered inside `.topic-bar-header`. That wrapper
   * carries `flex: 1; min-width: 0`, so a caller wanting ellipsis gets the
   * chain for free; it also carries `align-items: flex-start`, which exists
   * for #344's intra-block line registration on the channel bar.
   */
  children: JSX.Element;
  /**
   * The band's LAST child. Being last is what places it on the right, on every
   * surface wearing this band (#1073) — so a host passes the control itself,
   * not a callback the band wraps.
   */
  trailing: JSX.Element;
};

export type RailOpenerProps = {
  onOpenRail: () => void;
  /** Accessible name for the ☰ — the hosts word this door differently. */
  railLabel: string;
};

/**
 * #881 — UNCONDITIONAL. This ☰ is not a members toggle, it is the rail door: on
 * mobile it opens `.shell-members`, the permanent right rail hosting Archive,
 * Settings, Rooms and Admin. It used to sit behind `windowIsJoined` on the
 * premise that it toggled a member list, and that gate took the whole
 * navigation with it, stranding a `:failed`/`:kicked`/`:parked` window with no
 * way out. Joinedness gates the LIST, never the DOOR.
 *
 * #1697 lifted it out of the band's body so the band could take a different
 * trailing control. It lives HERE rather than being duplicated at its two call
 * sites for the ordinary reason: two copies of a button whose class drives a
 * desktop `display: none` rule is one copy too many.
 */
export const PaneTopBarRailOpener: Component<RailOpenerProps> = (props) => {
  return (
    <button
      type="button"
      class="topic-bar-hamburger shell-chrome-btn"
      aria-label={props.railLabel}
      onClick={props.onOpenRail}
    >
      {"\u{2630}"}
    </button>
  );
};

const PaneTopBar: Component<Props> = (props) => {
  return (
    <div class="topic-bar">
      <div class="topic-bar-header">{props.children}</div>
      {props.trailing}
    </div>
  );
};

export default PaneTopBar;
