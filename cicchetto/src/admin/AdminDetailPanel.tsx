import { type Component, type JSX, onMount } from "solid-js";

// Admin redesign (2026-08-07 review) — the detail surface for the row a
// table has open.
//
// It replaces `AdminExpandRow` for the three single-at-a-time
// disclosures (Networks' servers + featured, Credentials' edit,
// Users' password rotation), and the reason is width, not taste.
//
// An expand row lives in a `<td colspan>` of a table that is
// deliberately WIDER than the viewport — the UX-6-G contract keeps admin
// tables wide and horizontally pannable rather than collapsing them to
// cards. Anything inside that cell inherits the TABLE's width, so a form
// in there is unreachable on a phone without swiping sideways, and no
// amount of grid columns inside it helps: two columns of a 900px table
// are still 900px.
//
// A previous attempt pinned the cell with `position: sticky; left: 0`
// and capped its children at `92vw`. That put a horizontally-scrolling
// nested table inside a sticky viewport-capped cell of another
// horizontally-scrolling table; the two scroll contexts fought, and
// panning the outer one clipped the nested table. Reverted.
//
// Rendering the panel OUTSIDE the table removes the cause instead of
// fighting it: this is an ordinary block in the tab's scroll body, so it
// is viewport-wide and its contents wrap. The panel names the row it
// belongs to, since it is no longer physically attached to it.
//
// NOT used for the Vhosts grants disclosure, which is a different shape:
// that one is always mounted for EVERY row, so hoisting it would put N
// panels under the table instead of one. It keeps `AdminExpandRow`.

export type Props = {
  /** Names the row this panel is editing, e.g. `Editing azzurra`. */
  title: string;
  subtitle?: string;
  onClose: () => void;
  closeLabel: string;
  children: JSX.Element;
  "data-testid"?: string;
};

const AdminDetailPanel: Component<Props> = (props) => {
  let el: HTMLElement | undefined;

  // Scroll the panel into view when it opens.
  //
  // This is not a nicety, it is the other half of moving out of the
  // table. Inside a row, the editor appeared exactly where the operator
  // had just tapped. Out here it is a sibling of the table, and tapping
  // Edit on a row while scrolled anywhere down the list opened a panel
  // the operator could not see — which reads, correctly, as the button
  // doing nothing. The panel renders BEFORE the table for the same
  // reason (so closing it leaves you at the top of the list rather than
  // stranded past it); this covers the case where the table is what you
  // were looking at.
  //
  // `block: "nearest"` so an already-visible panel does not jump.
  //
  // Feature-detected because jsdom does not implement `scrollIntoView`
  // at all — this is a real environment gap, not defensive padding, and
  // without the check every vitest case that opens a panel throws.
  onMount(() => {
    if (typeof el?.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  });

  return (
    <section
      class="adm-detail"
      data-testid={props["data-testid"]}
      ref={(node) => {
        el = node;
      }}
    >
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
  );
};

export default AdminDetailPanel;
