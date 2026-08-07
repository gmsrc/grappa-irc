import type { Component, JSX } from "solid-js";

// Admin redesign Layer 2 — label + control + hint/error, used by the
// 7 bespoke add-forms and the 2 inline edit forms that today render
// with NO class at all (`AdminUsersTab.tsx:329`,
// `AdminCredentialsTab.tsx:475`). The control itself (input/select) is
// passed as `children` — this primitive only owns the label + layout
// + message, never the input's own type-specific props.

export type Props = {
  label: string;
  for: string;
  hint?: string;
  error?: string;
  children: JSX.Element;
  class?: string;
};

const AdminField: Component<Props> = (props) => (
  <div class={`adm-field ${props.class ?? ""}`.trim()}>
    <label class="adm-field-label" for={props.for}>
      {props.label}
    </label>
    {props.children}
    {props.hint !== undefined ? <span class="adm-field-hint">{props.hint}</span> : null}
    {props.error !== undefined ? (
      <span class="adm-field-error" role="alert">
        {props.error}
      </span>
    ) : null}
  </div>
);

export default AdminField;
