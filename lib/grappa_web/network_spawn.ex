defmodule GrappaWeb.NetworkSpawn do
  @moduledoc """
  Web-layer spawn orchestration, shared by the two runtime surfaces that
  dial a subject's upstream once a credential + `SessionPlan` are ready:

    * `NetworksController` — `PATCH /networks/:network_id {connection_state:
      "connected"}` (park → connect), and
    * `SessionController` — `POST /session/networks` accretion. #481 opened
      this door to USER subjects (it was visitor-only via
      `Visitors.accrete_network/3`); the user branch binds a user credential
      then lands here for the identical admission + spawn.

  Lives at the WEB boundary, NOT in `Grappa.Networks`, because Networks must
  NOT depend on `Grappa.SpawnOrchestrator` — that closes the
  `Networks → Admission → Networks` Boundary cycle documented in
  `SpawnOrchestrator`. The web layer is the sanctioned place to compose a
  `Networks`/`Credentials` read with a `SpawnOrchestrator.spawn/4`.

  The capacity input (source IP via the canonical `RemoteIP.format/1`, the
  subject-keyed `flow` via `GrappaWeb.Subject.connect_flow/1`, and the
  `requesting_subject` self-exclusion) is single-sourced here so the connect
  and accretion doors cannot drift on the #171 per-IP / network-total caps.
  """

  require Logger

  alias Grappa.Networks.Credential
  alias Grappa.Session
  alias GrappaWeb.Subject

  @doc """
  Admit + spawn `subject`'s upstream for `credential`'s network from the
  computed `plan`. Returns `{:ok, pid}` (spawned OR idempotent
  already-started), or a typed `{:error, _}` the caller propagates via
  `FallbackController`:

    * `{:error, :not_found}` — the credential row was unbound between the
      admission check and the spawn (`Session.Server.init/1` returned
      `:ignore`); surfaced as the same 404 a missing credential gives.
    * the orchestrator's admission atom verbatim (`:too_many_sessions`,
      circuit/cap/upstream errors) so the existing T31 FallbackController
      clauses map the 503/502.
  """
  @spec orchestrate(Plug.Conn.t(), Subject.t(), Credential.t(), Session.start_opts()) ::
          {:ok, pid()} | {:error, term()}
  def orchestrate(conn, subject, %Credential{network_id: network_id}, plan) do
    session_subject = Subject.to_session(subject)

    capacity_input = %{
      network_id: network_id,
      # #171: raw conn here (no pre-formatted input.ip like login has), so
      # format through the canonical `RemoteIP.format/1` — the SAME formatter
      # user login stores in accounts_sessions.ip, or the per-IP count would
      # silently miss the stored rows.
      source_ip: GrappaWeb.RemoteIP.format(conn),
      flow: Subject.connect_flow(subject),
      # The requesting subject IS the subject the spawn is for. Self-exclusion
      # in the per-IP cap keeps the caller's own active browser
      # accounts_session from counting against them on this respawn/accrete.
      requesting_subject: session_subject
    }

    case Grappa.SpawnOrchestrator.spawn(session_subject, network_id, plan, capacity_input) do
      {:ok, :spawned, pid} ->
        {:ok, pid}

      {:ok, :already_started, pid} ->
        {:ok, pid}

      {:ok, :ignored} ->
        Logger.warning(
          "network spawn: subject row gone mid-spawn #{inspect(session_subject)}",
          network_id: network_id
        )

        {:error, :not_found}

      {:error, reason} = err ->
        Logger.warning(
          "network spawn: session spawn rejected #{inspect(session_subject)}",
          network_id: network_id,
          error: inspect(reason)
        )

        err
    end
  end
end
