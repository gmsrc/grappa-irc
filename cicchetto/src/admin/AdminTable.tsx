import type { Component, JSX } from "solid-js";

// Admin redesign Layer 2 — one table shape for all 10 tabs, replacing
// 10 distinct `.admin-X-table` class names (3 of which duplicated the
// same `th/td { text-align:left; padding:.4rem .5rem; border-bottom }`
// byte-for-byte). `.adm-table-wrap` OWNS `overflow-x: auto` — the
// table itself never scrolls on its own.
//
// #1157 REVERSED the rest of what this comment used to say. It read
// "mobile tables stay wide + horizontally scrollable, never collapse to
// stacked cards", citing plan constraint #4. vjt reversed that after
// dogfooding 0.15.0 on a phone: below 900px every table here becomes
// cards — one record per block, label beside value — and the horizontal
// pan is gone rather than relocated. That is why each `<td>` a caller
// writes MUST carry `data-label`: `thead` is hidden at that width and the
// label is re-emitted from the attribute. A cell that heads its record
// (the name, the slug, the address) takes `adm-cell-title` instead, which
// suppresses the label and lets it span the card. See the
// `@media (max-width: 899px)` block in `themes/default.css`.

export type Props = {
  children: JSX.Element;
  class?: string;
  "data-testid"?: string;
  wrapTestId?: string;
};

const AdminTable: Component<Props> = (props) => (
  <div class="adm-table-wrap" data-testid={props.wrapTestId}>
    <table class={`adm-table ${props.class ?? ""}`.trim()} data-testid={props["data-testid"]}>
      {props.children}
    </table>
  </div>
);

export default AdminTable;
