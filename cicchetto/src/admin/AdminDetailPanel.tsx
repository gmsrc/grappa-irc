import type { Component, JSX } from "solid-js";
import AdminExpandRow from "./AdminExpandRow";

// Admin redesign (2026-08-07 review) — the detail surface for the row a
// table has open, for the four single-at-a-time disclosures (Networks'
// servers + featured, Credentials' edit, Users' password rotation and
// row details).
//
// It renders IN the table, in the row's own position: an
// `AdminExpandRow` immediately beneath the row it belongs to.
//
// This panel spent one iteration OUTSIDE the table, rendered before it
// and pulled into view with `scrollIntoView` on mount, because an
// expand row lives in a `<td colspan>` and inherits the TABLE's width —
// and the tables were deliberately wider than a phone. Tapping a row
// far down the list then sent the viewport to the top of the tab, which
// is the complaint #1074 opens with. The width is gone now (every tab
// drops its secondary columns below the mobile breakpoint), so the cell
// is viewport-wide and there is nothing left to scroll to.
//
// `.adm-detail-body` is an inline-size query container, so the panel
// contributes no intrinsic width of its own: a wide form inside it can
// never widen the table it now sits in.
//
// The title still names the row. It is redundant beside the row on
// screen and it is not redundant to a screen reader, which meets the
// panel as a section of its own.
//
// NOT used for the Vhosts grants disclosure, which is a different
// shape: that one is always mounted for EVERY row. It uses
// `AdminExpandRow` directly.

export type Props = {
  /** Names the row this panel is editing, e.g. `Editing azzurra`. */
  title: string;
  subtitle?: string;
  onClose: () => void;
  closeLabel: string;
  /** Column count of the host table, for the expand row's `colspan`. */
  columns: number;
  children: JSX.Element;
  "data-testid"?: string;
};

const AdminDetailPanel: Component<Props> = (props) => (
  <AdminExpandRow columns={props.columns} class="adm-detail-row">
    <section class="adm-detail" data-testid={props["data-testid"]}>
      <header class="adm-detail-head">
        <div>
          <h3 class="adm-card-title">{props.title}</h3>
          {props.subtitle !== undefined ? <p class="adm-card-sub">{props.subtitle}</p> : null}
        </div>
        <button
          type="button"
          class="adm-btn adm-detail-close"
          aria-label={props.closeLabel}
          onClick={props.onClose}
        >
          ×
        </button>
      </header>
      <div class="adm-detail-body">{props.children}</div>
    </section>
  </AdminExpandRow>
);

export default AdminDetailPanel;
