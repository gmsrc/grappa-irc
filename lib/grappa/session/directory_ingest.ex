defmodule Grappa.Session.DirectoryIngest do
  @moduledoc """
  #1390 slice 2 — the channel-directory (#84) `LIST` ingest, as a struct
  that owns its own decisions.

  ## What this is

  `Session.Server` used to carry the whole ETL: four state fields
  (`directory_refresh_timeout_ms`, `directory_progress_throttle_ms`,
  `directory_ingest_batch`, `directory_refresh`), three compile-env
  constants, a watchdog, and seven private functions parsing RPL_LIST rows,
  batching them, throttling progress pings and flushing the tail. The
  channel directory is a domain of its own — `Grappa.ChannelDirectory` — so
  none of that belonged on the hottest process in the tree.

  The four fields collapse to one `directory` key holding this struct.
  `run == nil` IS the "no refresh in flight" guard, exactly as
  `directory_refresh == nil` was.

  ## Why this one carries logic, unlike its `*Accum` siblings

  `WhoisAccum`, `LinksAccum` and friends are pure data drained by
  `EventRouter`. This module also owns the batch boundary, the throttle
  window and the row parse, because that is the whole point of the
  extraction: before it, those decisions were reachable only by booting a
  `Session.Server`, a fake ircd and the Repo (`directory_test.exs` is
  `async: false` on `DataCase` for exactly that reason).
  `directory_ingest_test.exs` drives them on plain `ExUnit.Case`,
  `async: true`, with no process and no database — and it can only stay
  that way while the decisions stay pure.

  ## Struct, not a declared map type

  The tracker used to be an anonymous map with declared keys and a
  `buffer: [map()]`. #1391 measured the difference with a mutant pair: a
  struct-field typo is a *compile* error, a bare-map key typo compiles
  clean, and declaring the map's shape changes neither. So the fix that
  buys anything here is the struct.

  ## IO stays at the call site, on purpose

  `absorb/3` and `finish/1` hand back what to do, never do it. Two pieces
  of observable behaviour depend on that split and are preserved
  deliberately rather than tidied:

    * the `directory_complete` total is re-read from the DB snapshot by
      `Session.Server`, NOT taken from `run.count` — the two can differ
      the moment `ChannelDirectory.ingest/3` dedupes or upserts;
    * `abort/1` (the watchdog) DROPS the buffered rows and hands back
      nothing to write, so a truncated refresh never calls
      `ChannelDirectory.finalize/2`. Flushing on timeout would change the
      DB on every stalled refresh.
  """

  alias Grappa.ChannelDirectory

  @cfg Application.compile_env(:grappa, Grappa.ChannelDirectory, [])
  @default_timeout_ms Keyword.get(@cfg, :refresh_timeout_ms, 60_000)
  @default_throttle_ms Keyword.get(@cfg, :progress_throttle_ms, 1_000)
  @default_batch Keyword.get(@cfg, :ingest_batch, 200)

  defmodule Run do
    @moduledoc """
    The in-flight half of a `LIST` refresh: present from the moment the
    `LIST` hits the wire until 323 RPL_LISTEND or the watchdog.

    `buffer` holds parsed rows newest-first for an O(1) prepend and is
    reversed at flush so the ingest preserves wire order. `count` is the
    running total across flushes, not the buffer depth. `last_emit_ms` is a
    `System.monotonic_time(:millisecond)` stamp seeded when the refresh is
    armed, and `timer` is the watchdog ref the caller must cancel on a
    clean finish.
    """

    @type t :: %__MODULE__{
            buffer: [Grappa.ChannelDirectory.ingest_row()],
            count: non_neg_integer(),
            last_emit_ms: integer(),
            timer: reference() | nil
          }

    defstruct buffer: [], count: 0, last_emit_ms: 0, timer: nil
  end

  @typedoc """
  What `Session.Server` must perform, in the order handed back.

  `{:ingest, rows}` is a bulk write of wire-ordered rows; `{:progress, n}`
  is a throttled `directory_progress` ping carrying the running total.
  """
  @type action :: {:ingest, [ChannelDirectory.ingest_row()]} | {:progress, non_neg_integer()}

  @type t :: %__MODULE__{
          timeout_ms: pos_integer(),
          throttle_ms: non_neg_integer(),
          batch: pos_integer(),
          run: Run.t() | nil
        }

  # The defaults ARE the production config, which is what makes
  # `Map.get(state, :directory, %DirectoryIngest{})` an exact equivalent for a
  # process hot-reloaded across the field's introduction — the same contract
  # the #1390 slice-1 `Deps` bundle relies on.
  defstruct timeout_ms: @default_timeout_ms,
            throttle_ms: @default_throttle_ms,
            batch: @default_batch,
            run: nil

  @doc """
  Build the idle ingest. Tunables are explicit: `Session.Server` resolves
  config-default-or-opts-override once, at `do_init/1`.
  """
  @spec new(keyword()) :: t()
  def new(opts) do
    %__MODULE__{
      timeout_ms: Keyword.fetch!(opts, :timeout_ms),
      throttle_ms: Keyword.fetch!(opts, :throttle_ms),
      batch: Keyword.fetch!(opts, :batch)
    }
  end

  @doc "True while a `LIST` refresh is streaming. The in-flight guard."
  @spec in_flight?(t()) :: boolean()
  def in_flight?(%__MODULE__{run: nil}), do: false
  def in_flight?(%__MODULE__{}), do: true

  @doc """
  Arm a refresh. `now_ms` seeds the throttle window, so the first row is
  inside it and emits no ping — the pre-extraction behaviour.
  """
  @spec start(t(), integer(), reference() | nil) :: t()
  def start(%__MODULE__{} = ingest, now_ms, timer) do
    %{ingest | run: %Run{last_emit_ms: now_ms, timer: timer}}
  end

  @doc """
  Parse one 322 RPL_LIST row.

  Params carry the client-nick echo first:
  `:server 322 <nick> <#channel> <#users> :<topic>`. The three-element
  clause covers a stripped upstream that omits the trailing topic. A
  non-binary count coerces to 0 — never crash an ingest on a malformed
  numeric — and an unrecognised shape is dropped.
  """
  @spec parse_row([String.t()]) :: {:ok, ChannelDirectory.ingest_row()} | :error
  def parse_row([_, channel, count_str, topic]) when is_binary(channel) do
    {:ok, %{name: channel, topic: topic, user_count: user_count(count_str)}}
  end

  def parse_row([_, channel, count_str]) when is_binary(channel) do
    {:ok, %{name: channel, topic: nil, user_count: user_count(count_str)}}
  end

  def parse_row(_), do: :error

  @doc """
  Absorb one parsed row, returning the ingest and what to perform.

  The batch flush is ordered BEFORE the progress ping, so a ping never
  reports a count the DB has not been offered yet.
  """
  @spec absorb(t(), ChannelDirectory.ingest_row(), integer()) :: {t(), [action()]}
  def absorb(%__MODULE__{run: %Run{} = run} = ingest, row, now_ms) do
    appended = %{run | buffer: [row | run.buffer], count: run.count + 1}

    {flushed, flush_actions} =
      if length(appended.buffer) >= ingest.batch do
        {rows, drained} = drain(appended)
        {drained, [{:ingest, rows}]}
      else
        {appended, []}
      end

    {emitted, progress_actions} = throttle(flushed, ingest.throttle_ms, now_ms)

    {%{ingest | run: emitted}, flush_actions ++ progress_actions}
  end

  @doc """
  Finish a refresh: hand back the tail rows (wire order, empty when there
  is nothing buffered) and the watchdog ref to cancel, and clear the run.

  Safe on an already-cleared ingest — `abort/1` leaves it in exactly that
  shape — where it yields no rows and no timer.
  """
  @spec finish(t()) :: {t(), [ChannelDirectory.ingest_row()], reference() | nil}
  def finish(%__MODULE__{run: nil} = ingest), do: {ingest, [], nil}

  def finish(%__MODULE__{run: %Run{} = run} = ingest) do
    {rows, _drained} = drain(run)
    {%{ingest | run: nil}, rows, run.timer}
  end

  @doc """
  Abandon a refresh without flushing — the `:directory_refresh_timeout`
  watchdog. Buffered rows since the last batch are DROPPED and no
  finalisation is offered; see the moduledoc for why that is preserved.
  """
  @spec abort(t()) :: t()
  def abort(%__MODULE__{} = ingest), do: %{ingest | run: nil}

  # Buffer is newest-first; hand back wire order and leave the run empty.
  @spec drain(Run.t()) :: {[ChannelDirectory.ingest_row()], Run.t()}
  defp drain(%Run{buffer: []} = run), do: {[], run}
  defp drain(%Run{buffer: buffer} = run), do: {Enum.reverse(buffer), %{run | buffer: []}}

  @spec throttle(Run.t(), non_neg_integer(), integer()) :: {Run.t(), [action()]}
  defp throttle(%Run{} = run, throttle_ms, now_ms) do
    if now_ms - run.last_emit_ms >= throttle_ms do
      {%{run | last_emit_ms: now_ms}, [{:progress, run.count}]}
    else
      {run, []}
    end
  end

  @spec user_count(term()) :: non_neg_integer()
  defp user_count(count_str) when is_binary(count_str) do
    case Integer.parse(count_str) do
      {n, _} -> n
      :error -> 0
    end
  end

  defp user_count(_), do: 0
end
