defmodule Grappa.Session.Deps do
  @moduledoc """
  The callbacks a session is BUILT with, in one struct.

  These eleven are dependencies, not state. Nothing in a session's lifetime
  writes them: `init/1` reads them out of the resolved plan and every later
  read is a call. TEN of them are carried as opaque function references
  rather than module aliases because the producing contexts (Networks,
  Visitors) already depend on `Grappa.Session`, so a literal alias would
  close a Boundary cycle — the per-type notes below record which cycle each
  one dodges.

  **`query_window_open?` is the eleventh field and is NOT one of them, and
  the distinction is load-bearing rather than pedantic.** Its default is the
  STATIC `&Grappa.QueryWindows.open?/3`; this module aliases
  `Grappa.QueryWindows` by name; and `Grappa.Session` declares that module
  in its `deps:`. `Boundary` SEES that edge — there is no cycle to dodge and
  nothing invisible about it. Measured for issue 2137, which had counted it
  among the invisible ones: what the two producers inject is ELEVEN closures
  (the ten below plus `refresh_plan`), and this field is not among them.

  Grouping them costs no behaviour and buys two things. `Session.Server`'s
  state drops from 85 top-level keys to 76, and the `EventRouter` state
  contract stops carrying a bare closure among fields that are genuinely
  state: what it sees now is one typed field it can project as a whole.

  The struct is built by `from_opts/2` from the SAME `start_link/1` keyword
  API as before — the option keys are unchanged, so no producer of a
  session plan had to move.

  ## Why the door takes the subject (#1398)

  A closure carries no module reference, so `Boundary` cannot follow the
  edge and nothing at compile time can see the ten below. Built with
  `Map.get/2`, an omitted injection produced a `nil` field, and a `nil`
  field is a persist that silently does not happen — not a compile error,
  not a crash, not a log line.

  `nil` could not simply be banned, because it is correct half the time.
  There are exactly TWO producers — `Grappa.Networks.SessionPlan` for
  registered users and `Grappa.Visitors.SessionPlan` for visitors — and
  they inject sets that overlap only in part.

  **The two sets are NOT restated here.** They are `@user_injections` and
  `@visitor_injections` below, reachable as `required_injections/1`, and
  the reason each member exists is `rationale/1`. A prose copy is
  duplicated state with no housekeeping, and this paragraph is the proof:
  it read "three shared, three user-only, four visitor-only" and was
  wrong within one commit of `refresh_plan` joining both tables — the same
  rot that had this file carrying three disagreeing counts of its own
  members when issue 2137 measured it.

  So `nil` is not a default at all: it is a function of the SUBJECT TAG, which
  `Grappa.Subject` already carries. `from_opts/2` validates the set due
  for that tag and raises `Grappa.Session.DepsInjectionError` naming the
  offending keys — the failure moves to spawn, loud, instead of surfacing
  as a missing row weeks later. `required_injections/1` is the single
  source of truth for the two sets; `Grappa.Session.DepsTest` pins it
  against the live output of both producers, since neither can reference
  this module (both their boundaries already dep `Grappa.Session`, so the
  reverse edge would close a cycle — the same reason these are closures).

  Two keys sit outside that rule, both measured, and they sit outside it
  in OPPOSITE directions:

  * `query_window_open?` is a FIELD that is due on NEITHER tag. Neither
    producer injects it, it carries a real production default, and it
    exists as a seam so a test can keep `EventRouter` sandbox-free.
    Accepted on both tags, required on neither.
  * `refresh_plan` is DUE ON BOTH TAGS and is not a field here at all.
    `Server.init/1` consumes it from the raw opts BEFORE `do_init/1`
    builds this struct, because its return value REPLACES the opts the
    struct is built from — so a session keeps no reference to it and
    there is nothing to store.

  **This module therefore has TWO doors, not one (issue 2137).**
  `from_opts/2` guards the ten closures the struct keeps, at the point
  they are stored; `refresh!/2` guards the eleventh, at the point it is
  invoked. Until 2137 the second door did not exist and this file said
  `refresh_plan` "is outside this struct's authority and stays
  unguarded" — the ordering fact was right and the conclusion drawn from
  it was not. Ordering decides WHERE a guard goes, never WHETHER there
  is one, and the gap it left was the loudest kind of quiet: an omitted
  `refresh_plan` is a session replaying the supervisor's cached child
  spec, i.e. holding stale credentials after a rotation, with no crash,
  no error and no log line.
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
  The eleven struct fields: the ten a producer injects, plus
  `query_window_open?`, which none does. Ten field defaults are `nil`, and a `nil`
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
  #
  # `refresh_plan` is due on BOTH tags and is the one member this struct
  # does NOT carry — see `refresh!/2`. That asymmetry is the point of
  # issue 2137: these tables describe the PLAN contract (what a producer
  # owes), which is a wider thing than the struct's CONTENTS (what a
  # session keeps). Conflating the two is what left the eleventh closure
  # outside every guard for four months.
  @user_injections %{
    away_persister: 2,
    credential_committer: 1,
    credential_failer: 1,
    last_joined_persister: 2,
    link_state_reporter: 1,
    refresh_plan: 0,
    registration_committer: 1
  }

  @visitor_injections %{
    credential_failer: 1,
    last_joined_persister: 2,
    link_state_reporter: 1,
    recover_source: 0,
    refresh_plan: 0,
    visitor_committer: 3,
    visitor_nick_persister: 2,
    visitor_password_rotator: 2
  }

  # Derived, never listed twice: the alien check needs the union, and a
  # union computed from the two tables cannot drift away from them.
  @injectable_keys Enum.sort(Enum.uniq(Map.keys(@user_injections) ++ Map.keys(@visitor_injections)))

  # `refresh!/2` is the door for `refresh_plan` and reads its arity from the
  # two tables rather than restating it. Pinned HERE, at compile time,
  # because `DepsTest`'s producer pin cannot catch the key's removal: that
  # test filters the live plan through `injectable_keys/0`, which is derived
  # from these same tables, so dropping the key would drop it from both
  # sides of the assertion at once and leave it green.
  for table <- [@user_injections, @visitor_injections] do
    if not Map.has_key?(table, :refresh_plan) do
      raise "Grappa.Session.Deps: both due tables must carry :refresh_plan — " <>
              "`refresh!/2` reads its arity from them"
    end
  end

  # WHY each member is a closure at all, in ONE place — the third leg of
  # issue 2137. The reasons used to live scattered across eleven typedocs
  # and two producer modules, which is how the count reached eleven with
  # nobody able to state the rationale for the set: the 2026-09-13 review
  # counted twelve, and three separate counts in this file disagreed with
  # each other. Prose alone would rot the same way, so the table is TOTAL
  # by compile-time assertion below — a twelfth closure does not compile
  # until someone writes down why it exists and what its silence costs.
  #
  # Keyed WIDER than `injectable_keys/0` on purpose: `query_window_open?`
  # is a struct field no producer injects, and its entry is the one that
  # records why it is NOT part of the inversion.
  @member_rationale %{
    away_persister:
      "Networks → user plans only. Dodges Session → Grappa.Networks (Networks " <>
        "already deps Session for stop_session). Absent: /away and /back persist " <>
        "nothing, so an explicit away does not survive a reconnect.",
    credential_committer:
      "Networks → user plans only. Same Session → Grappa.Networks cycle. Absent: " <>
        "an in-session SET PASSWD leaves the wire while the bound credential keeps " <>
        "the old secret, so the next reconnect identifies with a password services " <>
        "no longer accept.",
    credential_failer:
      "BOTH producers, deliberately DIFFERENT bodies behind one key (user: mark the " <>
        "credential :failed; visitor: expire the identity row). Dodges Session → " <>
        "Networks and Session → Visitors. Absent: a k-line or permanent SASL failure " <>
        "stops the session recording nothing, and the supervisor respawns into the " <>
        "same wall.",
    last_joined_persister:
      "BOTH. Dodges Session → Networks and Session → Visitors. Absent: the channel " <>
        "keyset is never snapshotted, so a restart rejoins only the operator autojoin " <>
        "— and a visitor, having none, rejoins nothing.",
    link_state_reporter:
      "BOTH, one closure for both edges of one axis (:failing / :registered), because " <>
        "a session that can report one must be able to report the other. Dodges " <>
        "Session → Grappa.Networks. Absent: connection_state keeps claiming " <>
        ":connected while every attempt is refused — the #1675 drift.",
    query_window_open?:
      "NEITHER producer, and the reason this table is keyed wider than " <>
        "injectable_keys/0. Its default is the STATIC &QueryWindows.open?/3, this " <>
        "module aliases Grappa.QueryWindows by name, and Grappa.Session declares it " <>
        "in deps: — so it dodges no cycle and Boundary SEES the edge. It is a test " <>
        "seam that keeps EventRouter sandbox-free, not a carrier of the inversion. " <>
        "Absent is not a state: it has a real production default.",
    recover_source:
      "Visitors → visitor plans only. Dodges Session → Grappa.Visitors (Visitors " <>
        "deps Session via Login). Absent: /recover has no secret to identify with, " <>
        "while the button that offers it reads a credential the session cannot see.",
    refresh_plan:
      "BOTH, and the ONE member consumed outside this struct: Server.init/1 invokes " <>
        "it before do_init/1 and its return REPLACES the opts the struct is built " <>
        "from, so it is guarded by refresh!/2 rather than carried as a field. Dodges " <>
        "Session → Networks and Session → Visitors. Absent: the supervisor's cached " <>
        "child spec is replayed verbatim, so the session keeps a stale nick, a stale " <>
        "autojoin set and stale credentials after a rotation — the 2026-05-27 " <>
        "Azzurra zombie-respawn incident.",
    registration_committer:
      "Networks → user plans only. Same cycle as credential_committer but a " <>
        "different verb: it also flips auth_method to :nickserv_identify. Absent: a " <>
        "nick registered in-session does not auto-identify on the next reconnect and " <>
        "services enforce it away.",
    visitor_committer:
      "Visitors → visitor plans only. Dodges Session → Grappa.Visitors. Absent: a " <>
        "+r-confirmed IDENTIFY never promotes the anon row to permanent, so the " <>
        "visitor is reaped together with the identity it just proved.",
    visitor_nick_persister:
      "Visitors → visitor plans only. Same cycle. Absent: the upstream NICK " <>
        "self-echo is not persisted, so credential and live session disagree on the " <>
        "nick until a restart re-registers under the stale one.",
    visitor_password_rotator:
      "Visitors → visitor plans only. Same cycle. Deliberately NOT visitor_committer: " <>
        "this one is identity-gated, so an optimistic commit cannot pin an " <>
        "unidentified visitor permanent. Absent: a visitor's SET PASSWD rotates " <>
        "upstream and nowhere else."
  }

  # Total by construction: every key this module has authority over — the
  # eleven injectable ones plus the struct field no producer injects — and
  # nothing else. A member added on one side alone fails the BUILD.
  @rationale_domain Enum.sort([:query_window_open? | @injectable_keys])

  if Enum.sort(Map.keys(@member_rationale)) != @rationale_domain do
    raise "Grappa.Session.Deps: @member_rationale must name exactly " <>
            "#{inspect(@rationale_domain)}, got " <>
            "#{inspect(Enum.sort(Map.keys(@member_rationale)))}"
  end

  @typedoc """
  The closed set of injectable closure keys — ELEVEN: exactly what the two
  producers inject between them.

  **Eleven and not ten since issue 2137.** `refresh_plan` used to be
  excluded from this set, and the exclusion reason was true but was doing
  the wrong job. It IS consumed before this struct exists — `Server.init/1`
  invokes it and `Map.merge`s its return over the opts the struct is then
  built from — so a check inside `from_opts/2` alone would run after the
  fact. What did not follow is that it should therefore go unguarded: the
  ordering says WHERE the guard belongs, not WHETHER there is one. It now
  has `refresh!/2`, this module's other door, at the exact point it is
  consumed.

  So this set no longer equals the struct's fields, and the difference is
  deliberate in BOTH directions:

  * `refresh_plan` is in this set and is NOT a `defstruct` field — a
    session keeps no reference to it, because nothing reads it after
    `init/1`. Making it a field would add a member nobody consumes, and
    would move `Deps` into the COLD half of the deploy preflight
    (`HotReload.LongLivedModules` lists this module under `@state_helpers`,
    and `Deploy.Preflight` extracts `@type t` + `defstruct`).
  * `query_window_open?` is a `defstruct` field and is NOT in this set —
    no producer injects it, it has a real production default, and its
    edge is one `Boundary` already sees. See `rationale/1`.
  """
  @type injectable ::
          :away_persister
          | :credential_committer
          | :credential_failer
          | :last_joined_persister
          | :link_state_reporter
          | :recover_source
          | :refresh_plan
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
  the list holds ELEVEN keys that are NOT the eleven fields this struct
  carries — the two sets differ by one member in each direction, and the
  difference is the whole subject of issue 2137. (This line claimed NINE
  until that issue measured it.)
  """
  @spec injectable_keys() :: [injectable(), ...]
  def injectable_keys, do: @injectable_keys

  @doc """
  Why `key` is an opaque closure rather than a module alias, and what its
  silent absence costs — one sentence-set per member, in one place.

  Raises `FunctionClauseError` on anything outside the set, which cannot
  happen from `injectable_keys/0 ++ [:query_window_open?]`: the table is
  held TOTAL against exactly that domain at compile time, so a twelfth
  closure fails the build until its rationale is written.

  This exists because the count reached eleven with the reasons scattered
  over eleven typedocs and two producer modules, and nobody could state
  the rationale for the SET — the 2026-09-13 review counted twelve, and
  three separate counts inside this one file disagreed with each other.
  """
  @spec rationale(injectable() | :query_window_open?) :: String.t()
  def rationale(key) when is_map_key(@member_rationale, key), do: Map.fetch!(@member_rationale, key)

  @doc """
  Invokes the plan's `refresh_plan` and returns its verdict — the door for
  the one injected closure this struct does not carry.

  Returns `{:ok, fresh_plan}` (a PLAIN map, which `Server.init/1` merges
  over the opts) or `{:error, :not_found}` (the subject is no longer
  viable). Raises `Grappa.Session.DepsInjectionError` when the closure is
  absent, is not a 0-arity function, or answers with anything else.

  ## Why the check is here and not in `from_opts/2`

  Both, in fact — `refresh_plan` is due on both tags, so `from_opts/2`
  asserts it too, on the MERGED opts. But `from_opts/2` alone would be
  two steps too late. `init/1` invokes this closure BEFORE `do_init/1`
  builds the struct, and `init_or_hold/1` sits between them: a plan whose
  source resolved to `{:hold, _}` returns `:ignore` without ever reaching
  the struct door. An omitted `refresh_plan` on that path would have gone
  on being silent, which is the exact class issue 2137 is about.

  ## The shape check, and its limit

  The other ten members can only be checked for arity, because nothing at
  the door may invoke them — they have effects. This one is DIFFERENT in
  the only way that matters: this door is where it is consumed anyway, so
  its answer exists here and can be checked for real. Arity alone is a
  weak contract for a 0-arity closure, since every 0-arity closure
  satisfies it.

  A STRUCT is refused specifically, and it is not a hypothetical shape:
  `Map.merge/2` accepts a struct as its second argument without a word, so
  `{:ok, some_struct}` used to merge, inject `__struct__` into the opts and
  refresh NOTHING — a session left on stale credentials, silently, which is
  the very failure the closure exists to prevent. The producer body has
  `fresh_cred` in hand one line above its return, so returning it instead
  of the resolved plan is a one-word slip, not a laboratory case.

  What this does NOT check is that the returned map IS a valid
  `Grappa.Session.start_opts/0`. Expressing that in the typespec would
  make `start_opts/0` and `refresh_plan_check/0` mutually recursive; the
  runtime check stops at "a plain map", and `from_opts/2` then validates
  the merged result against the due set — which is the part that matters,
  since a fresh plan that drops a closure is caught there.
  """
  @spec refresh!(Grappa.Session.subject(), map()) :: {:ok, map()} | {:error, :not_found}
  def refresh!(subject, opts) when is_tuple(subject) and is_map(opts) do
    due = Map.take(required_injections(subject), [:refresh_plan])

    case due_faults(due, opts) do
      {[], []} ->
        refresh_result!(subject, opts.refresh_plan.())

      {missing, wrong_arity} ->
        raise DepsInjectionError,
          subject_tag: elem(subject, 0),
          missing: missing,
          alien: [],
          wrong_arity: wrong_arity
    end
  end

  defp refresh_result!(_, {:ok, plan}) when is_map(plan) and not is_struct(plan),
    do: {:ok, plan}

  defp refresh_result!(_, {:error, :not_found} = not_found), do: not_found

  defp refresh_result!(subject, other) do
    raise DepsInjectionError,
      subject_tag: elem(subject, 0),
      missing: [],
      alien: [],
      wrong_arity: [],
      bad_refresh: {:returned, other}
  end

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
