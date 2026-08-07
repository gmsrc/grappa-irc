import { type Component, type JSX, Show } from "solid-js";
import { AdminRefreshButton } from "./AdminToolbar";
import { refreshInCardHead, refreshSlot } from "./refreshSlot";

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
  /**
   * Render the active tab's registered refresh button in this card's
   * header, on the viewports where that is where it belongs
   * (`refreshInCardHead`). Set on the ONE card per tab that holds the
   * data the button re-fetches; on the other viewport the pane header
   * renders it instead, and it is never in both places at once.
   */
  hostsRefresh?: boolean;
  /**
   * Optional click handler on the card's TITLE. Deliberately does not
   * turn the title into a `<button>`: it stays a heading in the
   * accessibility tree, because announcing an action that only decorates
   * would be a lie to anyone using a screen reader.
   */
  onTitleClick?: () => void;
  children: JSX.Element;
  class?: string;
  "data-testid"?: string;
};

const AdminCard: Component<Props> = (props) => (
  <section class={`adm-card ${props.class ?? ""}`.trim()} data-testid={props["data-testid"]}>
    <header class="adm-card-head">
      <div>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: decorative only —
            no keyboard action worth exposing. See `onTitleClick`. */}
        <h3 class="adm-card-title" onClick={props.onTitleClick}>
          {props.title}
        </h3>
        {props.subtitle !== undefined ? <p class="adm-card-sub">{props.subtitle}</p> : null}
      </div>
      <div class="adm-card-actions">
        {props.actions}
        <Show when={props.hostsRefresh === true && refreshInCardHead() && refreshSlot()}>
          {(reg) => (
            <AdminRefreshButton
              compact={false}
              onClick={reg().onRefresh}
              busy={reg().busy()}
              label={reg().label}
              testId={reg().testId}
            />
          )}
        </Show>
      </div>
    </header>
    <div class="adm-card-body">{props.children}</div>
  </section>
);

export default AdminCard;
