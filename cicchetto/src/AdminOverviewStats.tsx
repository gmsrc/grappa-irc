import { type Component, Show } from "solid-js";
import type { AdminOverviewWireT } from "./lib/wireTypes";

/**
 * #1073 — the admin bar's left group: the five live stats vjt asked for,
 * rendered into `PaneTopBar`'s content slot where the channel bar puts its
 * namebox and topic strip.
 *
 * Pure presentation. It is handed the numbers and owns only how they read;
 * the store that fetches them is a separate concern, so this whole surface
 * is testable without a socket.
 *
 * ## It has to stay ONE row
 *
 * vjt: *"si, non invadente"*; Hypnotize: *"deve essere piccola, che già la
 * tastiera occupa una madonna"*. Vertical space on a phone with the keyboard
 * up is the binding constraint, so five stats get five compact cells on one
 * line — glyph plus value — with the full wording in `title` rather than on
 * screen.
 *
 * ## Two of its rules are correctness, not taste
 *
 * Both come from what #1075 measured server-side, and both are easy to undo
 * by accident:
 *
 * 1. **The loadavg is the HOST's.** A jail shares the host kernel — `sysctl
 *    vm.loadavg` reads identically inside the jail and on the host (measured
 *    in production, 2026-08-09). An unlabelled number on a grappa console is
 *    read as "grappa is busy", which is a different and unsupported claim. So
 *    the word `host` is part of the cell, not a footnote.
 *
 * 2. **`null` is not zero.** The server deliberately reports `nil` rather
 *    than `0.0` when the sampler cannot be reached, because "cannot measure"
 *    and "the box is idle" are different facts and only one of them should
 *    render as a calm bar. Coercing here would throw that away — `Number(null)`
 *    is `0`, so a formatter applied without thinking produces a confident
 *    `0.00`. The unknown case renders an em dash, carries the reason in its
 *    `title`, and contains no digit at all.
 */
export type Props = {
  /**
   * The wire shape, GENERATED from `Grappa.AdminOverview.Wire` by `mix
   * grappa.gen_wire_types` — never a hand-written twin of it. This component
   * held a local copy of the same five fields while #1075 was still in
   * flight; `scripts/check.sh` runs the generator with `--check`, so the copy
   * would have gone on compiling happily while the server's shape moved under
   * it. Reading the generated type is what makes a server-side field rename
   * fail here instead of at an operator's screen.
   *
   * `null` until the first push lands — the bar renders nothing until then.
   */
  overview: AdminOverviewWireT | null;
};

const LOADAVG_UNKNOWN = "—";

// Deliberately the ONLY place a loadavg becomes a string, and it takes the
// null branch first. Written as a total function over `number | null` rather
// than as a `<Show>` with a cast so there is no arm where a formatter can be
// reached with a null in hand.
const loadavgText = (loadavg: number | null): string =>
  loadavg === null ? LOADAVG_UNKNOWN : loadavg.toFixed(2);

const loadavgTitle = (loadavg: number | null): string =>
  loadavg === null
    ? "host load average unavailable — the sampler did not answer"
    : "host load average, 1 min. This jail shares the host kernel, so it is " +
      "the HOST's load, not grappa's.";

const AdminOverviewStats: Component<Props> = (props) => {
  return (
    <Show when={props.overview}>
      {(overview) => (
        <div class="admin-overview-stats" data-testid="admin-overview-stats">
          <span
            class="admin-overview-stat"
            data-testid="admin-overview-sessions"
            title="live IRC sessions (one per registered Session.Server pid)"
          >
            <span class="admin-overview-stat-icon" aria-hidden="true">
              {"⚡"}
            </span>
            {overview().sessions}
          </span>
          {/* live-over-total, never one number: the server sends two because
              they are two sources of truth and are allowed to disagree. "2 of 5
              visitors are connected" is a diagnostic; "5 visitors" is not. */}
          <span
            class="admin-overview-stat"
            data-testid="admin-overview-visitors"
            title="visitors: live sessions over total rows in the database"
          >
            <span class="admin-overview-stat-icon" aria-hidden="true">
              {"\u{1F464}"}
            </span>
            {overview().visitors.live}/{overview().visitors.total}
          </span>
          {/* The only cell whose width is not bounded by its own shape — a
              hostname can be anything — so it is the one that yields when the
              row runs out of bar. See `.admin-overview-stat-host`. */}
          <span
            class="admin-overview-stat admin-overview-stat-host"
            data-testid="admin-overview-hostname"
            title="the host this grappa runs on"
          >
            {overview().hostname}
          </span>
          <span
            class="admin-overview-stat"
            data-testid="admin-overview-loadavg"
            title={loadavgTitle(overview().loadavg)}
          >
            host {loadavgText(overview().loadavg)}
          </span>
          <span
            class="admin-overview-stat"
            data-testid="admin-overview-version"
            title="running grappa version"
          >
            v{overview().version}
          </span>
        </div>
      )}
    </Show>
  );
};

export default AdminOverviewStats;
