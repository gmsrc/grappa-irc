defmodule Grappa.Identd.Listener do
  @moduledoc """
  The TCP listener that answers RFC 1413 ident lookups (issue 227).

  The first inbound socket grappa has ever owned: `:gen_tcp.listen/2` had
  zero occurrences under `lib/` before this, because everything else the
  bouncer speaks it dials out to. That is why this module is deliberately
  small and deliberately paranoid.

  ## Port and privilege — the ruling, in code

  Disabled by default; `Grappa.Application` starts nothing unless the
  operator turns it on. The port is a setting whose default is a HIGH,
  unprivileged one. Nothing here hardcodes 113 and nothing here assumes
  it can bind it. Getting a query from 113 to the configured port is a
  deployment concern — a packet-filter redirect, or `CAP_NET_BIND_SERVICE`
  on Linux — documented in `docs/OPERATIONS.md`. The shipped
  `infra/packaging/grappa.service` runs `User=grappa` with
  `NoNewPrivileges=true` and no `AmbientCapabilities`: the release grants
  itself nothing.

  A redirect must preserve the DESTINATION address (the plain
  `rdr ... -> port N` / `REDIRECT --to-port N` forms do). The address the
  query lands on is half the lookup key, because it is the address the
  ircd saw us connect FROM.

  ## Acceptor pool, and why the pool IS the bound

  A fixed set of acceptor tasks blocks on `accept/1` against the one
  listen socket, and each serves the connection it accepted before
  looping. That makes the pool size the concurrency limit with no
  separate throttle to keep in step, and it keeps a hostile connection
  inside a `:temporary` task: a crash there is contained and respawned,
  where a crash in this GenServer would be a public listener able to
  restart-loop the root supervisor.

  ⚠️ It does NOT make the listener flood-proof, and nothing here does. A
  refusal is held for the full wait budget (see below), so an attacker
  who can reach the port can keep every acceptor parked and starve the
  ircds of answers — which costs the `~` this feature exists to remove,
  not anything worse. The mitigation is reachability: scope the redirect
  rule to the upstream networks rather than to `any`.

  ## Every refusal costs the same

  `Grappa.Identd.Bindings` already parks a missing lookup for the wait
  budget, and `refuse/4` tops up anything faster to the same figure. So a
  tuple that exists but belongs to somebody else, a tuple that does not
  exist, and a query too malformed to name one all take the same wall
  clock as well as carrying the same bytes. Answering a wrong querier
  quickly and an unknown tuple slowly would re-open by the clock exactly
  what the identical bytes closed.

  The one fast path is the genuine hit for the genuine peer.

  ## Address families

  A `bind` of `::` opens a dual-stack socket (`ipv6_v6only: false`), and
  an IPv4 querier then appears as a v4-mapped address. `unmap_v4/1` folds
  those onto the v4 tuple a v4 outbound socket registered, so the two
  spellings meet on one key. An operator on a host that cannot do
  dual-stack sets `bind` to `0.0.0.0` instead; a failed bind stops this
  process with the real posix reason rather than degrading to a listener
  that is up and deaf.
  """

  use GenServer

  import Bitwise

  alias Grappa.Identd
  alias Grappa.Identd.Protocol
  alias Grappa.Net.IpLiteral

  require Logger

  @acceptor_supervisor Grappa.Identd.Acceptors

  # One acceptor per concurrent query. Legitimate load is one query per
  # upstream connect, i.e. a handful per boot; the figure is sized for the
  # refusal case, where each acceptor is held for the wait budget.
  @acceptors 32

  # A crashing acceptor respawns, but not instantly: a deterministic crash
  # would otherwise spin this GenServer at full speed.
  @acceptor_respawn_ms 250

  # The ircd sends its query immediately after connecting. This is the
  # budget for a peer that connects and then says nothing.
  @recv_timeout_ms 5_000

  # A well-formed query is under twenty bytes. `packet_size` makes an
  # unterminated flood an `:emsgsize` on the first recv instead of memory.
  @max_query_bytes 64

  # How long a lookup waits for a binding that has not landed yet. Bounded
  # well under the ident timeouts ircds actually use (solanum's
  # `ident_timeout` defaults to 5s), and enormous next to the real race,
  # which is the scheduling gap between `connect/4` returning and the
  # binding being cast — sub-millisecond.
  @default_wait_ms 2_000

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc """
  The port this listener actually bound. Worth asking for when the
  configured port was `0`.
  """
  @spec port(GenServer.server()) :: :inet.port_number()
  def port(server), do: GenServer.call(server, :port)

  @doc """
  Folds a v4-mapped IPv6 address (`::ffff:a.b.c.d`) onto its IPv4 tuple;
  passes every other address through.

  Public because it is the one piece of the dual-stack bind that a test
  can reach without an IPv6-capable host.
  """
  @spec unmap_v4(:inet.ip_address()) :: :inet.ip_address()
  def unmap_v4({0, 0, 0, 0, 0, 0xFFFF, high, low}),
    do: {high >>> 8, high &&& 0xFF, low >>> 8, low &&& 0xFF}

  def unmap_v4(address), do: address

  @impl GenServer
  def init(opts) do
    bind = Keyword.fetch!(opts, :bind)
    configured_port = Keyword.fetch!(opts, :port)
    wait_ms = Keyword.get(opts, :wait_ms, @default_wait_ms)

    with {:ok, address} <- parse_bind(bind),
         {:ok, socket} <- listen(address, configured_port),
         {:ok, bound_port} <- :inet.port(socket) do
      Logger.info(
        "identd listening on #{bind} port #{bound_port} " <>
          "(#{@acceptors} acceptors, #{wait_ms}ms wait budget)"
      )

      {:ok, %{socket: socket, wait_ms: wait_ms, port: bound_port}, {:continue, :spawn_acceptors}}
    else
      {:error, reason} -> {:stop, {:identd_listen_failed, bind, configured_port, reason}}
    end
  end

  @impl GenServer
  def handle_continue(:spawn_acceptors, state) do
    Enum.each(1..@acceptors, fn _ -> spawn_acceptor(state) end)
    {:noreply, state}
  end

  @impl GenServer
  def handle_call(:port, _, state), do: {:reply, state.port, state}

  @impl GenServer
  def handle_info(:spawn_acceptor, state) do
    spawn_acceptor(state)
    {:noreply, state}
  end

  # One replacement per death keeps the pool size invariant without
  # tracking who is alive.
  def handle_info({:DOWN, _, :process, _, reason}, state) do
    if reason not in [:normal, :shutdown] do
      Logger.warning("identd acceptor died — respawning", error: inspect(reason))
    end

    Process.send_after(self(), :spawn_acceptor, @acceptor_respawn_ms)
    {:noreply, state}
  end

  defp spawn_acceptor(state) do
    case Task.Supervisor.start_child(@acceptor_supervisor, fn ->
           accept_loop(state.socket, state.wait_ms)
         end) do
      {:ok, pid} ->
        Process.monitor(pid)
        :ok

      {:error, reason} ->
        Logger.error("identd: could not start an acceptor", error: inspect(reason))
        :ok
    end
  end

  defp accept_loop(socket, wait_ms) do
    case :gen_tcp.accept(socket) do
      {:ok, connection} ->
        serve(connection, wait_ms)
        accept_loop(socket, wait_ms)

      # The listener is going down and took its socket with it.
      {:error, :closed} ->
        :ok

      {:error, reason} ->
        Logger.warning("identd: accept failed", error: inspect(reason))
        :ok
    end
  end

  defp serve(connection, wait_ms) do
    started = System.monotonic_time(:millisecond)

    case :gen_tcp.recv(connection, 0, @recv_timeout_ms) do
      {:ok, line} -> _ = :gen_tcp.send(connection, answer(connection, line, wait_ms, started))
      {:error, _} -> :ok
    end

    # Half-close before closing, so the reply is on its way out before the
    # socket goes.
    _ = :gen_tcp.shutdown(connection, :write)
    :gen_tcp.close(connection)
  end

  defp answer(connection, line, wait_ms, started) do
    case Protocol.parse_query(line) do
      {:ok, {local_port, peer_port}} ->
        resolve(connection, local_port, peer_port, wait_ms, started)

      # Nothing to echo: `0` is not a legal port, so the reply can never
      # be read as an answer about a real connection.
      :error ->
        refuse(0, 0, wait_ms, started)
    end
  end

  defp resolve(connection, local_port, peer_port, wait_ms, started) do
    with {:ok, {local_address, _}} <- :inet.sockname(connection),
         {:ok, {querier_address, _}} <- :inet.peername(connection) do
      key = {unmap_v4(local_address), local_port, unmap_v4(querier_address), peer_port}

      case Identd.lookup(key, wait_ms) do
        {:ok, user_id} -> Protocol.userid_reply(local_port, peer_port, user_id)
        :none -> refuse(local_port, peer_port, wait_ms, started)
      end
    else
      {:error, _} -> refuse(local_port, peer_port, wait_ms, started)
    end
  end

  defp refuse(local_port, peer_port, wait_ms, started) do
    elapsed = System.monotonic_time(:millisecond) - started

    if elapsed < wait_ms do
      Process.sleep(wait_ms - elapsed)
    end

    Protocol.error_reply(local_port, peer_port)
  end

  defp parse_bind(bind) do
    case IpLiteral.to_tuple(bind) do
      {:ok, address} -> {:ok, address}
      :error -> {:error, :invalid_bind_address}
    end
  end

  defp listen({_, _, _, _} = address, port),
    do: :gen_tcp.listen(port, [:inet, {:ip, address} | base_options()])

  defp listen({_, _, _, _, _, _, _, _} = address, port),
    do: :gen_tcp.listen(port, [:inet6, {:ip, address}, {:ipv6_v6only, false} | base_options()])

  defp base_options do
    [
      :binary,
      packet: :line,
      packet_size: @max_query_bytes,
      active: false,
      reuseaddr: true,
      backlog: 128
    ]
  end
end
