defmodule GrappaWeb.SessionController do
  @moduledoc """
  Multi-network ACCRETION surface (#211 phase 4c + phase 6, #481).

    * `POST /session/networks` — attach an ADDITIONAL `visitor_enabled`
      network to the authenticated subject + spawn its upstream session.
      For a visitor the identity stays ONE `%Visitor{}` spanning both
      networks; for a user it binds an additional user credential.

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
    with {:ok, network} <- Networks.fetch_accretable_network(slug),
         :ok <- ensure_user_not_attached(user, network),
         {:ok, credential} <- bind_user_credential(user, network),
         {:ok, plan} <- resolve_user_plan(user, credential) do
      NetworkSpawn.orchestrate(conn, {:user, user}, credential, plan)
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

  # Bind the accreted USER credential ANON (`auth_method: :none`) — a
  # self-serve network the user has not yet identified on; per-network
  # identity is editable afterwards (#476). Seed the identity from a
  # representative existing user credential for continuity, falling back to
  # the account name when the user holds none yet.
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
      autojoin_channels: []
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
