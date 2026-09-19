defmodule GrappaWeb.SessionController do
  @moduledoc """
  Multi-network ACCRETION surface (#211 phase 4c + phase 6, #481).

    * `POST /session/networks` — attach an ADDITIONAL `visitor_enabled`
      network to the authenticated subject + spawn its upstream session.
      For a visitor the identity stays ONE `%Visitor{}` spanning both
      networks; for a user it binds an additional user credential.
    * `DELETE /session/networks/:slug` — issue 2219, the inverse that was
      missing: DETACH the network from the caller's own session. Parks +
      quits it, then marks the credential detached. Everything the
      subject authored survives, and re-POSTing the same slug brings it
      all back.

  ## issue 2219 — why the two verbs sit in different scopes

  The POST rides `[:api, :authn, :request_budget]`; the DELETE rides
  `:full_session` as well. That asymmetry is deliberate and the router
  comment at the `:full_session` block states the rule it follows —
  everything there can change what the account IS. Accreting a network
  adds a binding a per-client token may then use; detaching one takes a
  binding away from every client the account has, which is credential
  management.

  ## issue 2219 — the DELETE is refused to visitors, on purpose

  A visitor's identity LIVES on its credentials: `representative_visitor_
  credential/1` is where the nick comes from and `visitor_registered?/1`
  derives permanence from the per-network secret. Detaching a visitor's
  only network would therefore hide the identity rather than a binding,
  which is `DELETE /me`'s job and not this verb's. The 80% that fits is
  the park-and-mark mechanism; the 20% that does not is whose identity
  the row anchors, and that is the domain boundary. A visitor gets 403
  until someone rules otherwise.

  ## #211 phase 6 — the disconnect ⇄ reconnect pair is RETIRED

  The `#126` `POST /session/{disconnect,reconnect}` verbs are GONE.
  Visitors now carry a real per-network `connection_state` (ruling D),
  so they park/reconnect each network through the SAME
  `PATCH /networks/:network_id {connection_state}` users do — visitors
  are equal to users on the connection-state surface. A global
  disconnect-all is composed client-side (park each attached network),
  mirroring the user `quit.ts` quit-all. The singular
  `resolve_network_id/1` scalar reader died with the retired verbs.

  ## #481 — both subjects accrete (was visitor-only)

  `POST /session/networks` accepts ANY authenticated subject. The
  visitor-only premise was a #461 relic: the gate that mattered is the
  `visitor_enabled` allowlist — the OPERATOR-APPROVED self-serve tier, a
  property of the NETWORK, not visitor identity — so the same bound admits
  users. (`visitor_enabled` is now a misnomer; rename is
  schema+wire-touching and deferred — see DESIGN_NOTES 2026-07-27.)

  The union is narrowed at THIS door:

    * visitor → `Visitors.accrete_network/3` (unchanged — the visitor
      context spawns its own upstream; bounded by the allowlist + #171
      per-IP cap);
    * user → `add_user_network/3` here, which binds a USER credential then
      spawns via `GrappaWeb.NetworkSpawn` on the SAME user connect capacity
      path (`:patch_network_connect` flow → per-IP + network-total caps).
      Users are NOT routed through the visitor-typed `accrete_network/3`
      (shared data model with a type flag = boundary violation); they reuse
      the shared spawn VERB, not the visitor NOUN.

  Any success is 204; a missing/blank `network` param is 400; accretion /
  admission / spawn error atoms flow through `FallbackController` (403
  network_not_visitor_enabled, 409 already_attached, 503 cap/circuit, 502
  upstream, etc.). The cic home-page "connect available network" affordance
  drives this for both subjects.
  """
  use GrappaWeb, :controller

  alias Grappa.Accounts.User
  alias Grappa.IRC.Identifier
  alias Grappa.{Networks, Visitors}
  alias Grappa.Networks.{Credential, Credentials, Network, SessionPlan}
  alias Grappa.Visitors.Visitor
  alias GrappaWeb.NetworkSpawn

  require Logger

  # issue 2219 — the QUIT text the upstream sees when a detach parks a
  # live network. Says what happened rather than naming the product verb:
  # the channel reads this line, not the operator.
  @detach_quit_reason "detaching network"

  # issue 2219 — the QUIT text for the revive rollback. Distinct from the
  # deliberate detach above so an upstream log says which of the two put
  # the session down.
  @revive_failed_quit_reason "reconnect failed, network detached"

  @doc """
  `POST /session/networks` — attach + spawn an available `visitor_enabled`
  network for the authenticated subject. Body: `{"network": "<slug>"}`.

  Narrows the subject union at the door; see the moduledoc for the
  visitor-vs-user split. 204 on success; 400 on a missing/blank param;
  403 for a non-subject shape (authn should make this unreachable).
  """
  @spec add_network(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :forbidden | :bad_request | :network_not_visitor_enabled | term()}
  def add_network(conn, %{"network" => slug}) when is_binary(slug) and slug != "" do
    dispatch_accretion(conn, slug)
  end

  def add_network(_, _), do: {:error, :bad_request}

  @doc """
  `DELETE /session/networks/:slug` — issue 2219: detach the network from
  the caller's OWN session. 204 on success.

  404 for a slug that does not exist AND for one the caller does not
  hold attached — one answer for both, the same no-oracle posture
  `Plugs.ResolveNetwork` takes on the iso boundary, so the route cannot
  be used to enumerate which networks a deployment carries. 403 for a
  visitor (see the moduledoc).

  Detaching an already-detached network is the 404 arm, not a success:
  the caller named a network that is not one of theirs, and that is the
  same sentence for every reason it might not be.
  """
  @spec detach_network(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :forbidden | :bad_request | :not_found}
  def detach_network(conn, %{"slug" => slug}) when is_binary(slug) and slug != "" do
    dispatch_detach(conn, slug)
  end

  def detach_network(_, _), do: {:error, :bad_request}

  # Subject-union narrow, mirroring `dispatch_accretion/2` above. The
  # visitor clause is an explicit refusal rather than a missing clause,
  # so the boundary is readable at the door instead of inferred from a
  # FunctionClauseError.
  @spec dispatch_detach(Plug.Conn.t(), String.t()) :: Plug.Conn.t() | {:error, term()}
  defp dispatch_detach(%{assigns: %{current_subject: {:user, %User{} = user}}} = conn, slug) do
    with {:ok, network} <- Networks.get_network_by_slug(slug),
         {:ok, credential} <- Credentials.get_attached_credential(user, network),
         {:ok, _} <- Networks.detach(credential, @detach_quit_reason) do
      send_resp(conn, :no_content, "")
    end
  end

  defp dispatch_detach(%{assigns: %{current_subject: {:visitor, %Visitor{}}}}, _),
    do: {:error, :forbidden}

  defp dispatch_detach(_, _), do: {:error, :forbidden}

  # ---------------------------------------------------------------------------
  # Subject-union narrow (#481) — one door, two credential paths. Matches on
  # the `:authn`-assigned subject (mirrors the retired `require_visitor/1`
  # conn-shape match); the final clause 403s any non-subject shape (authn
  # should make it unreachable, but a defensive 403 beats a 500).
  # ---------------------------------------------------------------------------

  @spec dispatch_accretion(Plug.Conn.t(), String.t()) :: Plug.Conn.t() | {:error, term()}
  defp dispatch_accretion(
         %{assigns: %{current_subject: {:visitor, %Visitor{} = visitor}}} = conn,
         slug
       ) do
    with {:ok, _} <- Visitors.accrete_network(visitor, slug, GrappaWeb.RemoteIP.format(conn)) do
      send_resp(conn, :no_content, "")
    end
  end

  defp dispatch_accretion(
         %{assigns: %{current_subject: {:user, %User{} = user}}} = conn,
         slug
       ) do
    with {:ok, _} <- add_user_network(conn, user, slug) do
      send_resp(conn, :no_content, "")
    end
  end

  defp dispatch_accretion(_, _), do: {:error, :forbidden}

  # ---------------------------------------------------------------------------
  # User accretion (#481) — the user twin of `Visitors.accrete_network/3`.
  # Web-layer orchestration because `Grappa.Networks` must NOT dep
  # `SpawnOrchestrator` (Boundary cycle); this mirrors the user PATCH-connect
  # path that already orchestrates a user spawn from the controller.
  # ---------------------------------------------------------------------------

  @spec add_user_network(Plug.Conn.t(), User.t(), String.t()) ::
          {:ok, pid()}
          | {:error,
             :network_not_visitor_enabled
             | :network_unconfigured
             | :already_attached
             | :resolve_failed
             | term()}
  defp add_user_network(conn, %User{} = user, slug) do
    case fetch_detached_credential(user, slug) do
      {:ok, credential} -> revive_user_network(conn, user, credential)
      {:error, :not_detached} -> accrete_user_network(conn, user, slug)
    end
  end

  # issue 2219 — REVIVE takes priority over accrete, and it runs BEFORE
  # the `visitor_enabled` gate rather than after it.
  #
  # That ordering is the whole promise of the detach. The allowlist asks
  # "may a stranger attach this network"; a detached credential is
  # standing proof that this subject already held it, however it was
  # bound. Running the gate first would make an admin-bound network
  # hideable and never restorable — a delete wearing a hide's label —
  # and it grants nothing: the row cannot name a network the subject was
  # not given, so the worst a revive can reach is exactly what it lost.
  @spec fetch_detached_credential(User.t(), String.t()) ::
          {:ok, Credential.t()} | {:error, :not_detached}
  defp fetch_detached_credential(%User{} = user, slug) do
    with {:ok, network} <- Networks.get_network_by_slug(slug),
         {:ok, %Credential{detached_at: %DateTime{}} = credential} <-
           Credentials.get_credential(user, network) do
      {:ok, credential}
    else
      _ -> {:error, :not_detached}
    end
  end

  # The revive twin of `spawn_or_rollback/4`, and it must NOT be that
  # function. Its rollback is `unbind_credential_resilient/2`, a DELETE:
  # firing it here would destroy the nick, secrets, perform list and
  # autojoin the subject detached precisely in order to keep, turning a
  # refused spawn into the data loss the reversible verb exists to avoid.
  #
  # The rollback that belongs here is the detach itself. `Networks.
  # detach/2` parks whatever came up, stops the session and re-marks the
  # row, so a failed revive lands exactly where it started — which is
  # also why it is safe to run unconditionally on the error arm.
  @spec revive_user_network(Plug.Conn.t(), User.t(), Credential.t()) ::
          {:ok, pid()} | {:error, term()}
  defp revive_user_network(conn, %User{} = user, %Credential{} = credential) do
    with {:ok, revived} <- Networks.reattach(credential) do
      case spawn_revived(conn, user, revived) do
        {:ok, pid} ->
          {:ok, pid}

        {:error, _} = err ->
          _ = Networks.detach(revived, @revive_failed_quit_reason)
          err
      end
    end
  end

  @spec spawn_revived(Plug.Conn.t(), User.t(), Credential.t()) ::
          {:ok, pid()} | {:error, term()}
  defp spawn_revived(conn, %User{} = user, %Credential{} = credential) do
    with {:ok, plan} <- resolve_user_plan(user, credential),
         {:ok, pid} <- NetworkSpawn.orchestrate(conn, {:user, user}, credential, plan),
         {:ok, _} <- Networks.connect(credential) do
      {:ok, pid}
    end
  end

  @spec accrete_user_network(Plug.Conn.t(), User.t(), String.t()) ::
          {:ok, pid()} | {:error, term()}
  defp accrete_user_network(conn, %User{} = user, slug) do
    with {:ok, network} <- Networks.fetch_accretable_network(slug),
         :ok <- ensure_user_not_attached(user, network),
         {:ok, credential} <- bind_user_credential(user, network) do
      spawn_or_rollback(conn, user, network, credential)
    end
  end

  # Accretion is ATOMIC (#642 defect 2): the accreted credential is bound
  # `:parked` (never `:connected`) and only transitions to `:connected` AFTER
  # the upstream session is live via `Networks.connect/1`. This is the exact
  # invariant the PATCH /connect U-0 fix (`NetworksController.apply_transition/5`)
  # upholds: no observer ever sees `:connected` without a live `Session.Server`.
  #
  # Binding `:parked` is load-bearing, not cosmetic. The tempting shape — bind
  # `:connected` (schema default) then DELETE on failure — is a trap: that
  # delete (`Credentials.unbind_credential/2` → a NAKED `Repo.delete_all`, no
  # `Repo.BusyRetry`) can itself RAISE under WAL + `pool_size > 1`, and the
  # rollback fires PRECISELY on admission refusal — i.e. under exactly the load
  # where SQLite write contention is likeliest. A raised rollback would leave
  # the row `:connected` with no session: the very wedge this closes (UI shows
  # CONNECTED with a climbing uptime, `POST /messages` 404s, reconnect 409s
  # `already_attached`, escapable only by Disconnect+Reconnect). Binding
  # `:parked` makes that impossible BY CONSTRUCTION — a failed cleanup degrades
  # to `:parked` (a normal, user-recoverable state via PATCH /connect), never
  # to the `:connected`-with-no-session wedge.
  #
  # On ANY failure after the bind — plan resolution (`:resolve_failed`) OR
  # every rejection out of `NetworkSpawn.orchestrate` (`:ip_cap_exceeded` /
  # `:user_cap_exceeded`, the `{:network_circuit_open, _}` / `{:start_failed,
  # _}` tuples, the subject-row-gone `:not_found`) — the just-bound credential
  # is rolled back best-effort via `Credentials.unbind_credential_resilient/2`
  # so nothing stays attached and a later attempt starts clean without
  # Disconnect+Reconnect. That rollback rides out a transient DB fault and, on
  # sustained saturation, degrades to leaving the credential `:parked` rather
  # than masking the original refusal behind a 500 — the DB-fault resilience
  # lives in the context (where Repo access belongs), not in this web layer.
  @spec spawn_or_rollback(Plug.Conn.t(), User.t(), Network.t(), Credential.t()) ::
          {:ok, pid()} | {:error, term()}
  defp spawn_or_rollback(conn, %User{} = user, %Network{} = network, %Credential{} = credential) do
    with {:ok, plan} <- resolve_user_plan(user, credential),
         {:ok, pid} <- NetworkSpawn.orchestrate(conn, {:user, user}, credential, plan),
         {:ok, _} <- Networks.connect(credential) do
      {:ok, pid}
    else
      {:error, _} = err ->
        # Best-effort: surface the ORIGINAL refusal on a transient rollback
        # fault (it degrades to :db_unavailable, discarded here, leaving the
        # credential safely :parked); a non-transient corruption fault still
        # raises loudly out of unbind_credential_resilient/2 (BusyRetry contract).
        _ = Credentials.unbind_credential_resilient(user, network)
        err
    end
  end

  # Idempotency guard: a second accrete of a network the user already holds
  # is a clean 409, not a silent re-bind/re-spawn.
  @spec ensure_user_not_attached(User.t(), Network.t()) :: :ok | {:error, :already_attached}
  defp ensure_user_not_attached(%User{} = user, %Network{} = network) do
    case Credentials.get_credential(user, network) do
      {:error, :not_found} -> :ok
      {:ok, %Credential{}} -> {:error, :already_attached}
    end
  end

  # Bind the accreted USER credential ANON (`auth_method: :none`) + `:parked` —
  # a self-serve network the user has not yet identified on; per-network
  # identity is editable afterwards (#476). Binding `:parked` (NOT the schema
  # default `:connected`) is the #642 defect-2 invariant: the row transitions
  # to `:connected` only after `spawn_or_rollback/4` confirms a live session,
  # so a refused spawn can never strand a `:connected`-with-no-session
  # credential (see `spawn_or_rollback/4`). Seed the identity from a
  # representative existing user credential for continuity, falling back to the
  # account name when the user holds none yet.
  @spec bind_user_credential(User.t(), Network.t()) ::
          {:ok, Credential.t()} | {:error, Ecto.Changeset.t()}
  defp bind_user_credential(%User{} = user, %Network{} = network) do
    {nick, ident, realname} = user_identity_seed(user)

    Credentials.bind_credential(user, network, %{
      nick: nick,
      ident: ident,
      realname: realname,
      sasl_user: nick,
      auth_method: :none,
      autojoin_channels: [],
      connection_state: :parked
    })
  end

  @spec user_identity_seed(User.t()) ::
          {String.t(), String.t() | nil, String.t() | nil}
  defp user_identity_seed(%User{name: name} = user) do
    case Credentials.representative_user_credential(user.id) do
      {:ok, %Credential{nick: nick, ident: ident, realname: realname}} ->
        {nick, ident, realname}

      # No prior credential — seed from the account name. `User.name` allows
      # up to 64 chars but an IRC nick caps at 30, and the name charset is a
      # strict subset of the nick charset, so a clamp (not a sanitise) yields
      # a valid nick; without it a long-named user dead-ends on validation.
      # Per-network identity is editable afterwards (#476).
      {:error, :not_found} ->
        {Identifier.truncate_nick(name), nil, nil}
    end
  end

  @spec resolve_user_plan(User.t(), Credential.t()) ::
          {:ok, Grappa.Session.start_opts()} | {:error, :resolve_failed}
  defp resolve_user_plan(%User{} = user, %Credential{} = credential) do
    case SessionPlan.resolve(credential) do
      {:ok, _} = ok ->
        ok

      {:error, reason} ->
        Logger.warning("accretion: user session plan resolve failed",
          user: user.id,
          error: inspect(reason)
        )

        {:error, :resolve_failed}
    end
  end
end
