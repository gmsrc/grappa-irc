import type { Component, JSX } from "solid-js";

// Admin redesign Layer 2 — standardises the "expanded detail row"
// shape used by the 4 admin tables that expand a row inline (today 4
// different mechanics: two `<Show>`-gated, one toggle, one always
// mounted — see plan). Keeps the `<tr><td colspan>` shape (a drawer
// would be a behaviour change, out of scope) but derives `colspan`
// from the caller's column COUNT instead of a hardcoded literal, so
// adding/removing a column to the parent table can't silently desync
// the expand row's span.

export type Props = {
  columns: number;
  children: JSX.Element;
  class?: string;
  "data-testid"?: string;
};

const AdminExpandRow: Component<Props> = (props) => (
  <tr class={`adm-expand-row ${props.class ?? ""}`.trim()} data-testid={props["data-testid"]}>
    <td colspan={String(props.columns)}>{props.children}</td>
  </tr>
);

export default AdminExpandRow;
