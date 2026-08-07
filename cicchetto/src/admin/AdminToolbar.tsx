import type { Component, JSX } from "solid-js";

// Admin redesign Layer 2 — shared page-level toolbar (title + context
// line + right-aligned actions), absorbing the 8 bespoke
// `header.admin-X-header` blocks. `AdminRefreshButton` below absorbs
// the 7 byte-identical copies of the `↻ refresh` button (the 8th,
// Settings, has no refresh action and is unaffected).

export type Props = {
  title: string;
  subtitle?: string;
  actions?: JSX.Element;
  class?: string;
  "data-testid"?: string;
};

const AdminToolbar: Component<Props> = (props) => {
  return (
    <header class={`adm-toolbar ${props.class ?? ""}`.trim()} data-testid={props["data-testid"]}>
      <div class="adm-toolbar-heading">
        <h2 class="adm-toolbar-title">{props.title}</h2>
        {props.subtitle !== undefined ? <p class="adm-toolbar-sub">{props.subtitle}</p> : null}
      </div>
      {props.actions !== undefined ? <div class="adm-toolbar-actions">{props.actions}</div> : null}
    </header>
  );
};

export type RefreshButtonProps = {
  onClick: () => void;
  busy: boolean;
  label: string;
  testId: string;
  /**
   * Glyph only, no "refresh" word — for the pane header, where the button
   * sits beside the close × in a row with no room for a label. Required
   * rather than optional: there are two call sites and which one you are
   * is never ambiguous, so a default would only hide the choice. The
   * `aria-label` carries the name either way.
   */
  compact: boolean;
};

export const AdminRefreshButton: Component<RefreshButtonProps> = (props) => (
  <button
    type="button"
    class={`adm-btn adm-refresh-btn ${props.compact ? "adm-refresh-btn--compact" : ""}`.trim()}
    aria-label={props.label}
    aria-busy={props.busy}
    onClick={props.onClick}
    data-testid={props.testId}
  >
    {props.compact ? "↻" : "↻ refresh"}
  </button>
);

export default AdminToolbar;
