import { type Component, createSignal, For, onMount, Show } from "solid-js";
import AdminBadge from "./admin/AdminBadge";
import AdminCard from "./admin/AdminCard";
import AdminDetailPanel from "./admin/AdminDetailPanel";
import { AdminEmpty, AdminError, AdminLoading } from "./admin/AdminStatus";
import AdminTable from "./admin/AdminTable";
import { connectionTone } from "./admin/connectionTone";
import { useRefreshSlot } from "./admin/refreshSlot";
import InlineConfirmButton from "./InlineConfirmButton";
import {
  type AdminCredential,
  type AdminNetwork,
  type AdminUser,
  ApiError,
  adminBindCredential,
  adminListCredentials,
  adminListNetworks,
  adminListUsers,
  adminUnbindCredential,
  adminUpdateCredential,
} from "./lib/api";
import { token } from "./lib/auth";
// #410 — the auth-method options ARE the codegen-emitted
// `IRCAUTH_FSMAUTH_METHOD` const (mirror of `Grappa.IRC.Auth.FSM`'s
// auth_method closed set), not a hand copy.
import { IRCAUTH_FSMAUTH_METHOD } from "./lib/wireTypes";

// Admin-panel bucket 5 — Credentials admin tab.
//
// Surfaces:
//   * GET /admin/credentials — list with `live_state` (U-0 honesty
//     signal: null = DB says connected but BEAM has no pid).
//   * POST /admin/credentials — bind form (user + network + nick +
//     auth_method + optional password / sasl_user / realname /
//     autojoin).
//   * PATCH /admin/credentials/:user_id/:network_id — per-row inline
//     password rotation + auth_method swap. Per A-2 the wrapper kills
//     the live session when password / auth_method changes; the
//     response carries `session_action: "left_alone" | "stopped"`
//     which we surface in a transient toast.
//   * DELETE /admin/credentials/:user_id/:network_id — InlineConfirm.
//
// Sidecar fetches: GET /admin/users + GET /admin/networks at mount
// for the bind form's dropdowns (users by name, networks by slug).
// One refetch per mutation per AdminVisitorsTab/AdminNetworksTab
// pattern.
//
// `feedback_solidjs_for_ref_leak`: NO let-bound refs in For. Handlers
// close over `cred.user_id + cred.network_id` (string + number).
//
// `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.

type BindForm = {
  user_id: string;
  network_id: string;
  nick: string;
  auth_method: string;
  password: string;
  sasl_user: string;
  realname: string;
  autojoin_channels: string;
};

const EMPTY_BIND: BindForm = {
  user_id: "",
  network_id: "",
  nick: "",
  auth_method: "none",
  password: "",
  sasl_user: "",
  realname: "",
  autojoin_channels: "",
};

type EditForm = {
  nick: string;
  realname: string;
  sasl_user: string;
  auth_method: string;
  password: string;
  autojoin_channels: string;
};

function credKey(c: AdminCredential): string {
  return `${c.user_id}:${c.network_id}`;
}

const AdminCredentialsTab: Component = () => {
  const [credentials, setCredentials] = createSignal<AdminCredential[] | null>(null);
  const [users, setUsers] = createSignal<AdminUser[]>([]);
  const [networks, setNetworks] = createSignal<AdminNetwork[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const [bindForm, setBindForm] = createSignal<BindForm>({ ...EMPTY_BIND });
  const [binding, setBinding] = createSignal(false);

  const [editingKey, setEditingKey] = createSignal<string | null>(null);
  const [editForm, setEditForm] = createSignal<EditForm | null>(null);

  const [confirmingKey, setConfirmingKey] = createSignal<string | null>(null);
  const [sessionActionToast, setSessionActionToast] = createSignal<string | null>(null);

  // The binding the edit panel is open on. DERIVED from `editingKey` +
  // the fetched list rather than stored a second time, so a refetch
  // cannot leave the panel titled with a stale nick, and a binding
  // unbound by another admin closes it by itself. `editForm` still holds
  // the DRAFT — that is the operator's typing, and a refetch must not
  // stomp it.
  const editingCredential = (): AdminCredential | undefined =>
    (credentials() ?? []).find((c) => credKey(c) === editingKey());

  const refresh = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    setLoading(true);
    setError(null);
    setConfirmingKey(null);
    try {
      const [creds, us, nets] = await Promise.all([
        adminListCredentials(t),
        adminListUsers(t),
        adminListNetworks(t),
      ]);
      setCredentials(creds);
      setUsers(us);
      setNetworks(nets);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "fetch_failed";
      setError(code);
    } finally {
      setLoading(false);
    }
  };

  const onBind = async (e: Event): Promise<void> => {
    e.preventDefault();
    const t = token();
    if (t === null) return;
    const f = bindForm();
    if (f.user_id === "" || f.network_id === "" || f.nick === "") return;
    const networkId = Number.parseInt(f.network_id, 10);
    if (!Number.isFinite(networkId)) {
      setError("bind: invalid network_id");
      return;
    }
    setBinding(true);
    setError(null);
    try {
      const autojoin =
        f.autojoin_channels.trim() === ""
          ? undefined
          : f.autojoin_channels
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s !== "");
      await adminBindCredential(t, {
        user_id: f.user_id,
        network_id: networkId,
        nick: f.nick,
        auth_method: f.auth_method,
        password: f.password === "" ? undefined : f.password,
        sasl_user: f.sasl_user === "" ? undefined : f.sasl_user,
        realname: f.realname === "" ? undefined : f.realname,
        autojoin_channels: autojoin,
      });
      setBindForm({ ...EMPTY_BIND });
      await refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`bind: ${code}`);
    } finally {
      setBinding(false);
    }
  };

  const onArmEdit = (c: AdminCredential): void => {
    setEditingKey(credKey(c));
    setEditForm({
      nick: c.nick,
      realname: c.realname ?? "",
      sasl_user: c.sasl_user ?? "",
      auth_method: c.auth_method,
      password: "",
      autojoin_channels: c.autojoin_channels.join(", "),
    });
  };

  const onCancelEdit = (): void => {
    setEditingKey(null);
    setEditForm(null);
  };

  const onSubmitEdit = async (c: AdminCredential): Promise<void> => {
    const t = token();
    if (t === null) return;
    const f = editForm();
    if (f === null) return;
    // Build patch with only changed fields. Empty password = no change
    // (the server enforces password-required when auth_method changes
    // separately).
    const patch: Parameters<typeof adminUpdateCredential>[3] = {};
    if (f.nick !== c.nick) patch.nick = f.nick;
    if (f.realname !== (c.realname ?? "")) patch.realname = f.realname;
    if (f.sasl_user !== (c.sasl_user ?? "")) patch.sasl_user = f.sasl_user;
    if (f.auth_method !== c.auth_method) patch.auth_method = f.auth_method;
    if (f.password !== "") patch.password = f.password;
    const newAutojoin = f.autojoin_channels
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (JSON.stringify(newAutojoin) !== JSON.stringify(c.autojoin_channels)) {
      patch.autojoin_channels = newAutojoin;
    }
    if (Object.keys(patch).length === 0) {
      onCancelEdit();
      return;
    }
    setError(null);
    try {
      const updated = await adminUpdateCredential(t, c.user_id, c.network_id, patch);
      const sa = updated.session_action;
      if (sa === "stopped") {
        setSessionActionToast(
          `session for ${c.network_slug} stopped — operator must /connect to bring it back`,
        );
      } else if (sa === "left_alone") {
        setSessionActionToast(`credential updated (session left alone)`);
      }
      setEditingKey(null);
      setEditForm(null);
      await refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`edit (${c.network_slug}): ${code}`);
    }
  };

  const onDelete = async (c: AdminCredential): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminUnbindCredential(t, c.user_id, c.network_id);
      const cur = credentials();
      if (cur !== null) {
        setCredentials(cur.filter((x) => credKey(x) !== credKey(c)));
      }
      setConfirmingKey(null);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`unbind (${c.network_slug}): ${code}`);
      setConfirmingKey(null);
    }
  };

  // The pane header renders this tab's refresh (see
  // `admin/refreshSlot.ts`): the toolbar that used to hold it said
  // nothing the nav above does not already say.
  useRefreshSlot({
    onRefresh: () => {
      void refresh();
    },
    busy: loading,
    label: "refresh credentials list",
    testId: "admin-credentials-refresh",
  });

  onMount(() => {
    void refresh();
  });

  const userName = (id: string): string => {
    const u = users().find((x) => x.id === id);
    return u !== undefined ? u.name : id;
  };

  return (
    <div class="admin-credentials-tab">
      <div class="adm-scroll">
        <Show when={sessionActionToast() !== null}>
          <p class="adm-success" data-testid="admin-credentials-session-action-toast">
            {sessionActionToast()}
          </p>
        </Show>

        <Show when={error() !== null}>
          <AdminError message={error() ?? ""} testId="admin-credentials-error" />
        </Show>

        <AdminCard title="Bind a credential" subtitle="POST /admin/credentials">
          <form
            class="admin-credentials-bind-form adm-form-grid"
            onSubmit={(e) => {
              void onBind(e);
            }}
            data-testid="admin-credentials-bind-form"
          >
            <select
              aria-label="user"
              value={bindForm().user_id}
              onChange={(e) =>
                setBindForm({
                  ...bindForm(),
                  user_id: (e.currentTarget as HTMLSelectElement).value,
                })
              }
              data-testid="admin-credentials-bind-user"
              required
            >
              <option value="">— user —</option>
              <For each={users()}>{(u) => <option value={u.id}>{u.name}</option>}</For>
            </select>
            <select
              aria-label="network"
              value={bindForm().network_id}
              onChange={(e) =>
                setBindForm({
                  ...bindForm(),
                  network_id: (e.currentTarget as HTMLSelectElement).value,
                })
              }
              data-testid="admin-credentials-bind-network"
              required
            >
              <option value="">— network —</option>
              <For each={networks()}>{(n) => <option value={String(n.id)}>{n.slug}</option>}</For>
            </select>
            <input
              placeholder="nick"
              aria-label="nick"
              type="text"
              value={bindForm().nick}
              onInput={(e) =>
                setBindForm({ ...bindForm(), nick: (e.currentTarget as HTMLInputElement).value })
              }
              data-testid="admin-credentials-bind-nick"
              required
            />
            <select
              aria-label="auth method"
              value={bindForm().auth_method}
              onChange={(e) =>
                setBindForm({
                  ...bindForm(),
                  auth_method: (e.currentTarget as HTMLSelectElement).value,
                })
              }
              data-testid="admin-credentials-bind-auth-method"
            >
              <For each={IRCAUTH_FSMAUTH_METHOD}>{(m) => <option value={m}>auth: {m}</option>}</For>
            </select>
            <input
              placeholder="password"
              aria-label="password"
              type="password"
              value={bindForm().password}
              onInput={(e) =>
                setBindForm({
                  ...bindForm(),
                  password: (e.currentTarget as HTMLInputElement).value,
                })
              }
              data-testid="admin-credentials-bind-password"
            />
            <input
              placeholder="sasl user"
              aria-label="sasl user"
              type="text"
              value={bindForm().sasl_user}
              onInput={(e) =>
                setBindForm({
                  ...bindForm(),
                  sasl_user: (e.currentTarget as HTMLInputElement).value,
                })
              }
              data-testid="admin-credentials-bind-sasl-user"
            />
            <input
              placeholder="realname"
              aria-label="realname"
              type="text"
              value={bindForm().realname}
              onInput={(e) =>
                setBindForm({
                  ...bindForm(),
                  realname: (e.currentTarget as HTMLInputElement).value,
                })
              }
              data-testid="admin-credentials-bind-realname"
            />
            <input
              placeholder="autojoin"
              aria-label="autojoin"
              type="text"
              value={bindForm().autojoin_channels}
              onInput={(e) =>
                setBindForm({
                  ...bindForm(),
                  autojoin_channels: (e.currentTarget as HTMLInputElement).value,
                })
              }
              data-testid="admin-credentials-bind-autojoin"
            />
            <div class="adm-form-grid-actions">
              <button
                type="submit"
                class="adm-btn adm-btn--ok"
                disabled={
                  binding() ||
                  bindForm().user_id === "" ||
                  bindForm().network_id === "" ||
                  bindForm().nick === ""
                }
                data-testid="admin-credentials-bind-submit"
              >
                Bind
              </button>
            </div>
          </form>
        </AdminCard>

        <Show when={credentials() === null && error() === null}>
          <AdminLoading />
        </Show>

        <Show when={credentials() !== null && (credentials() ?? []).length === 0}>
          <AdminEmpty message="no credentials" testId="admin-credentials-empty" />
        </Show>

        <Show when={editForm() !== null && editingCredential()}>
          {(c) => (
            <AdminDetailPanel
              title={`Edit ${userName(c().user_id)} @ ${c().network_slug}`}
              subtitle="only changed fields are sent; a password or auth-method change stops the live session"
              onClose={onCancelEdit}
              closeLabel="cancel credential edit"
              data-testid={`admin-credential-edit-form-${credKey(c())}`}
            >
              <form
                class="adm-form-grid"
                onSubmit={(e) => {
                  e.preventDefault();
                  void onSubmitEdit(c());
                }}
              >
                <CredentialEditFields
                  form={editForm() as EditForm}
                  onChange={(next) => setEditForm(next)}
                  credKey={credKey(c())}
                />
                <div class="adm-form-grid-actions">
                  <button
                    type="submit"
                    class="adm-btn adm-btn--ok"
                    data-testid={`admin-credential-edit-submit-${credKey(c())}`}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    class="adm-btn adm-btn--danger"
                    onClick={onCancelEdit}
                    data-testid={`admin-credential-edit-cancel-${credKey(c())}`}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </AdminDetailPanel>
          )}
        </Show>
        <Show when={credentials() !== null && (credentials() ?? []).length > 0}>
          <AdminCard
            title="Bindings"
            subtitle="CONNECTION is the DB state, LIVE is the BEAM pid — they can disagree"
          >
            <AdminTable data-testid="admin-credentials-table">
              <thead>
                <tr>
                  <th>user</th>
                  <th>network</th>
                  <th class="adm-table-grow">nick</th>
                  <th>auth</th>
                  <th>connection</th>
                  <th>live</th>
                  <th class="adm-table-sticky-actions">actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={credentials() ?? []}>
                  {(c) => (
                    <tr
                      class="admin-credentials-row"
                      data-testid={`admin-credential-row-${credKey(c)}`}
                    >
                      <td>{userName(c.user_id)}</td>
                      <td>{c.network_slug}</td>
                      <td>{c.nick}</td>
                      <td>{c.auth_method}</td>
                      <td>
                        <AdminBadge tone={connectionTone(c.connection_state)}>
                          {c.connection_state}
                        </AdminBadge>
                      </td>
                      <td>
                        {/* The three live-pid readings were a bare ternary
                              emitting raw text (one arm even carrying its own
                              "●"). They are the U-0 honesty signal, so they get
                              the same badge vocabulary as every other state —
                              and the WORDS stay: "BEAM has no pid" is asserted
                              verbatim by AdminCredentialsTab.test.tsx, and it
                              says something a colour cannot. The "●" is gone
                              because `.adm-badge` already draws the dot. */}
                        <AdminBadge
                          tone={
                            c.live_state === null ? "neutral" : c.live_state.alive ? "ok" : "danger"
                          }
                        >
                          {c.live_state === null
                            ? "BEAM has no pid"
                            : c.live_state.alive
                              ? "alive"
                              : "pid dead"}
                        </AdminBadge>
                      </td>
                      <td class="admin-credentials-actions adm-table-sticky-actions">
                        <button
                          type="button"
                          class="adm-btn"
                          onClick={() => onArmEdit(c)}
                          data-testid={`admin-credential-edit-${credKey(c)}`}
                        >
                          Edit
                        </button>
                        <InlineConfirmButton
                          idleLabel="Unbind"
                          confirmLabel="Confirm unbind?"
                          armed={confirmingKey() === credKey(c)}
                          onArm={() => setConfirmingKey(credKey(c))}
                          onConfirm={() => onDelete(c)}
                          testId={`admin-credential-unbind-${credKey(c)}`}
                          extraClass="delete-btn"
                        />
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </AdminTable>
          </AdminCard>
        </Show>
        {/* Both halves of the guard matter, and the original expand row
            had them for the same reason: `editingKey` names the row and
            `editForm` holds the draft, and `onArmEdit` sets them in that
            order. Gating on the row alone renders the panel for one tick
            with a null draft, and `CredentialEditFields` reads
            `props.form.nick` unconditionally. */}
      </div>
    </div>
  );
};

// Extracted to keep the row template readable. Pure controlled inputs;
// no internal state. Parent owns the EditForm signal.
const CredentialEditFields: Component<{
  form: EditForm;
  onChange: (next: EditForm) => void;
  credKey: string;
}> = (props) => {
  const set = (patch: Partial<EditForm>): void => {
    props.onChange({ ...props.form, ...patch });
  };
  return (
    <>
      <input
        placeholder="nick"
        aria-label="nick"
        type="text"
        value={props.form.nick}
        onInput={(e) => set({ nick: (e.currentTarget as HTMLInputElement).value })}
        data-testid={`admin-credential-edit-nick-${props.credKey}`}
      />
      <input
        placeholder="realname"
        aria-label="realname"
        type="text"
        value={props.form.realname}
        onInput={(e) => set({ realname: (e.currentTarget as HTMLInputElement).value })}
        data-testid={`admin-credential-edit-realname-${props.credKey}`}
      />
      <input
        placeholder="sasl user"
        aria-label="sasl user"
        type="text"
        value={props.form.sasl_user}
        onInput={(e) => set({ sasl_user: (e.currentTarget as HTMLInputElement).value })}
        data-testid={`admin-credential-edit-sasl-user-${props.credKey}`}
      />
      <select
        aria-label="auth method"
        value={props.form.auth_method}
        onChange={(e) => set({ auth_method: (e.currentTarget as HTMLSelectElement).value })}
        data-testid={`admin-credential-edit-auth-method-${props.credKey}`}
      >
        <For each={IRCAUTH_FSMAUTH_METHOD}>{(m) => <option value={m}>auth: {m}</option>}</For>
      </select>
      <input
        placeholder="password"
        aria-label="password"
        type="password"
        value={props.form.password}
        onInput={(e) => set({ password: (e.currentTarget as HTMLInputElement).value })}
        data-testid={`admin-credential-edit-password-${props.credKey}`}
      />
      <input
        placeholder="autojoin"
        aria-label="autojoin"
        type="text"
        value={props.form.autojoin_channels}
        onInput={(e) => set({ autojoin_channels: (e.currentTarget as HTMLInputElement).value })}
        data-testid={`admin-credential-edit-autojoin-${props.credKey}`}
      />
    </>
  );
};

export default AdminCredentialsTab;
