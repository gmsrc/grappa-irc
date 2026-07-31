defmodule Grappa.Net.SourceAliasManager do
  @moduledoc """
  Ref-counted lifecycle owner for derived outbound source aliases (#543
  `static_mapping_with_reservations`, mode 2).

  Many `(user, network)` sessions can share ONE derived `::cb` address (a
  NAT/CGNAT collapses many clients behind one `/64` to a single derived
  source). Binding it per-session and unbinding on every disconnect would
  churn `ifconfig`; binding it once and never removing it would leak. So this
  GenServer keeps a per-address ref-count: `acquire/1` binds on the 0→1
  transition, `release/1` unbinds on 1→0.

  ## Arm gate

  At init (once the Repo is up so `ServerSettings.static_mapping_prefix/0` is
  readable) it runs the platform adapter's `arm_check/1` against the configured
  prefix and publishes `armed?` to `:persistent_term`. The session plan folds
  `armed?/0` into the addressing config; a disarmed mode 2 is HELD
  (`{:hold, :mode2_disarmed}`) rather than egressing from a shared
  kernel-default source (Global Constraint: refuse to arm). `armed?/0` /
  `disarm_reason/0` are lock-free reads — no GenServer round-trip on the
  connect path.

  ## Boot reconcile

  `reconcile/0` diffs the OS ground truth (`adapter.list_aliases/1`) against
  the set of addresses that SHOULD remain bound (`held_addresses/1`) and
  releases the orphans a crashed prior run left bound. It runs once at startup
  via `handle_continue/2` — the child is ordered AFTER the Endpoint (so the
  public surface is up first) and BEFORE Bootstrap (so the sweep clears stale
  aliases before sessions re-acquire).

  ## Boundary

  Sibling boundary to `Grappa.Net.SourceAlias` (the pure adapter subsystem):
  this deps that + `Grappa.ServerSettings` (the DB prefix it arms against).
  The lifecycle state (ref-counts) is small and per-node, so it lives in the
  GenServer state map — every acquire/release/reconcile is serialized through
  the mailbox, so no ETS/cross-process read is needed.
  """

  use GenServer

  use Boundary,
    top_level?: true,
    deps: [Grappa.Net.SourceAlias, Grappa.ServerSettings]

  alias Grappa.Net.SourceAlias.Config
  alias Grappa.ServerSettings

  require Logger

  @arm_key {__MODULE__, :arm}

  @type state :: %{
          refcounts: %{optional(String.t()) => pos_integer()},
          prefix: String.t() | nil,
          adapter: module()
        }

  # -- API --------------------------------------------------------------------

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    {name, opts} = Keyword.pop(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Ensure `addr` is bound (ref-count 0→1 binds via the adapter). Returns the
  adapter error WITHOUT incrementing when the bind fails — a failed bind must
  not leave a phantom ref-count that would later "release" an alias that was
  never created.
  """
  @spec acquire(String.t()) :: :ok | {:error, term()}
  def acquire(addr) when is_binary(addr), do: GenServer.call(__MODULE__, {:acquire, addr})

  @doc """
  Drop a reference to `addr` (ref-count 1→0 unbinds via the adapter). A
  best-effort operation: a release of an unheld address is a no-op `:ok`, and
  an adapter failure on the 1→0 unbind is LOGGED but still returns `:ok` (the
  boot reconcile is the backstop that reclaims a stuck alias).
  """
  @spec release(String.t()) :: :ok
  def release(addr) when is_binary(addr), do: GenServer.call(__MODULE__, {:release, addr})

  @doc """
  Release the alias orphans — bound at the OS layer but not in the held set.
  See the moduledoc + `held_addresses/1`.
  """
  @spec reconcile() :: :ok
  def reconcile, do: GenServer.call(__MODULE__, :reconcile)

  @doc """
  True when the platform adapter armed mode 2 at boot. Lock-free read
  (`:persistent_term`); defaults to `false` (disarmed) before the manager
  boots, so a mode-2 subject is safely HELD rather than egressing wrong.
  """
  @spec armed?() :: boolean()
  def armed?, do: elem(arm_state(), 0)

  @doc "The reason mode 2 is disarmed (nil when armed). Lock-free read."
  @spec disarm_reason() :: atom() | nil
  def disarm_reason, do: elem(arm_state(), 1)

  defp arm_state, do: :persistent_term.get(@arm_key, {false, :not_armed})

  # -- GenServer --------------------------------------------------------------

  @impl GenServer
  def init(opts) do
    adapter = Keyword.get_lazy(opts, :adapter, &Config.adapter/0)
    prefix = Keyword.get_lazy(opts, :prefix, &ServerSettings.static_mapping_prefix/0)

    publish_arm(compute_arm(adapter, prefix))

    {:ok, %{refcounts: %{}, prefix: prefix, adapter: adapter}, {:continue, :reconcile}}
  end

  @impl GenServer
  def handle_continue(:reconcile, state) do
    {:noreply, do_reconcile(state)}
  end

  @impl GenServer
  def handle_call({:acquire, addr}, _, state) do
    case Map.get(state.refcounts, addr, 0) do
      0 ->
        case state.adapter.ensure_source(addr, state.prefix) do
          :ok ->
            {:reply, :ok, put_in(state.refcounts[addr], 1)}

          {:error, _} = err ->
            {:reply, err, state}
        end

      n ->
        {:reply, :ok, put_in(state.refcounts[addr], n + 1)}
    end
  end

  @impl GenServer
  def handle_call({:release, addr}, _, state) do
    case Map.get(state.refcounts, addr, 0) do
      0 ->
        Logger.warning("source-alias release of unheld address #{inspect(addr)} — ignoring")
        {:reply, :ok, state}

      1 ->
        _ = unbind(state, addr)
        {:reply, :ok, %{state | refcounts: Map.delete(state.refcounts, addr)}}

      n ->
        {:reply, :ok, put_in(state.refcounts[addr], n - 1)}
    end
  end

  @impl GenServer
  def handle_call(:reconcile, _, state) do
    {:reply, :ok, do_reconcile(state)}
  end

  # -- internals --------------------------------------------------------------

  # The set of addresses that SHOULD remain bound. In INC-5 this is EXACTLY the
  # manager's own ref-count table: every acquire/release flows through it, so
  # its keys ARE the live-held set on this node, and iterating live
  # Session.Server states would only duplicate state the manager already owns
  # (CLAUDE.md design-discipline: derive, don't duplicate).
  #
  # ⚠️ INC-6 MUST widen this SOURCE to the UNION with the addresses live
  # Session.Server processes are actually bound to. Rationale: this manager is
  # the crash boundary. A restart of THIS process (its ref-count table resets
  # to empty while sessions stay up and their aliases stay bound at the OS
  # layer) would make the very next reconcile classify every in-use alias as an
  # orphan and RELEASE it — pulling the source out from under live upstream
  # sockets. Until INC-6 provides the live holders, that failure mode is real;
  # it is harmless ONLY because no session binds a derived alias until INC-6.
  # The reconcile diff below does NOT change — INC-6 swaps the SOURCE here, one
  # explicit seam, never a rewrite of reconcile.
  @spec held_addresses(state()) :: [String.t()]
  defp held_addresses(state), do: Map.keys(state.refcounts)

  defp do_reconcile(state) do
    case state.adapter.list_aliases(state.prefix) do
      {:ok, os_bound} ->
        held = MapSet.new(held_addresses(state))
        orphans = Enum.reject(os_bound, &MapSet.member?(held, &1))

        if orphans != [] do
          Logger.info("source-alias reconcile: releasing #{length(orphans)} orphan alias(es)")
          Enum.each(orphans, &unbind(state, &1))
        end

        state

      {:error, reason} ->
        Logger.warning("source-alias reconcile: list_aliases failed (#{inspect(reason)}) — skipping sweep")
        state
    end
  end

  # Best-effort OS unbind, LOGGED on failure (no silent swallow — CLAUDE.md
  # boundary rule). Reconcile is the backstop for a stuck alias.
  defp unbind(state, addr) do
    case state.adapter.release_source(addr, state.prefix) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("source-alias release_source failed for #{inspect(addr)}: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp compute_arm(_, nil), do: {false, :no_static_prefix}

  defp compute_arm(adapter, prefix) when is_binary(prefix) do
    case adapter.arm_check(prefix) do
      :ok -> {true, nil}
      {:error, reason} -> {false, reason}
    end
  end

  defp publish_arm({armed?, reason} = arm) do
    unless armed? do
      Logger.info("source-alias mode 2 disarmed (#{inspect(reason)}) — static-mapping sessions will be held")
    end

    :persistent_term.put(@arm_key, arm)
    :ok
  end

  if Mix.env() == :test do
    @doc false
    @spec put_test_armed(boolean(), atom() | nil) :: :ok
    def put_test_armed(armed?, reason) do
      :persistent_term.put(@arm_key, {armed?, reason})
      :ok
    end
  end
end
