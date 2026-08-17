import type { Component, JSX } from "solid-js";

// Admin redesign Layer 2 — shared page-level toolbar (title + context
// line + right-aligned actions), absorbing the 8 bespoke
// `header.admin-X-header` blocks. `AdminRefreshButton` below absorbs
// the byte-identical copies of the `↻ refresh` button.
//
// #1411 — this doc used to except Settings as the one tab with "no refresh
// action". It grew one after that sentence was written and hand-rolled the
// button, losing the accessible name and the mobile ☰ placement; the sentence
// is what let it land. There is no exception now: EVERY tab that re-fetches
// goes through this component, reached either from the tab's slot
// registration (`admin/refreshSlot.ts`) or, where the toolbar survives for
// reasons of its own, directly — see `AdminNetworksTab`.

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
};

// #1073 — the `compact` variant (glyph only, no word) existed for ONE call
// site: the console's own band, where the button sat beside the close × with
// no room for a label. Both of those left the band, and the two remaining
// call sites are card heads with room for the word, so the branch is gone
// rather than kept as a prop nobody passes.
export const AdminRefreshButton: Component<RefreshButtonProps> = (props) => (
  <button
    type="button"
    class="adm-btn adm-refresh-btn"
    aria-label={props.label}
    aria-busy={props.busy}
    onClick={props.onClick}
    data-testid={props.testId}
  >
    {"\u{21BB} refresh"}
  </button>
);

export default AdminToolbar;
