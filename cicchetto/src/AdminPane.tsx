import { type Component, createSignal, onCleanup, onMount, Show } from "solid-js";
import AdminCredentialsTab from "./AdminCredentialsTab";
import AdminDebugTab from "./AdminDebugTab";
import AdminEventsTab from "./AdminEventsTab";
import AdminNetworksTab from "./AdminNetworksTab";
import AdminSessionLogTab from "./AdminSessionLogTab";
import AdminSessionsTab from "./AdminSessionsTab";
import AdminSettingsTab from "./AdminSettingsTab";
import AdminUsersTab from "./AdminUsersTab";
import AdminVhostsTab from "./AdminVhostsTab";
import AdminVisitorsTab from "./AdminVisitorsTab";
import AdminNav, { type AdminNavGroup, type AdminNavTab } from "./admin/AdminNav";
import { startAdminEventsSubscription, uninstallAdminEvents } from "./lib/adminEvents";
import { RailOpenerButton } from "./ShellChrome";

// M-7 — Admin console pane. Replaces the channel content in
// Shell.tsx when an admin operator clicks "admin console" in
// SettingsDrawer. Outer pane = header + close + tab nav + active
// tab body.
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
  onClose: () => void;
  /**
   * Admin redesign (2026-08-07) — opens the right rail (`.shell-members`), the
   * mobile door to settings. Rendered as the header's leading ☰ so the admin
   * window shows ONE band of chrome instead of the near-empty `.shell-chrome`
   * row stacked above the pane's own title; Shell suppresses that row for the
   * admin kind. CSS-hidden at ≥900px, where the desktop Shell branch renders no
   * `ShellChrome` at all and the rail is permanent.
   */
  onOpenRail: () => void;
};

type TabKey =
  | "visitors"
  | "sessions"
  | "networks"
  | "vhosts"
  | "users"
  | "credentials"
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
  { key: "visitors", label: "Visitors", group: "live" },
  { key: "events", label: "Events", group: "live" },
  { key: "session_log", label: "Session Log", group: "live" },
  { key: "networks", label: "Networks", group: "config" },
  { key: "vhosts", label: "Vhosts", group: "config" },
  { key: "credentials", label: "Credentials", group: "config" },
  { key: "users", label: "Users", group: "config" },
  { key: "settings", label: "Settings", group: "config" },
  { key: "debug", label: "Debug", group: "diag" },
];

const AdminPane: Component<Props> = (props) => {
  const [currentTab, setCurrentTab] = createSignal<TabKey>("visitors");

  const isActive = (k: TabKey): boolean => currentTab() === k;

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
      <header class="admin-pane-header">
        <RailOpenerButton onOpenRail={props.onOpenRail} />
        <h1>admin console</h1>
        <button
          type="button"
          class="admin-pane-close"
          aria-label="close admin console"
          onClick={props.onClose}
          data-testid="admin-pane-close"
        >
          ×
        </button>
      </header>
      <AdminNav
        groups={GROUPS}
        tabs={TABS}
        current={currentTab()}
        onSelect={(key) => setCurrentTab(key as TabKey)}
      />
      <Show when={isActive("visitors")}>
        <div
          role="tabpanel"
          id="admin-tab-visitors"
          aria-labelledby="admin-tab-visitors-handle"
          class="admin-tab-panel"
        >
          <AdminVisitorsTab />
        </div>
      </Show>
      <Show when={isActive("sessions")}>
        <div
          role="tabpanel"
          id="admin-tab-sessions"
          aria-labelledby="admin-tab-sessions-handle"
          class="admin-tab-panel"
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
        >
          <AdminUsersTab />
        </div>
      </Show>
      <Show when={isActive("credentials")}>
        <div
          role="tabpanel"
          id="admin-tab-credentials"
          aria-labelledby="admin-tab-credentials-handle"
          class="admin-tab-panel"
        >
          <AdminCredentialsTab />
        </div>
      </Show>
      <Show when={isActive("events")}>
        <div
          role="tabpanel"
          id="admin-tab-events"
          aria-labelledby="admin-tab-events-handle"
          class="admin-tab-panel"
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
        >
          <AdminDebugTab />
        </div>
      </Show>
    </section>
  );
};

export default AdminPane;
