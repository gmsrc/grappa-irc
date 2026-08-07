import type { Component, JSX } from "solid-js";

// Admin redesign Layer 2 — label + control + hint/error. The control
// itself (input/select) is passed as `children`; this primitive owns
// only the label + layout + message, never the input's own
// type-specific props.
//
// Scope narrowed after the 2026-08-07 mobile review: this is for
// STACKED forms, where each field owns a full row and a label above the
// control reads naturally — today that means AdminSettingsTab. The
// dense inline forms (every add/edit row in Networks, Credentials,
// Users, Vhosts) went back to `placeholder` + `aria-label`: a stacked
// label made each field taller than the submit button beside it, so
// every one of those rows rendered visibly out of line, and on a 402px
// screen the labels doubled the height of a form that has to stay
// glanceable. A placeholder as the ONLY visible label is a real
// tradeoff — it vanishes the moment you type — but in a row of short
// fields under a card title that names the operation, it is the one the
// operator asked for.

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
