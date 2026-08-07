import { type Component, createSignal, For, onMount, Show } from "solid-js";
import AdminBadge from "./admin/AdminBadge";
import AdminCard from "./admin/AdminCard";
import AdminExpandRow from "./admin/AdminExpandRow";
import { AdminEmpty, AdminError, AdminLoading } from "./admin/AdminStatus";
import AdminTable from "./admin/AdminTable";
import AdminToolbar, { AdminRefreshButton } from "./admin/AdminToolbar";
import InlineConfirmButton from "./InlineConfirmButton";
import {
  type AdminUser,
  ApiError,
  adminCreateUser,
  adminDeleteUser,
  adminListUsers,
  adminUpdateUserAdmin,
  adminUpdateUserPassword,
} from "./lib/api";
import { token } from "./lib/auth";
import { operatorApiError } from "./lib/friendlyApiError";

// Admin-panel bucket 5 — Users admin tab.
//
// Surfaces:
//   * GET /admin/users — list with `live_session_count` per row
//     (count of `Session.Server`s registered as
//     `{:user, user_id} × *`).
//   * POST /admin/users — create form at the tab header.
//   * PATCH /admin/users/:id — is_admin toggle per row (single
//     inline button: "Promote" when off, "Demote" when on).
//   * PUT /admin/users/:id/password — per-row password rotation
//     (inline form revealed on demand).
//   * DELETE /admin/users/:id — per-row delete (InlineConfirmButton),
//     surfaces 422 `:last_admin` as a top banner.
//
// State model mirrors AdminVisitorsTab (createSignal lists; no
// createResource — explicit splice/refetch for predictable error
// recovery + scroll preservation). Per-row password edit lives in a
// `rotatingId` signal keyed by user id (sticky like InlineConfirm).
//
// `feedback_solidjs_for_ref_leak`: NO let-bound refs in the For row.
// All handlers close over `u.id` (string copy) or use controlled
// `<input>` elements bound to per-row state.
//
// `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.
// AdminPane's mount gate is the reachability boundary.
//
// Per CLAUDE.md "No localized strings server-side": error tokens come
// from the server as snake_case strings ("last_admin",
// "validation_failed"); cic owns human-readable rendering.
//
// #943 — the banner shows the RAW wire token, on purpose: operator-console
// policy (AdminSettingsTab lines 33-35). The three verbs whose controller
// `@spec` admits an `Ecto.Changeset.t()` (create / toggle admin / rotate
// password) additionally append the 422's per-field detail via
// `operatorApiError`, because the token alone never says which field is
// wrong. `delete` and the list GET cannot produce a changeset, so they keep
// the plain `err.code` narrowing.

type CreateForm = {
  name: string;
  password: string;
  is_admin: boolean;
};

const EMPTY_CREATE: CreateForm = { name: "", password: "", is_admin: false };

// Admin redesign (2026-08-07 plan, Layer 4) — the table's column count,
// fed to `AdminExpandRow` so the password-rotation row's `colspan` is
// DERIVED rather than the hardcoded `colspan="5"` it used to carry. It
// is also a contract: admin-users.spec.ts reads the admin cell as
// `row.locator("td").nth(1)`, so the column ORDER and count are pinned
// by an e2e assertion, not just by taste.
const USER_COLUMNS = 5;

const AdminUsersTab: Component = () => {
  const [users, setUsers] = createSignal<AdminUser[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  // Create form lives at the header (singleton). When create succeeds
  // the form resets to EMPTY_CREATE and the new row appears via refetch.
  const [createForm, setCreateForm] = createSignal<CreateForm>({ ...EMPTY_CREATE });
  const [creating, setCreating] = createSignal(false);

  // Per-row password rotation. `rotatingId` is the open row; null = no
  // row open. `passwordInput` is the open row's input value.
  const [rotatingId, setRotatingId] = createSignal<string | null>(null);
  const [passwordInput, setPasswordInput] = createSignal<string>("");

  // Per-row delete inline-confirm.
  const [confirmingId, setConfirmingId] = createSignal<string | null>(null);

  const refresh = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    setLoading(true);
    setError(null);
    setConfirmingId(null);
    try {
      const next = await adminListUsers(t);
      setUsers(next);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "fetch_failed";
      setError(code);
    } finally {
      setLoading(false);
    }
  };

  const onCreate = async (e: Event): Promise<void> => {
    e.preventDefault();
    const t = token();
    if (t === null) return;
    const form = createForm();
    if (form.name === "" || form.password === "") return;
    setCreating(true);
    setError(null);
    try {
      await adminCreateUser(t, {
        name: form.name,
        password: form.password,
        is_admin: form.is_admin,
      });
      setCreateForm({ ...EMPTY_CREATE });
      await refresh();
    } catch (err) {
      setError(`create: ${operatorApiError(err, "create_failed")}`);
    } finally {
      setCreating(false);
    }
  };

  const onToggleAdmin = async (u: AdminUser): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminUpdateUserAdmin(t, u.id, !u.is_admin);
      await refresh();
    } catch (err) {
      setError(`toggle admin (${u.name}): ${operatorApiError(err, "request_failed")}`);
    }
  };

  const onArmRotate = (id: string): void => {
    setRotatingId(id);
    setPasswordInput("");
  };

  const onCancelRotate = (): void => {
    setRotatingId(null);
    setPasswordInput("");
  };

  const onSubmitRotate = async (u: AdminUser): Promise<void> => {
    const t = token();
    if (t === null) return;
    const password = passwordInput();
    if (password === "") return;
    setError(null);
    try {
      await adminUpdateUserPassword(t, u.id, password);
      setRotatingId(null);
      setPasswordInput("");
      // Refresh so updated_at flips visibly; live_session_count won't
      // change but the operator sees confirmation via row-state rerender.
      await refresh();
    } catch (err) {
      setError(`rotate password (${u.name}): ${operatorApiError(err, "request_failed")}`);
    }
  };

  const onDelete = async (u: AdminUser): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminDeleteUser(t, u.id);
      const cur = users();
      if (cur !== null) setUsers(cur.filter((x) => x.id !== u.id));
      setConfirmingId(null);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`delete (${u.name}): ${code}`);
      setConfirmingId(null);
    }
  };

  onMount(() => {
    void refresh();
  });

  return (
    <div class="admin-users-tab">
      <AdminToolbar
        title="Users"
        actions={
          <AdminRefreshButton
            onClick={() => {
              void refresh();
            }}
            busy={loading()}
            label="refresh users list"
            testId="admin-users-refresh"
          />
        }
      />

      <div class="adm-scroll">
        <Show when={error() !== null}>
          <AdminError message={error() ?? ""} testId="admin-users-error" />
        </Show>

        <AdminCard title="Create user" subtitle="POST /admin/users">
          <form
            class="admin-users-create-form adm-form-row"
            onSubmit={(e) => {
              void onCreate(e);
            }}
            data-testid="admin-users-create-form"
          >
            <input
              placeholder="name"
              aria-label="name"
              type="text"
              value={createForm().name}
              onInput={(e) =>
                setCreateForm({
                  ...createForm(),
                  name: (e.currentTarget as HTMLInputElement).value,
                })
              }
              data-testid="admin-users-create-name"
              required
            />
            <input
              placeholder="password"
              aria-label="password"
              type="password"
              value={createForm().password}
              onInput={(e) =>
                setCreateForm({
                  ...createForm(),
                  password: (e.currentTarget as HTMLInputElement).value,
                })
              }
              data-testid="admin-users-create-password"
              required
            />
            {/* A checkbox carries its label beside it, not inside it as a
                placeholder the way the text fields above do. */}
            <label class="admin-users-create-admin adm-check">
              <input
                type="checkbox"
                checked={createForm().is_admin}
                onChange={(e) =>
                  setCreateForm({
                    ...createForm(),
                    is_admin: (e.currentTarget as HTMLInputElement).checked,
                  })
                }
                data-testid="admin-users-create-is-admin"
              />
              admin
            </label>
            <button
              type="submit"
              class="adm-btn"
              disabled={creating() || createForm().name === "" || createForm().password === ""}
              data-testid="admin-users-create-submit"
            >
              Create
            </button>
          </form>
        </AdminCard>

        <Show when={users() === null && error() === null}>
          <AdminLoading />
        </Show>

        <Show when={users() !== null && (users() ?? []).length === 0}>
          <AdminEmpty message="no users" testId="admin-users-empty" />
        </Show>

        <Show when={users() !== null && (users() ?? []).length > 0}>
          <AdminCard
            title="Accounts"
            subtitle="live sessions is the Registry count, not a DB column"
          >
            <AdminTable data-testid="admin-users-table">
              <thead>
                <tr>
                  <th class="adm-table-grow">name</th>
                  <th>admin</th>
                  <th>live sessions</th>
                  <th>inserted</th>
                  {/* Visible, like the other migrated tabs: an unlabelled
                      column reads as a rendering bug, and the actions here
                      are destructive enough to deserve naming. */}
                  <th class="adm-table-sticky-actions">actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={users() ?? []}>
                  {(u) => (
                    <>
                      <tr class="admin-users-row" data-testid={`admin-user-row-${u.id}`}>
                        <td>{u.name}</td>
                        <td>
                          {/* The WORD stays: admin-users.spec.ts reads this
                              cell as text (`td.nth(1)` matching /yes|no/), and
                              it is a yes/no question a colour alone cannot
                              answer. Neutral rather than danger for "no" — a
                              non-admin account is the normal case. */}
                          <AdminBadge tone={u.is_admin ? "ok" : "neutral"}>
                            {u.is_admin ? "yes" : "no"}
                          </AdminBadge>
                        </td>
                        <td>{u.live_session_count}</td>
                        <td>{u.inserted_at}</td>
                        <td class="admin-users-actions adm-table-sticky-actions">
                          <button
                            type="button"
                            class="adm-btn"
                            onClick={() => {
                              void onToggleAdmin(u);
                            }}
                            data-testid={`admin-user-toggle-admin-${u.id}`}
                          >
                            {u.is_admin ? "Demote" : "Promote"}
                          </button>
                          <button
                            type="button"
                            class="adm-btn"
                            onClick={() => onArmRotate(u.id)}
                            data-testid={`admin-user-rotate-password-${u.id}`}
                          >
                            Rotate password
                          </button>
                          <InlineConfirmButton
                            idleLabel="Delete"
                            confirmLabel="Confirm delete?"
                            armed={confirmingId() === u.id}
                            onArm={() => setConfirmingId(u.id)}
                            onConfirm={() => onDelete(u)}
                            testId={`admin-user-delete-${u.id}`}
                            extraClass="delete-btn"
                          />
                        </td>
                      </tr>
                      <Show when={rotatingId() === u.id}>
                        <AdminExpandRow
                          columns={USER_COLUMNS}
                          class="admin-users-row-rotate"
                          data-testid={`admin-user-rotate-form-${u.id}`}
                        >
                          <form
                            class="adm-form-row"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void onSubmitRotate(u);
                            }}
                          >
                            <input
                              placeholder={`new password for ${u.name}`}
                              aria-label={`new password for ${u.name}`}
                              type="password"
                              value={passwordInput()}
                              onInput={(e) =>
                                setPasswordInput((e.currentTarget as HTMLInputElement).value)
                              }
                              data-testid={`admin-user-rotate-input-${u.id}`}
                              required
                            />
                            <button
                              type="submit"
                              class="adm-btn"
                              disabled={passwordInput() === ""}
                              data-testid={`admin-user-rotate-submit-${u.id}`}
                            >
                              Rotate
                            </button>
                            <button
                              type="button"
                              class="adm-btn"
                              onClick={onCancelRotate}
                              data-testid={`admin-user-rotate-cancel-${u.id}`}
                            >
                              Cancel
                            </button>
                          </form>
                        </AdminExpandRow>
                      </Show>
                    </>
                  )}
                </For>
              </tbody>
            </AdminTable>
          </AdminCard>
        </Show>
      </div>
    </div>
  );
};

export default AdminUsersTab;
