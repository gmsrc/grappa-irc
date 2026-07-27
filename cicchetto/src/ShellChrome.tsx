import { type Component, Show } from "solid-js";
import { archiveSlugForSelection } from "./lib/archiveContext";
import { mentionsBundleBySlug } from "./lib/mentionsWindow";
import { setSelectedChannel } from "./lib/selection";
import { isMobile } from "./lib/theme";

// UX-4 bucket L (2026-05-19) — sticky chrome bar at the top of
// `.shell-main`. Always rendered, regardless of selected window kind
// (channel / query / server / home / mentions / admin / empty). This is
// a cluster-wide rule: the settings cog MUST be reachable from every
// window kind, INCLUDING the server window.
//
// Slots (left → right):
//   * Spacer — pushes the right group to the far right.
//   * Mentions button (@) — MOBILE-ONLY re-open door for a network's
//     "you were /away" bundle (desktop uses the Sidebar mentions row).
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
// ☰ rail opener), so the inline button became redundant. `archiveContext`
// still backs the @ mentions-slot network derivation below.
//
// #71 INC-2 — ShellChrome is now MOBILE-ONLY: the desktop copy was removed
// (its row freed the top for the topic; the cog moved to the permanent
// desktop rail). It renders only in Shell.tsx's mobile branch, on
// non-channel windows (channel windows get the TopicBar instead). The
// `isMobile()` gate on the @ button is belt-and-suspenders.
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

export type Props = {
  /**
   * #71 INC-2 — opens the right rail (the `.shell-members` drawer that hosts
   * the ActionCluster cog + monkey). Required — the rail opener is always
   * rendered. Renamed from `onOpenSettings`: the cog moved into the rail, so
   * this bar's button now opens the rail rather than the settings drawer.
   */
  onOpenRail: () => void;
};

const ShellChrome: Component<Props> = (props) => {
  // #188 item 6 — which network's mentions bundle should the open button
  // consult? Derive the network from the current selection like the
  // archive button (`archiveSlugForSelection`), and render the button
  // ONLY when that network has a bundle — there's nothing to open
  // otherwise. #71 INC-2 — now MOBILE-ONLY (see the `isMobile()` gate on
  // the button below): on desktop the per-network Sidebar mentions row
  // (Sidebar.tsx) is the re-open affordance, so the @ here would just
  // duplicate it. Mobile has no sidebar, so the @ stays as the only
  // mentions re-open door (auto-nav on bundle arrival covers the first
  // open). `archiveSlugForSelection` returns null while the mentions panel
  // itself is open, which correctly hides the (redundant) re-open button.
  const mentionsOpenSlug = (): string | null => {
    const slug = archiveSlugForSelection();
    if (slug === null) return null;
    return mentionsBundleBySlug()[slug] ? slug : null;
  };

  return (
    <header class="shell-chrome" data-testid="shell-chrome">
      <span class="shell-chrome-spacer" />
      <Show when={isMobile() && mentionsOpenSlug()}>
        {(slug) => (
          <button
            type="button"
            class="shell-chrome-btn shell-chrome-mentions"
            aria-label="open mentions"
            data-testid="shell-chrome-mentions"
            onClick={() =>
              setSelectedChannel({ networkSlug: slug(), channelName: "", kind: "mentions" })
            }
          >
            @
          </button>
        )}
      </Show>
      {/* #71 INC-2 — rail opener (☰). Opens the same `.shell-members` drawer
          the channel-window TopicBar hamburger opens (paletto: ONE drawer, one
          ☰ glyph across both openers). The settings cog it replaced now lives
          in that rail's ActionCluster. */}
      <button
        type="button"
        class="shell-chrome-btn shell-chrome-rail-opener"
        aria-label="open actions"
        data-testid="shell-chrome-rail-opener"
        onClick={props.onOpenRail}
      >
        {"\u{2630}"}
      </button>
    </header>
  );
};

export default ShellChrome;
