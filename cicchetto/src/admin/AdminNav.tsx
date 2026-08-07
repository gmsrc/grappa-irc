import { type Component, For } from "solid-js";

// Admin redesign Layer 2/3 — shared navigation rail.
//
// Absorbs the 220 hand-unrolled lines of `AdminPane.tsx` (10 `<button
// role="tab">` + 10 `<Show>`-gated tabpanels) into one array-driven
// component. `tabs` carries `group` so the rail can print non-
// interactive group headings (Live / Configurazione / Diagnostica,
// mockup-B) WITHOUT a second navigation level: every button renders
// exactly once, flat, and stays clickable in a single click — 31 e2e
// specs click `admin-tab-<key>` directly (plan "Vincoli non
// negoziabili" #1). Desktop-rail vs mobile-chip-strip is CSS layout
// only (`.adm-nav` / `.adm-nav-group` media query in default.css);
// the DOM is never duplicated.
//
// `data-testid` on each button stays `admin-tab-<key>` — the pre-
// existing contract AdminPane.tsx used before this extraction.

export type AdminNavTab = {
  key: string;
  label: string;
  group: string;
};

export type AdminNavGroup = {
  key: string;
  label: string;
};

export type Props = {
  groups: AdminNavGroup[];
  tabs: AdminNavTab[];
  current: string;
  onSelect: (key: string) => void;
  class?: string;
  "data-testid"?: string;
};

const AdminNav: Component<Props> = (props) => {
  return (
    <div
      class={`adm-nav ${props.class ?? ""}`.trim()}
      role="tablist"
      aria-label="admin tabs"
      data-testid={props["data-testid"]}
    >
      <For each={props.groups}>
        {(group) => (
          <div class="adm-nav-group" role="presentation" data-adm-group={group.key}>
            {/* Visible on the desktop rail, CSS-hidden on the mobile chip
                strip: there the three headings ate a whole line of a
                402px screen to say something the operator already knows
                from the tab they just tapped. On mobile the group reads
                from the accent stripe along the top of the tab's cards
                instead (`[data-adm-group]` on the panel, same key). Kept
                in the DOM either way so a screen reader still gets the
                grouping. */}
            <p class="adm-nav-group-label">{group.label}</p>
            <For each={props.tabs.filter((tab) => tab.group === group.key)}>
              {(tab) => (
                <button
                  type="button"
                  role="tab"
                  class="adm-nav-item"
                  aria-selected={props.current === tab.key}
                  aria-controls={`admin-tab-${tab.key}`}
                  id={`admin-tab-${tab.key}-handle`}
                  data-testid={`admin-tab-${tab.key}`}
                  onClick={() => props.onSelect(tab.key)}
                >
                  {tab.label}
                </button>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
};

export default AdminNav;
