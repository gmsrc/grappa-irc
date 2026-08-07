import type { Component, JSX } from "solid-js";

// Admin redesign Layer 2 — one table shape for all 10 tabs, replacing
// 10 distinct `.admin-X-table` class names (3 of which duplicated the
// same `th/td { text-align:left; padding:.4rem .5rem; border-bottom }`
// byte-for-byte). `.adm-table-wrap` OWNS `overflow-x: auto` — the
// table itself never scrolls on its own, matching plan constraint #4
// (mobile tables stay wide + horizontally scrollable, never collapse
// to stacked cards).

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
