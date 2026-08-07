import type { Component, JSX } from "solid-js";

// Admin redesign Layer 2/3 — the "dashboard" section container
// (mockup-B `.mk-card`): a titled, bordered surface on
// `--adm-surface-0` sitting inside the tab's `--adm-surface-1`
// scroll body. A tab with several independent sections (Networks:
// network list + expanded server pool + featured channels; Sessions:
// capacity summary + live sessions) renders one `AdminCard` per
// section instead of one flat table.

export type Props = {
  title: string;
  subtitle?: string;
  actions?: JSX.Element;
  children: JSX.Element;
  class?: string;
  "data-testid"?: string;
};

const AdminCard: Component<Props> = (props) => (
  <section class={`adm-card ${props.class ?? ""}`.trim()} data-testid={props["data-testid"]}>
    <header class="adm-card-head">
      <div>
        <h3 class="adm-card-title">{props.title}</h3>
        {props.subtitle !== undefined ? <p class="adm-card-sub">{props.subtitle}</p> : null}
      </div>
      {props.actions !== undefined ? <div class="adm-card-actions">{props.actions}</div> : null}
    </header>
    <div class="adm-card-body">{props.children}</div>
  </section>
);

export default AdminCard;
