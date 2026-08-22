defmodule Grappa.Session.Deps do
  @moduledoc """
  The callbacks a session is BUILT with, in one struct.

  These eleven are dependencies, not state. Nothing in a session's lifetime
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

  The struct is built by `from_opts/2` from the SAME `start_link/1` keyword
  API as before — the option keys are unchanged, so no producer of a
  session plan had to move.

  ## Why the door takes the subject (#1398)

  A closure carries no module reference, so `Boundary` cannot follow the
  edge and nothing at compile time can see these ten. Built with
  `Map.get/2`, an omitted injection produced a `nil` field, and a `nil`
  field is a persist that silently does not happen — not a compile error,
  not a crash, not a log line.

  `nil` could not simply be banned, because it is correct half the time.
  There are exactly TWO producers and they inject DISJOINT sets:

  * `Grappa.Networks.SessionPlan` (registered users) —
    `away_persister`, `credential_committer`, `credential_failer`,
    `last_joined_persister`, `link_state_reporter`,
    `registration_committer`;
  * `Grappa.Visitors.SessionPlan` (visitors) — `credential_failer`,
    `last_joined_persister`, `link_state_reporter`, `recover_source`,
    `visitor_committer`, `visitor_nick_persister`,
    `visitor_password_rotator`.

  Three shared, three user-only, four visitor-only. So `nil` is not a
  default at all: it is a function of the SUBJECT TAG, which
  `Grappa.Subject` already carries. `from_opts/2` validates the set due
  for that tag and raises `Grappa.Session.DepsInjectionError` naming the
  offending keys — the failure moves to spawn, loud, instead of surfacing
  as a missing row weeks later. `required_injections/1` is the single
  source of truth for the two sets; `Grappa.Session.DepsTest` pins it
  against the live output of both producers, since neither can reference
  this module (both their boundaries already dep `Grappa.Session`, so the
  reverse edge would close a cycle — the same reason these are closures).

  Two keys sit outside that rule, both measured:

  * `query_window_open?` is due on NEITHER tag. Neither producer injects
    it, it carries a real production default, and it exists as a seam so
    a test can keep `EventRouter` sandbox-free. Accepted on both tags,
    required on neither.
  * `refresh_plan` is not a field here at all, though both producers
    inject it and it shares the silent-absence class. `Server.init/1`
    consumes it from the raw opts BEFORE `do_init/1` builds this struct,
    because its return value REPLACES the opts the struct is built from.
    It is outside this struct's authority and stays unguarded.
  """

  alias Grappa.QueryWindows
  alias Grappa.Session.{DepsInjectionError, EventRouter}

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
  #1675 — the NON-terminal sibling of `credential_failer`, injected by
  BOTH `SessionPlan`s. Reports what the upstream LINK is doing to the
  credential row: `{:failing, reason}` when a connect attempt could not
  reach or negotiate with the upstream, `:registered` at 001 RPL_WELCOME.

  Two events, one closure, because they are one axis — "is IRC up" — and
  a session that can report one must be able to report the other. Both
  forward to `Grappa.Networks.report_link_state/3`, which owns the
  idempotency (a re-entered backoff must not churn the row) and logs
  every declined transition.

  Unlike `credential_failer` this does NOT stop the session and is
  therefore called INLINE from the connect path, not from a Task: there
  is no `stop_session` to deadlock against. Same opaque-function-
  reference indirection and the same Boundary-cycle reason.

  Shared by both subject tags. The write set of `connection_state` has
  no subject branch, so a user-only reporter would leave the visitor
  half of the column claiming a registration that never happened.
  """
  @type link_state_reporter :: ({:failing, String.t()} | :registered -> :ok)

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
  The eleven injected callbacks. Ten field defaults are `nil`, and a `nil`
  on a LIVE session still means "this session cannot do that thing" (a
  user session has no `recover_source`; a visitor session has no
  `away_persister`) — but which nils are legitimate is decided at the
  door by `from_opts/2`, per subject tag, not by this struct. The
  defaults remain so `%__MODULE__{}` stays constructible for the
  hot-deploy fallback in `Session.Server` (a pre-#1390 live process has
  no `:deps` key at all).

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
          link_state_reporter: link_state_reporter() | nil,
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
            link_state_reporter: nil,
            credential_committer: nil,
            registration_committer: nil,
            last_joined_persister: nil,
            recover_source: nil,
            away_persister: nil,
            query_window_open?: &QueryWindows.open?/3

  # The two due sets, key => the arity the consumer calls the closure at.
  # Arity is part of the contract, not decoration: a closure of the wrong
  # shape fails at the call site — deep inside a running session, on the
  # rare path that reaches for it — which is the same silent-until-late
  # failure the presence check exists to end.
  @user_injections %{
    away_persister: 2,
    credential_committer: 1,
    credential_failer: 1,
    last_joined_persister: 2,
    link_state_reporter: 1,
    registration_committer: 1
  }

  @visitor_injections %{
    credential_failer: 1,
    last_joined_persister: 2,
    link_state_reporter: 1,
    recover_source: 0,
    visitor_committer: 3,
    visitor_nick_persister: 2,
    visitor_password_rotator: 2
  }

  # Derived, never listed twice: the alien check needs the union, and a
  # union computed from the two tables cannot drift away from them.
  @injectable_keys Enum.sort(Enum.uniq(Map.keys(@user_injections) ++ Map.keys(@visitor_injections)))

  @typedoc """
  The closed set of injectable closure keys — TEN, not eleven.

  Ten and not eleven because the union of WHAT THE TWO PRODUCERS INJECT
  includes `refresh_plan`, which this struct does not carry. Measured,
  not assumed:

  * it is absent from `defstruct` above and always has been;
  * `Server.init/1` reads it with its own `Map.get(opts, :refresh_plan)`
    and, on `{:ok, fresh_plan}`, calls `init_or_hold(Map.merge(opts,
    fresh_plan))`. So it is consumed BEFORE `do_init/1` and its return
    value REPLACES the opts this struct is then built from — a check here
    would run after the fact, on a map that already reflects the closure's
    own output.

  Excluded by that structure, therefore, not by oversight and not because
  its absence is safe: both producers inject it, so it belongs to the same
  silent-absence class as these ten, and it stays UNGUARDED. That is the
  documented limitation of this door. `query_window_open?` is the
  eleventh STRUCT field and is likewise not here, for the opposite
  reason — no producer injects it and it has a real production default.
  """
  @type injectable ::
          :away_persister
          | :credential_committer
          | :credential_failer
          | :last_joined_persister
          | :link_state_reporter
          | :recover_source
          | :registration_committer
          | :visitor_committer
          | :visitor_nick_persister
          | :visitor_password_rotator

  @doc """
  The closures due for `subject`'s tag, as `%{key => arity}`.

  The single source of truth for both sets. `Grappa.Session.DepsTest`
  pins it against the live output of `Grappa.Networks.SessionPlan` and
  `Grappa.Visitors.SessionPlan`, so a closure added to a producer without
  an entry here — or an entry no producer injects — is red.
  """
  @spec required_injections(Grappa.Session.subject()) :: %{injectable() => arity()}
  def required_injections({:user, _}), do: @user_injections
  def required_injections({:visitor, _}), do: @visitor_injections

  @doc """
  Every key either producer may inject — the union of the two due sets,
  and never empty.

  A key in this list that is not due for the session's tag is ALIEN: a
  visitor closure on a user session is a mis-wired plan, not a spare
  capability, and `from_opts/2` refuses it. See `t:injectable/0` for why
  the list holds nine keys and not the review's ten.
  """
  @spec injectable_keys() :: [injectable(), ...]
  def injectable_keys, do: @injectable_keys

  @doc """
  Builds the struct from a resolved `Grappa.Session.start_opts/0`,
  validating the injected set against `subject`'s tag.

  Raises `Grappa.Session.DepsInjectionError` when a due key is absent, is
  present as `nil` (the shape the old `Map.get/2` door swallowed), is
  present at the wrong arity, or when a key due for the OTHER tag is
  present. Never returns a partially-injected struct: the plan is either
  complete for its subject or the spawn fails naming what is wrong.
  """
  @spec from_opts(Grappa.Session.subject(), map()) :: t()
  def from_opts(subject, opts) when is_map(opts) do
    :ok = validate!(subject, opts)

    %__MODULE__{
      visitor_committer: Map.get(opts, :visitor_committer),
      visitor_password_rotator: Map.get(opts, :visitor_password_rotator),
      visitor_nick_persister: Map.get(opts, :visitor_nick_persister),
      credential_failer: Map.get(opts, :credential_failer),
      link_state_reporter: Map.get(opts, :link_state_reporter),
      credential_committer: Map.get(opts, :credential_committer),
      registration_committer: Map.get(opts, :registration_committer),
      last_joined_persister: Map.get(opts, :last_joined_persister),
      recover_source: Map.get(opts, :recover_source),
      away_persister: Map.get(opts, :away_persister),
      query_window_open?: Map.get(opts, :query_window_open?, &QueryWindows.open?/3)
    }
  end

  defp validate!(subject, opts) do
    due = required_injections(subject)
    {missing, wrong_arity} = due_faults(due, opts)
    alien = Enum.filter(@injectable_keys -- Map.keys(due), &(Map.get(opts, &1) != nil))

    if missing == [] and wrong_arity == [] and alien == [] do
      :ok
    else
      raise DepsInjectionError,
        subject_tag: elem(subject, 0),
        missing: missing,
        alien: alien,
        wrong_arity: wrong_arity
    end
  end

  # One pass over the due set, splitting it into "not supplied at all" and
  # "supplied at the wrong shape". Sorted input (a map's key order is
  # already sorted for atoms) keeps the message stable across runs.
  defp due_faults(due, opts) do
    {missing, wrong_arity} =
      Enum.reduce(due, {[], []}, fn {key, arity}, {missing, wrong_arity} ->
        case Map.get(opts, key) do
          fun when is_function(fun, arity) ->
            {missing, wrong_arity}

          fun when is_function(fun) ->
            {:arity, got} = Function.info(fun, :arity)
            {missing, [{key, arity, got} | wrong_arity]}

          # Absent, or present as something that is not a function at all —
          # `nil` included, which is the exact value the old `Map.get/2`
          # door accepted in silence. Both are MISSING, not "supplied".
          _ ->
            {[key | missing], wrong_arity}
        end
      end)

    {Enum.reverse(missing), Enum.reverse(wrong_arity)}
  end
end
