defmodule Grappa.Session.Deps do
  @moduledoc """
  The callbacks a session is BUILT with, in one struct.

  These ten are dependencies, not state. Nothing in a session's lifetime
  writes them: `init/1` reads them out of the resolved plan and every later
  read is a call. Carried as opaque function references rather than module
  aliases because the producing contexts (Networks, Visitors, QueryWindows)
  already depend on `Grappa.Session`, so a literal alias would close a
  Boundary cycle — the per-type notes below record which cycle each one
  dodges.

  Grouping them costs no behaviour and buys two things. `Session.Server`'s
  state drops from 85 top-level keys to 76, and the `EventRouter` state
  contract stops carrying a bare closure among fields that are genuinely
  state: what it sees now is one typed field it can project as a whole.

  The struct is built by `from_opts/1` from the SAME `start_link/1` keyword
  API as before — the ten option keys are unchanged, so no producer of a
  session plan had to move.
  """

  alias Grappa.QueryWindows
  alias Grappa.Session.EventRouter

  @typedoc """
  Optional opaque callback the visitor-side `SessionPlan` injects into
  every visitor plan. Invoked by `apply_effects/2` when EventRouter emits
  `:identity_secret_confirmed` so the confirmed NickServ password AND the nick held
  at the identify instant land on the credential (#561). The function shape
  mirrors `Grappa.Visitors.commit_identity/4` (the closure captures
  `network_id`, so the args are `(visitor_id, password, nick)`). Carried as
  an opaque function reference (not a module name) to avoid a static
  `Session → Visitors` boundary alias — Visitors already deps Session
  via `Visitors.Login`, so a literal alias would close a cycle.
  """
  @type visitor_committer ::
          (Ecto.UUID.t(), String.t(), String.t() ->
             {:ok, struct()} | {:error, :not_found | Ecto.Changeset.t()})

  @typedoc """
  #131 — visitor-side SET PASSWD committer the visitor `SessionPlan`
  injects. The visitor counterpart of `credential_committer`. Invoked from
  the outbound NickServ-secret capture choke point (NOT the `+r` path) when
  a well-formed in-session `SET PASSWD` leaves the wire.

  Deliberately NOT `visitor_committer` (`commit_identity/4`): that one
  promotes anon→permanent (+ binds the identified nick), which is only safe
  behind the `+r` identity proof. This shape maps to
  `Grappa.Visitors.rotate_password/2`, which is
  identity-gated (`{:error, :not_identified}` for an anon row) so an
  optimistic commit can't pin an unidentified visitor permanent. Same
  Boundary-cycle-avoiding function-reference indirection as
  `visitor_committer`.
  """
  @type visitor_password_rotator ::
          (Ecto.UUID.t(), String.t() ->
             {:ok, struct()} | {:error, :not_found | :not_identified | Ecto.Changeset.t()})

  @typedoc """
  V9 (visitor-parity cluster, 2026-05-15) — opaque callback the
  visitor-side `SessionPlan` injects so `apply_effects/2` can rotate
  `visitors.nick` after EventRouter observes the upstream NICK
  self-echo. Same Boundary-cycle reasoning as `visitor_committer`:
  Visitors deps Session via Login, so a static
  `Session → Grappa.Visitors` alias would close the cycle. The
  function shape mirrors `Grappa.Visitors.update_nick/3` exactly —
  including #561's `{:ok, :held_identified}` (the echo persist is a no-op
  when the credential is identified; its nick is bound at `+r` instead).
  """
  @type visitor_nick_persister ::
          (Ecto.UUID.t(), String.t() ->
             {:ok, struct() | :held_identified} | {:error, :not_found | Ecto.Changeset.t()})

  @typedoc """
  Optional opaque callback injected by `Networks.SessionPlan.resolve/1`
  into every user-session plan. Called from `handle_terminal_failure/2`
  when a hard upstream error (k-line / permanent SASL) means the session
  should never be restarted without operator action.

  The closure captures `user_id` + `network_id` and calls
  `Networks.mark_failed_by_ids/3` — a static Networks alias is avoided
  here for the same Boundary reason as `visitor_committer` (Networks
  already deps Session; closing the cycle is banned by `use Boundary`).

  Calling convention: fire inside a supervised `Task.Supervisor.start_child/2`
  (S37) BEFORE `{:stop, :normal}` so the Server's GenServer exit is truly
  `:normal` and the `:transient` supervisor doesn't restart. The Task's
  async execution means `mark_failed_by_ids` runs after the process has
  exited — `stop_session` inside `mark_failed` finds `whereis → nil` and is
  a no-op.
  """
  @type credential_failer :: (String.t() -> :ok)

  @typedoc """
  #131 — opaque callback injected by `Networks.SessionPlan.resolve/1`
  into every USER-session plan. Invoked from the outbound NickServ-secret
  capture choke point when a well-formed in-session `SET PASSWD` leaves
  the wire, so the new upstream NickServ password is committed to the
  bound credential OPTIMISTICALLY (no `+r` rendezvous fires for a password
  change from an already-identified session).

  User-side mirror of `visitor_committer`: the closure captures
  `(user_id, network_id)` and forwards to
  `Grappa.Networks.Credentials.commit_password/3`. The function-reference
  indirection avoids a static `Session → Grappa.Networks` alias (Networks
  already deps Session for `stop_session`, so the reverse closes a
  Boundary cycle). Visitor plans don't carry it (nil); the visitor home
  is reached via `visitor_committer` instead.
  """
  @type credential_committer ::
          (String.t() ->
             {:ok, struct()} | {:error, :not_found | Ecto.Changeset.t()})

  @typedoc """
  #349 — opaque callback injected by `Networks.SessionPlan.resolve/1` into
  every USER-session plan. Invoked from the `+r` observer (`apply_effects/2`)
  when a wizard-driven REGISTER is confirmed (a staged
  `pending_registration_secret` + the services-set `+r`), so the REGISTER
  password is committed to the bound credential AND its `auth_method` flips to
  `:nickserv_identify` (the registered nick must auto-identify on every future
  reconnect, else services enforce it).

  Distinct from `credential_committer` (#131, SET PASSWD — password only, no
  auth_method change): registration promotes a `--auth none` binding to
  auto-identify, so it forwards to
  `Grappa.Networks.Credentials.commit_registration_password/3`. Same
  function-reference indirection (Networks deps Session; the reverse would
  close a Boundary cycle) and `(user_id, network_id)` capture as
  `credential_committer`. Visitor plans don't carry it (nil); the visitor `+r`
  promotion runs via `visitor_committer` instead.
  """
  @type registration_committer ::
          (String.t() ->
             {:ok, struct()} | {:error, :not_found | Ecto.Changeset.t()})

  @typedoc """
  CP22 cluster B (channel-client-polish #14, B-restart) — opaque
  callback that persists a channels-list CHANGE so a graceful or crash
  restart can rehydrate the channel list at boot. First argument is the
  current `Map.keys(state.members)` keyset, second the channels THIS
  change removed from it.

  Boundary-clean: Session.Server cannot reference `Grappa.Networks`
  directly (the cycle is banned — Networks already deps Session for
  stop_session calls on /disconnect). The callback wraps a closure
  that knows the (user_id, network_id) pair and forwards to
  `Grappa.Networks.Credentials.merge_last_joined_channels/4`.
  Returns `:ok` on success or `{:error, reason}`; Session.Server logs
  failures but does not retry — the next channels-list mutation unions
  the live keyset back in, and a missing snapshot only forces the next
  restart to fall back to operator autojoin.

  #1385 — the two arguments exist because the keyset ALONE cannot tell
  "not restored yet" from "left": both read as absent. The departures
  therefore travel separately, sourced from the event that caused them.
  """
  @type last_joined_persister :: ([String.t()], [String.t()] -> :ok | {:error, term()})

  @typedoc """
  GH #581 — opaque reader the visitor `SessionPlan` injects so
  `handle_call(:recover_identity, ...)` can resolve the PERSISTENT recover
  target (the registered nick + NickServ secret) without a static
  `Session → Networks/Visitors` alias (Boundary cycle — Visitors deps
  Session via Login). Reads the LIVE credential each call
  (`Credentials.get_visitor_credential` + `Credential.recover_secret/1`),
  NOT `state.pending_password` (one-shot cleared at 001) — so it resolves the
  SAME source as the `recoverable` button gate
  (`Credential.has_nickserv_secret?/1`), the review-#1 fix. `nil` on state =
  no reader injected (user sessions — recover is visitor-only).
  """
  @type recover_source ::
          (-> {:ok, {String.t(), String.t()}} | {:error, :nothing_to_recover})

  @typedoc """
  GH #417 — opaque closure that persists the EXPLICIT away snapshot to the
  producing context (Networks), forwarding `(reason, since)` to
  `Grappa.Networks.Credentials.update_away/4`. `(nil, nil)` clears it on
  `/back`. Boundary-clean for the same reason as `last_joined_persister`:
  Networks already deps Session, so the reverse edge cannot be expressed
  without closing a cycle. Called fire-and-forget from
  `set_explicit_away_internal/3` + the explicit `unset_explicit_away`
  handle_call arms; a `{:error, _}` is logged, not retried (the next away
  transition overwrites). `nil` on state = no persister injected (visitor
  sessions — away is not persisted for the ephemeral subject).
  """
  @type away_persister :: (String.t() | nil, DateTime.t() | nil -> :ok | {:error, term()})

  @typedoc """
  The ten injected callbacks. Nine default to `nil` — a plan that does not
  supply one is declaring the session cannot do that thing (a user session
  has no `recover_source`; a visitor session has no `away_persister`).

  `query_window_open?` is the exception and does NOT default to `nil`: it
  has a real production default, `&QueryWindows.open?/3`. A session always
  has an answer to "is a query window open" — the injection point exists so
  tests can supply a fake and keep `EventRouter` a sandbox-free classifier,
  not because the capability is optional.
  """
  @type t :: %__MODULE__{
          visitor_committer: visitor_committer() | nil,
          visitor_password_rotator: visitor_password_rotator() | nil,
          visitor_nick_persister: visitor_nick_persister() | nil,
          credential_failer: credential_failer() | nil,
          credential_committer: credential_committer() | nil,
          registration_committer: registration_committer() | nil,
          last_joined_persister: last_joined_persister() | nil,
          recover_source: recover_source() | nil,
          away_persister: away_persister() | nil,
          query_window_open?: EventRouter.query_window_open?()
        }

  defstruct visitor_committer: nil,
            visitor_password_rotator: nil,
            visitor_nick_persister: nil,
            credential_failer: nil,
            credential_committer: nil,
            registration_committer: nil,
            last_joined_persister: nil,
            recover_source: nil,
            away_persister: nil,
            query_window_open?: &QueryWindows.open?/3

  @doc """
  Reads the ten callbacks out of a resolved `Grappa.Session.start_opts/0`.

  Absent keys take the struct defaults, which is the same rule `init/1`
  applied when these lived as ten separate `Map.get(opts, :key)` lines.
  """
  @spec from_opts(map()) :: t()
  def from_opts(opts) when is_map(opts) do
    %__MODULE__{
      visitor_committer: Map.get(opts, :visitor_committer),
      visitor_password_rotator: Map.get(opts, :visitor_password_rotator),
      visitor_nick_persister: Map.get(opts, :visitor_nick_persister),
      credential_failer: Map.get(opts, :credential_failer),
      credential_committer: Map.get(opts, :credential_committer),
      registration_committer: Map.get(opts, :registration_committer),
      last_joined_persister: Map.get(opts, :last_joined_persister),
      recover_source: Map.get(opts, :recover_source),
      away_persister: Map.get(opts, :away_persister),
      query_window_open?: Map.get(opts, :query_window_open?, &QueryWindows.open?/3)
    }
  end
end
