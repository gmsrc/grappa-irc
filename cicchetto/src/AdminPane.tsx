import { type Component, createSignal, onCleanup, onMount, Show } from "solid-js";
import AdminDebugTab from "./AdminDebugTab";
import AdminEventsTab from "./AdminEventsTab";
import AdminNetworksTab from "./AdminNetworksTab";
import AdminOverviewStats from "./AdminOverviewStats";
import AdminSessionLogTab from "./AdminSessionLogTab";
import AdminSessionsTab from "./AdminSessionsTab";
import AdminSettingsTab from "./AdminSettingsTab";
import AdminUsersTab from "./AdminUsersTab";
import AdminVhostsTab from "./AdminVhostsTab";
import AdminNav, { type AdminNavGroup, type AdminNavTab } from "./admin/AdminNav";
import { startAdminEventsSubscription, uninstallAdminEvents } from "./lib/adminEvents";
import { adminOverview } from "./lib/adminOverview";
import PaneTopBar, { PaneTopBarRailOpener } from "./PaneTopBar";

// M-7 — Admin console pane. Replaces the channel content in
// Shell.tsx when an admin operator clicks "admin console" in
// SettingsDrawer. Outer pane = top bar + tab nav + active tab body.
//
// #1073 — the pane has no close × and no `onClose`. vjt: *"la x
// sparisce"*. Mount is selection-driven (below), so picking any
// window from the rail the ☰ opens already leaves the console; the
// rail carries `home` and `rooms`, and "close admin" would have been
// a second verb for the work `home` already does. The demote-redirect
// effect in Shell.tsx is now the ONLY programmatic way out, and it
// lands on the same window the deleted button did.
//
// M-8 added Visitors; M-9b added Sessions; M-10 added Networks;
// M-11 adds Events (real-time stream of admin-relevant events
// fan-out on `grappa:admin:events`).
//
// Mount lifecycle: a `<Show when={selectedChannel().kind === "admin" && isAdmin()}>`
// in Shell.tsx drives mount/unmount (UX-4 bucket N: selection-driven;
// pre-bucket-N a parallel `adminOpen` signal duplicated the gate).
// Shell auto-redirects selection to home the instant `me.is_admin`
// flips to false — see the demote-mid-session createEffect at
// Shell.tsx. The tab components issue admin REST fetches which the
// `:admin_authn` plug 403s any request from a now-non-admin user, so
// the demote race is server-side-safe.
//
// M-11 subscription lifecycle lives HERE (not in `AdminEventsTab`)
// so the ring buffer accumulates while the operator browses
// Visitors / Sessions / Networks tabs. AdminPane mount = admin
// console opened; AdminPane unmount = closed → cleanup detaches.
//
// Per-class parity matrix (`feedback_e2e_user_class_parity_matrix`):
// admin-gated, EXEMPT. The Playwright spec at m7-admin-gate covers
// reachability; per-tab specs cover only the admin case since
// non-admin can't reach the AdminPane at all.
//
// Admin redesign (2026-08-07 plan, direzione B) — Layer 3. The 10
// hand-unrolled `<button role="tab">` + `<Show>` pairs collapsed into
// the `TABS` array below, rendered by the shared `AdminNav` (Layer 2)
// as a rail grouped into Live / Configuration / Diagnostics. The
// GROUPING IS VISUAL ONLY: every tab still renders as one flat
// `role="tab"` button with its original `admin-tab-<key>` testid, so
// the 31 e2e specs that click it directly keep working in one click
// (plan "Vincoli non negoziabili" #1). `.admin-tab-panel` (the active
// tab's wrapper) is unchanged — same id, same class, same touch-
// action/overflow-x/max-height CSS contract 4 specs depend on (#2/#3/#5).

export type Props = {
  /**
   * Admin redesign (2026-08-07) — opens the right rail (`.shell-members`), the
   * mobile door to settings. Rendered inline in this pane's own band so the
   * admin window shows ONE band of chrome instead of the near-empty
   * `.shell-chrome` row stacked above the pane's own title; Shell suppresses
   * that row for the admin kind. CSS-hidden at ≥900px, where the desktop Shell
   * branch renders no `ShellChrome` at all and the rail is permanent.
   *
   * #1073 — the glyph is now `PaneTopBar`'s trailing ☰ rather than an inline
   * `RailOpenerButton`, which is what moves it from the band's left edge to its
   * right one. Same door, same accessible name ("open actions"), one fewer
   * mount of the same button.
   */
  onOpenRail: () => void;
};

type TabKey =
  | "sessions"
  | "networks"
  | "vhosts"
  | "users"
  | "events"
  | "session_log"
  | "settings"
  | "debug";

// Group order matches the approved mockup (shots/mockup-B.html,
// direzione B rail markup); labels are English — the product's UI
// language, unlike the mockup which was written for the (Italian-
// speaking) reviewer.
const GROUPS: AdminNavGroup[] = [
  { key: "live", label: "Live" },
  { key: "config", label: "Configuration" },
  { key: "diag", label: "Diagnostics" },
];

const TABS: (AdminNavTab & { key: TabKey })[] = [
  { key: "sessions", label: "Sessions", group: "live" },
  { key: "events", label: "Events", group: "live" },
  { key: "session_log", label: "Session Log", group: "live" },
  { key: "networks", label: "Networks", group: "config" },
  { key: "vhosts", label: "Vhosts", group: "config" },
  { key: "users", label: "Users", group: "config" },
  { key: "settings", label: "Settings", group: "config" },
  { key: "debug", label: "Debug", group: "diag" },
];

const AdminPane: Component<Props> = (props) => {
  // Sessions, not Visitors. The old default predates this redesign and
  // predates the grouped nav: with the tabs in a deliberate order, the
  // console opening on the SECOND entry of the first group is arbitrary.
  // Sessions is also the better landing — it is the "what is happening
  // right now" view, which is why an operator opens the console at all.
  const [currentTab, setCurrentTab] = createSignal<TabKey>("sessions");

  const isActive = (k: TabKey): boolean => currentTab() === k;

  // The active tab's group, stamped on every tabpanel as
  // `data-adm-group`. On mobile the nav's group headings are CSS-hidden
  // (they cost a whole line of a 402px screen), so this is what tells
  // the operator which section they are in: default.css draws an accent
  // stripe along the top of the panel's cards, one colour per group.
  const currentGroup = (): string => TABS.find((t) => t.key === currentTab())?.group ?? "";

  // #215 — `startAdminEventsSubscription` joins `grappa:admin:events` and
  // installs BOTH the admin-events handler AND the session-log handler on
  // the one channel (adminEvents.ts owns the join/leave; it calls
  // `installSessionLog`). `uninstallAdminEvents` leaves the channel and
  // resets both stores. So the Session Log tab's live feed accumulates
  // while the operator browses any admin tab, torn down on pane close.
  onMount(() => {
    startAdminEventsSubscription();
  });

  onCleanup(() => {
    uninstallAdminEvents();
  });

  return (
    <section class="admin-pane" data-testid="admin-pane">
      {/* #1073 — the SAME band the channel windows use, not a clone of it on
          the `--adm-*` layer. Everything admin-shaped goes in the content slot;
          the ☰ comes with the band, and comes LAST, which is what finally puts
          it on the same side as the channel bar's. */}
      <PaneTopBar
        /* #1766 — no left door here. The admin window suppresses `.shell-chrome`
           and its own ✕ already exits to a window that carries one, so a second
           ☰ in this band would be a door onto a floor you reach in one tap
           anyway. Stated at the call site because the slot is required. */
        leading={null}
        trailing={
          /* #1697 — passed in rather than baked into the band; see the note on
             the channel bar's identical call. */
          <PaneTopBarRailOpener onOpenRail={props.onOpenRail} railLabel="open actions" />
        }
      >
        <h1>admin console</h1>
        {/* #1073 — the live key stats, fed by the `"overview"` push the admin
            channel already carries (`lib/adminOverview.ts`). Read here rather
            than inside the component so the component stays presentation-only
            and testable without a socket. Nothing renders until the first push
            lands: the bar is the title alone for that instant, which beats
            five placeholder zeroes. */}
        <AdminOverviewStats overview={adminOverview()} />
      </PaneTopBar>
      <AdminNav
        groups={GROUPS}
        tabs={TABS}
        current={currentTab()}
        onSelect={(key) => setCurrentTab(key as TabKey)}
      />
      <Show when={isActive("sessions")}>
        <div
          role="tabpanel"
          id="admin-tab-sessions"
          aria-labelledby="admin-tab-sessions-handle"
          class="admin-tab-panel"
          data-adm-group={currentGroup()}
        >
          <AdminSessionsTab />
        </div>
      </Show>
      <Show when={isActive("networks")}>
        <div
          role="tabpanel"
          id="admin-tab-networks"
          aria-labelledby="admin-tab-networks-handle"
          class="admin-tab-panel"
          data-adm-group={currentGroup()}
        >
          <AdminNetworksTab />
        </div>
      </Show>
      <Show when={isActive("vhosts")}>
        <div
          role="tabpanel"
          id="admin-tab-vhosts"
          aria-labelledby="admin-tab-vhosts-handle"
          class="admin-tab-panel"
          data-adm-group={currentGroup()}
        >
          <AdminVhostsTab />
        </div>
      </Show>
      <Show when={isActive("users")}>
        <div
          role="tabpanel"
          id="admin-tab-users"
          aria-labelledby="admin-tab-users-handle"
          class="admin-tab-panel"
          data-adm-group={currentGroup()}
        >
          <AdminUsersTab />
        </div>
      </Show>
      <Show when={isActive("events")}>
        <div
          role="tabpanel"
          id="admin-tab-events"
          aria-labelledby="admin-tab-events-handle"
          class="admin-tab-panel"
          data-adm-group={currentGroup()}
        >
          <AdminEventsTab />
        </div>
      </Show>
      <Show when={isActive("session_log")}>
        <div
          role="tabpanel"
          id="admin-tab-session_log"
          aria-labelledby="admin-tab-session_log-handle"
          class="admin-tab-panel"
          data-adm-group={currentGroup()}
        >
          <AdminSessionLogTab />
        </div>
      </Show>
      <Show when={isActive("settings")}>
        <div
          role="tabpanel"
          id="admin-tab-settings"
          aria-labelledby="admin-tab-settings-handle"
          class="admin-tab-panel"
          data-adm-group={currentGroup()}
        >
          <AdminSettingsTab />
        </div>
      </Show>
      <Show when={isActive("debug")}>
        <div
          role="tabpanel"
          id="admin-tab-debug"
          aria-labelledby="admin-tab-debug-handle"
          class="admin-tab-panel"
          data-adm-group={currentGroup()}
        >
          <AdminDebugTab />
        </div>
      </Show>
    </section>
  );
};

export default AdminPane;
