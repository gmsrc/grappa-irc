import { type Component, For, type JSX } from "solid-js";

// Admin redesign (2026-08-07 review) — the label/value list a row's
// detail panel shows on a phone.
//
// It carries the columns the table drops below 900px. The admin tables
// run to nine columns, which is fine on a desktop and unreadable on a
// 402px screen: panning sideways moves the row's own name off-screen, so
// you end up reading a number with no idea whose it is.
//
// Which columns survive on mobile is a per-table judgement about what an
// operator does on a PHONE — verify and act, not analyse. That means
// who, what state, and what can be done about it. Everything else is
// context you want once you have stopped on a row, which is exactly what
// this list is.
//
// Nothing is lost, only deferred: every dropped column reappears here,
// and on desktop the table shows them all and this never renders.

export type Fact = {
  label: string;
  value: JSX.Element;
};

export type Props = {
  facts: Fact[];
};

const AdminFacts: Component<Props> = (props) => (
  <dl class="adm-facts">
    <For each={props.facts}>
      {(fact) => (
        <>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </>
      )}
    </For>
  </dl>
);

export default AdminFacts;
