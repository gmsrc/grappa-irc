defmodule Grappa.Identd.Bindings do
  @moduledoc """
  The `{source_ip, local_port, peer_ip, peer_port} → ident` table the
  identd answers from (issue 227).

  ## Why the key is the whole 4-tuple

  Before this, grappa tracked no part of an outbound socket's LOCAL
  address: `:inet.sockname/1` appeared nowhere under `lib/`. It has to
  now, and it has to be the whole tuple rather than the port pair,
  because grappa's source addresses are plural and per-network —
  `Grappa.IRC.Client` binds a fixed `ifaddr` when the network has one and
  otherwise rolls an entry from the v6 pool, so two sessions can hold the
  same ephemeral port on two different addresses.

  ## The peer is IN the key, which is the whole anti-enumeration story

  A lookup is built from the querier's own address, so answering somebody
  other than the peer is not a check that could be forgotten — it is an
  unrepresentable state. Any query from a host that is not the far end of
  the connection it asks about simply misses, and a miss is the one
  uniform refusal. Had this been a `peer_ip == querier` comparison
  AFTER the lookup, the comparison would have been a branch, and a branch
  is a thing a later reader can "simplify".

  ## A miss WAITS

  The ircd starts its ident lookup when it ACCEPTS — the same instant
  `:gen_tcp.connect/4` returns on our side — so a query can arrive before
  the binding is written, and answering `NO-USER` cold is exactly the
  failure that leaves the `~` in place. `lookup/2` therefore parks the
  caller for up to its budget and is woken by the registration when it
  lands.

  The alternative shape (bind an explicit local `port:` BEFORE connecting,
  so the tuple is known up front) was rejected on three measured grounds:
  the kernel-default source path has no `ifaddr` at all, so the source
  ADDRESS half of the key is still unknown before connect; leaf rotation
  (#271) means the peer address is not fixed before connect either, so a
  pre-registered tuple can name a leaf that then fails; and claiming an
  explicit local port makes every upstream connect race the kernel's
  ephemeral allocator for the benefit of a subsystem that is off by
  default. `:inet.sockname/1` after the connect is exact, is all four
  elements at once, and costs the identd a bounded wait it only ever pays
  on a miss.

  ## Lifetime

  A binding is monitored on the process that registered it — the
  `Grappa.IRC.Client` that owns the socket — so it disappears when the
  connection does, with no teardown call to forget. A crash of THIS
  process loses every binding: live sessions then answer `NO-USER` until
  they reconnect. That is a degradation and not a correctness problem
  (`~` is the pre-227 baseline), and re-deriving the table would mean
  reaching into every Client's socket from outside it.
  """

  use GenServer

  alias Grappa.Identd.Protocol

  require Logger

  # Headroom on top of the caller's own wait budget, so the budget is
  # what expires rather than the call. The server always replies at its
  # deadline; this only covers scheduling.
  @call_slack_ms 5_000

  defstruct bindings: %{}, monitors: %{}, waiters: %{}

  @typep state :: %__MODULE__{
           bindings: %{Grappa.Identd.binding_key() => {String.t(), reference()}},
           monitors: %{reference() => Grappa.Identd.binding_key()},
           waiters: %{Grappa.Identd.binding_key() => [GenServer.from()]}
         }

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc """
  Binds `key` to `ident` for as long as the CALLING process lives.

  A cast, deliberately. This runs on `Grappa.IRC.Client`'s connect path,
  and an upstream IRC connection must neither block on nor die with an
  optional subsystem: a `GenServer.call/3` would exit the Client if this
  process were wedged, and identd is not worth an IRC session. The same
  property gives the feature its off switch for free — with identd
  disabled this process does not exist, `GenServer.cast/2` to an
  unregistered name is a no-op, and no caller needs to know.

  An `ident` that would break the reply framing is refused HERE rather
  than by the caller, and logged: the wire it would corrupt belongs to
  this module.
  """
  @spec register(Grappa.Identd.binding_key(), String.t()) :: :ok
  def register(key, ident), do: GenServer.cast(__MODULE__, {:register, key, ident, self()})

  @doc """
  Resolves `key`, waiting up to `wait_ms` for a registration that has not
  landed yet. `wait_ms` of `0` answers from the table as it stands.

  Raises if this process is not running — the only production caller is
  the listener, which cannot exist without it.
  """
  @spec lookup(Grappa.Identd.binding_key(), non_neg_integer()) :: {:ok, String.t()} | :none
  def lookup(key, wait_ms) when is_integer(wait_ms) and wait_ms >= 0 do
    GenServer.call(__MODULE__, {:lookup, key, wait_ms}, wait_ms + @call_slack_ms)
  end

  @impl GenServer
  @spec init(keyword()) :: {:ok, state()}
  def init(_), do: {:ok, %__MODULE__{}}

  @impl GenServer
  def handle_cast({:register, key, ident, owner}, state) do
    if Protocol.safe_userid?(ident) do
      {:noreply, bind(state, key, ident, owner)}
    else
      Logger.error(
        "identd: refusing to bind an ident that would break the reply framing — " <>
          "the session keeps its upstream connection and simply gets no ident answer " <>
          "(ident=#{inspect(ident)})"
      )

      {:noreply, state}
    end
  end

  @impl GenServer
  def handle_call({:lookup, key, wait_ms}, from, state) do
    case Map.fetch(state.bindings, key) do
      {:ok, {ident, _}} ->
        {:reply, {:ok, ident}, state}

      :error when wait_ms == 0 ->
        {:reply, :none, state}

      :error ->
        Process.send_after(self(), {:waiter_expired, key, from}, wait_ms)
        {:noreply, %{state | waiters: Map.update(state.waiters, key, [from], &[from | &1])}}
    end
  end

  @impl GenServer
  def handle_info({:waiter_expired, key, from}, state) do
    parked = Map.get(state.waiters, key, [])

    if from in parked do
      GenServer.reply(from, :none)
    end

    {:noreply, %{state | waiters: drop_waiter(state.waiters, key, from)}}
  end

  # The owning Client is gone, so the socket is too. No teardown call to
  # forget and none to get wrong.
  def handle_info({:DOWN, ref, :process, _, _}, state) do
    case Map.pop(state.monitors, ref) do
      {nil, _} ->
        {:noreply, state}

      {key, monitors} ->
        {:noreply, %{state | monitors: monitors, bindings: Map.delete(state.bindings, key)}}
    end
  end

  @spec bind(state(), Grappa.Identd.binding_key(), String.t(), pid()) :: state()
  defp bind(state, key, ident, owner) do
    state = forget(state, key)
    ref = Process.monitor(owner)

    bound = %{
      state
      | bindings: Map.put(state.bindings, key, {ident, ref}),
        monitors: Map.put(state.monitors, ref, key)
    }

    wake(bound, key, ident)
  end

  # Replacing a key drops its previous monitor with `:flush`, so the old
  # owner's DOWN can never arrive later and delete the NEW binding.
  @spec forget(state(), Grappa.Identd.binding_key()) :: state()
  defp forget(state, key) do
    case Map.pop(state.bindings, key) do
      {nil, _} ->
        state

      {{_, ref}, bindings} ->
        Process.demonitor(ref, [:flush])
        %{state | bindings: bindings, monitors: Map.delete(state.monitors, ref)}
    end
  end

  @spec wake(state(), Grappa.Identd.binding_key(), String.t()) :: state()
  defp wake(state, key, ident) do
    {parked, waiters} = Map.pop(state.waiters, key, [])
    Enum.each(parked, &GenServer.reply(&1, {:ok, ident}))
    %{state | waiters: waiters}
  end

  @spec drop_waiter(map(), Grappa.Identd.binding_key(), GenServer.from()) :: map()
  defp drop_waiter(waiters, key, from) do
    case List.delete(Map.get(waiters, key, []), from) do
      [] -> Map.delete(waiters, key)
      rest -> Map.put(waiters, key, rest)
    end
  end
end
