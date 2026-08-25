import type { Component, JSX } from "solid-js";

// UX-4 bucket L (2026-05-19) — sticky chrome bar at the top of
// `.shell-main`. Always rendered, regardless of selected window kind
// (channel / query / server / home / mentions / admin / empty). This is
// a cluster-wide rule: the settings cog MUST be reachable from every
// window kind, INCLUDING the server window.
//
// Slots (left → right):
//   * Rail opener (☰) — #71 INC-2: was the settings cog. R1 moved the cog
//     into the always-present right rail (RailActions), so on the mobile
//     NON-channel windows (where this bar renders) the settings cog is
//     reached by opening the rail. This button opens that rail (the same
//     `.shell-members` drawer the channel-window TopicBar ☰ opens — ONE
//     drawer, ONE glyph). The cog itself lives ONLY in the rail now.
//
// #473 — the standalone archive button (📂) was REMOVED from this bar. It
// was a THIRD archive entry point (mobile non-channel windows) that opened
// a per-network modal; the archive rework makes the RailActions drawer's
// always-on archive button the single archive door (reachable via this same
// ☰ rail opener), so the inline button became redundant.
//
// #986 — the @ mentions button left too, by the same argument and for a
// second reason: it was the only door back into a network's "you were /away"
// bundle on a phone, and #985 removes this whole band. It is a RailActions
// entry now (`rail-action-mentions`), reachable via the same ☰ — so what
// remains here is the opener and nothing else, which is exactly the state
// #985 needs in order to float a lone ☰ and drop `.shell-chrome`.
//
// #985 — and so the band went. This is no longer a row: `.shell-chrome` is a
// ZERO-HEIGHT flow box and the lone ☰ overflows it, floating over the pane's
// top-right corner (the full rationale, including why the containing block is
// this box and not `.shell-main`, lives on the CSS rule). The element and both
// testids survive on purpose — a non-channel window still needs exactly one
// door into the rail, and ~20 specs locate it here. What changed is the price:
// the scrollback now starts at the top of the pane, as it already did on a
// channel window. The `.shell-chrome-spacer` went with the row that needed it.
//
// #71 INC-2 — ShellChrome is now MOBILE-ONLY: the desktop copy was removed
// (its row freed the top for the topic; the cog moved to the permanent
// desktop rail). It renders only in Shell.tsx's mobile branch, on
// non-channel windows (channel windows get the TopicBar instead).
//
// UX-5 bucket A (2026-05-19) — the left hamburger slot was dropped.
//
// UX-5 bucket BT (2026-05-19) — a `ChromeButtons` named export
// briefly existed to let Shell.tsx mobile-channel branch render
// archive + cog inline inside TopicBar via an `inlineChromeSlot`
// prop, dropping the standalone `.shell-chrome` row on iPhone.
//
// UX-5 bucket BM (2026-05-20) — `ChromeButtons` named export DROPPED.
// BM moved the mobile-channel archive + cog into the members drawer
// footer as launchers (Shell.tsx mounts its own JSX, doesn't reuse
// chrome buttons). The wrapper default export is the only consumer
// of the archive/cog rendering today; folded back inline.

export type RailOpenerProps = {
  /**
   * #71 INC-2 — opens the right rail (the `.shell-members` drawer that hosts
   * the RailActions labelled action drawer). Required — the rail opener is always
   * rendered. Renamed from `onOpenSettings`: the cog moved into the rail, so
   * this bar's button now opens the rail rather than the settings drawer.
   */
  onOpenRail: () => void;
};

/**
 * #1766 — the BAR's props are the button's plus the leading slot. Split
 * because the two are no longer the same shape: `RailOpenerButton` is a lone
 * control that other panes mount inline, and it must not inherit a slot it has
 * nowhere to put.
 */
export type Props = RailOpenerProps & {
  /**
   * #1766 — the LEFT ☰, mirroring `PaneTopBar`'s slot of the same name so the
   * channel band and this float carry the same door. Non-empty only while the
   * mobile window bar is off; Shell owns that decision and passes the built
   * control, not a callback this box wraps.
   *
   * It costs ZERO vertical pixels: `.shell-chrome` is a `height: 0` box whose
   * children overflow it, so a second child floats over the pane's top-LEFT
   * corner exactly as the rail opener floats over the top-right. That is why
   * this is not a new band — #985 deleted the last one, priced at
   * `--chrome-tap-min + 1rem + 1px` on every mobile window.
   */
  leading: JSX.Element;
};

/**
 * #71 INC-2 — the rail opener (☰). Opens the same `.shell-members` drawer the
 * channel-window TopicBar hamburger opens (paletto: ONE drawer, one ☰ glyph
 * across both openers). The settings cog it replaced now lives in that rail's
 * RailActions drawer.
 *
 * Admin redesign (2026-08-07) — extracted from the ShellChrome body so the
 * AdminPane header can host the SAME button on mobile. The admin window is a
 * non-channel kind, so it used to stack a nearly-empty `.shell-chrome` row on
 * top of the pane's own "admin console" header — two bands of chrome for one
 * title. Shell suppresses the row for the admin kind and AdminPane renders this
 * opener inline instead, so the glyph, aria-label and `shell-chrome-rail-opener`
 * testid stay singular (bucket L: settings reachable from every window kind, and
 * on mobile the door is this ☰ — asserted for the admin window at
 * `ux-4-z-cluster-journey.spec.ts`). The two mounts are mutually exclusive:
 * ShellChrome never renders on the admin window, AdminPane only renders there.
 *
 * That exclusivity got MORE load-bearing after #985, not less. The original
 * reason was vertical: the band was a row, and stacking it over the pane's own
 * header spent two bands of chrome on one title. #985 made the band
 * zero-height and floated the lone ☰ over the pane's top-RIGHT corner — which
 * is exactly where the admin pane now puts its close × and, on a phone, its
 * refresh. So the suppression stops an overlap now, where before it only saved
 * a row.
 */
export const RailOpenerButton: Component<RailOpenerProps> = (props) => {
  return (
    <button
      type="button"
      class="shell-chrome-btn shell-chrome-rail-opener"
      aria-label="open actions"
      data-testid="shell-chrome-rail-opener"
      onClick={props.onOpenRail}
    >
      {"\u{2630}"}
    </button>
  );
};

const ShellChrome: Component<Props> = (props) => {
  return (
    <header class="shell-chrome" data-testid="shell-chrome">
      {props.leading}
      <RailOpenerButton onOpenRail={props.onOpenRail} />
    </header>
  );
};

export default ShellChrome;
