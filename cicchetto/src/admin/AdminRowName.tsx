import { type Component, type JSX, Show } from "solid-js";
import { isMobile } from "../lib/theme";

// Admin redesign (2026-08-07 review) — a table row's identity cell.
//
// On a phone it is the door to the row's detail panel, because the table
// has dropped its secondary columns at that width and this is how they
// come back. On desktop every column is already on screen, so there is
// nothing to open and the name is plain text — a control that reveals
// what you can already see is a control that teaches the operator to
// distrust controls.
//
// The caret is the same `▸ / ▾` the Networks slug expander has used
// since M-10, so the affordance is one the operator has already met in
// this pane rather than a second convention.

export type Props = {
  /** The row's name, e.g. `vjt @ azzurra`. */
  children: JSX.Element;
  open: boolean;
  onToggle: () => void;
  /** Accessible name for the disclosure, e.g. `details for vjt`. */
  label: string;
  testId?: string;
};

const AdminRowName: Component<Props> = (props) => (
  <Show when={isMobile()} fallback={<span class="adm-row-name">{props.children}</span>}>
    <button
      type="button"
      class="adm-row-expand"
      aria-expanded={props.open}
      aria-label={props.label}
      onClick={props.onToggle}
      data-testid={props.testId}
    >
      <span aria-hidden="true">{props.open ? "▾" : "▸"}</span>
      {props.children}
    </button>
  </Show>
);

export default AdminRowName;
