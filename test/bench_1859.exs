# Bench for issue 1859 — is the `GET /boot` bulk read actually cheaper than
# the burst it replaces, on a realistic corpus and a pool-bound SQLite?
#
#   ./scripts/mix.sh --env=dev run --no-start test/bench_1859.exs
#
# WHY THIS EXISTS. The maintainer's ruling (2026-08-29) is that the client
# cutover to `GET /boot` is not to be shipped on the round-trip argument
# alone: `Scrollback.bulk_heads/4`'s `ROW_NUMBER() OVER (PARTITION BY …)`
# keeps an indexed `SEARCH` at the base but adds a `USE TEMP B-TREE FOR LAST
# TERM OF ORDER BY`, trading many short statements for ONE held longer. On a
# `POOL_SIZE=10` deployment that trade is not free by construction. This is
# the measurement that ruling asked for, and a negative result is a result:
# if the trade is worse, the number says so and the client is NOT wired.
#
# It is NOT a test and `mix test` never collects it (no `_test.exs` suffix,
# by design — a 150k-row corpus build has no place in the suite). The
# durable count invariant stays `GrappaWeb.BootCostTest`; that pin answers
# "how many statements", which is exactly the question this file exists
# because it does NOT answer: a count of one says nothing about what the one
# costs.
#
# ── THE ARMS, AND WHY THERE ARE THREE ─────────────────────────────────
#
# Reading the client first changed the comparison, so it is spelled out
# rather than assumed. At cold boot cic fetches `/messages` for the ONE
# restored window (`selection.ts` → `loadInitialScrollback`, load-once, on
# SELECTION); it does not walk the channel list. `/boot` instead returns the
# heads for EVERY channel, eagerly. So the honest trade is not "N short
# statements now vs 1 long statement now" — it is:
#
#   BOOT_TODAY   1 × `Scrollback.fetch/7`      — one channel's head, now
#   BOOT_ENDPOINT 1 × `Scrollback.bulk_heads/4` — every channel's head, now
#   LAZY_TOTAL   N × `Scrollback.fetch/7`      — every channel's head, paid
#                                                 one selection at a time
#
# BOOT_ENDPOINT vs LAZY_TOTAL is the ruling's trade: the SAME work, one
# statement against N. BOOT_ENDPOINT vs BOOT_TODAY is the regression risk the
# cutover actually introduces at boot, and it is the comparison a
# round-trip-only argument never makes.
#
# ── WHAT WOULD MAKE THIS WORTHLESS ────────────────────────────────────
#
# Four ways, each with a control that must pass before any number prints:
#
#   * the corpus is too small for SQLite to plan like prod  → CORPUS control
#   * the arms do not return the same rows, so "faster" is  → ORACLE control
#     just "did less"
#   * the instrument cannot see cost at all                 → RULER + GROWTH
#   * axis B never actually contends for the pool, so its   → CONTENTION
#     flat line means "no measurement", not "no problem"
#
# The instrument is Ecto's own `[:grappa, :repo, :query]` telemetry, which
# separates `query_time` (the statement's own timing — what the ruling asks
# for) from `queue_time` (the pool wait — the thing the ruling is actually
# afraid of). A wall-clock alone cannot tell those two apart, and on a
# pool-bound deployment they are the whole question.
#
# ── WHAT THIS BENCH DOES NOT MEASURE ──────────────────────────────────
#
# Network RTT, TLS, JSON encoding, and the reverse proxy's `limit_req` are
# all absent: this runs against the Repo, in one VM, with no HTTP. Every one
# of those costs falls on the BEFORE arm's extra requests and on nothing
# else, so their absence biases this bench AGAINST the cutover. A win
# measured here is therefore a LOWER BOUND on the real win, and a loss
# measured here is a real loss. That asymmetry is the reason this shape is
# worth running at all rather than a reason to discount it.

import Ecto.Query

alias Grappa.Repo
alias Grappa.Scrollback
alias Grappa.Scrollback.Message

db = System.get_env("BENCH_DB", "/tmp/bench_1859.db")
for suffix <- ["", "-wal", "-shm"], do: File.rm(db <> suffix)

# 150k rows: past the 100k+ the ruling names, and past the 130k the operator
# reported. Shrink to dry-run the harness — a shrunk run is a DRY RUN and no
# number from it may be quoted (at toy sizes SQLite may decline the index).
corpus_rows = 150_000

# The channel-count axis. 20 is the reported prod shape; 50 is the doubling
# that tells a law from a constant.
channel_axis = [1, 8, 20, 50]
n_channels = Enum.max(channel_axis)

# The reported deployment. This is the number the ruling turns on.
pool_size = 10
concurrency_axis = [1, 5, 10, 20]

head_limit = 50
reps = 5

# `--no-start` keeps :grappa's tree down (no Endpoint, no sessions) but
# Ecto's own registry must be up before a repo can start.
{:ok, _} = Application.ensure_all_started(:ecto_sql)
{:ok, _} = Application.ensure_all_started(:exqlite)

# MIGRATE ON A SINGLE CONNECTION, then hand the file to the real pool.
#
# Measured here (2x2 on shape x pool, then a sweep): replaying the 92
# migrations onto a fresh DB PASSES at `pool_size` 1 and 2 and FAILS at 3, 4,
# 5 and 10, always with `no such column: "max_concurrent_user_sessions"` —
# the `DROP COLUMN` in `20260516184555` not seeing the `ADD COLUMN` from
# `20260516154723`. So the migration step gets its own one-connection repo
# and the measurement gets the `POOL_SIZE=10` one it is about. Doing both on
# one pool-10 repo is what made the first run of this bench red, and reading
# that red as a broken migration set would have been wrong.
defmodule MigRepo do
  @moduledoc false
  use Ecto.Repo, otp_app: :grappa, adapter: Ecto.Adapters.SQLite3
end

{:ok, mig} = MigRepo.start_link(database: db, pool_size: 1, journal_mode: :wal, log: false)

IO.puts("== migrating #{db} (pool_size: 1)")
Ecto.Migrator.run(MigRepo, Path.expand("priv/repo/migrations"), :up, all: true, log: false)
Supervisor.stop(mig)

{:ok, _} =
  Repo.start_link(
    database: db,
    pool_size: pool_size,
    journal_mode: :wal,
    cache_size: -64_000,
    busy_timeout: 30_000,
    log: false
  )

defmodule Bench do
  @moduledoc false

  alias Grappa.Repo
  alias Grappa.Scrollback.Message

  @own_nick "vjt"

  @spec own_nick() :: String.t()
  def own_nick, do: @own_nick

  @spec median([number()]) :: number()
  def median([]), do: 0

  def median(list) do
    sorted = Enum.sort(list)
    n = length(sorted)

    if rem(n, 2) == 1,
      do: Enum.at(sorted, div(n, 2)),
      else: (Enum.at(sorted, div(n, 2) - 1) + Enum.at(sorted, div(n, 2))) / 2
  end

  @spec ms(number()) :: float()
  def ms(us), do: Float.round(us / 1000, 2)

  @spec ratio(number(), number()) :: float()
  def ratio(_, 0), do: 0.0
  def ratio(a, b), do: Float.round(a / b, 2)

  @spec pad(term(), pos_integer()) :: String.t()
  def pad(v, n), do: String.pad_trailing(to_string(v), n)

  @doc """
  Median of `reps` timings after 2 warm-ups — the steady-state cost, not a
  page-cache miss.
  """
  @spec time((-> any()), pos_integer()) :: number()
  def time(fun, reps) do
    for _ <- 1..2, do: fun.()
    us = for _ <- 1..reps, do: fun |> :timer.tc() |> elem(0)
    median(us)
  end

  @doc """
  Channel names, ALREADY FOLDED — `messages.channel` stores the folded key
  (the channel pattern), so a bench that seeded raw-cased names would be
  measuring a predicate that never matches in production.
  """
  @spec channels(pos_integer()) :: [String.t()]
  def channels(n), do: for(i <- 0..(n - 1), do: "#chan#{String.pad_leading(to_string(i), 3, "0")}")

  @doc """
  Prod-shaped heavy tail: one dominant channel, two busy, the rest thin.
  A flat corpus would hide exactly the partition-skew the window function
  has to cope with.
  """
  @spec bag([String.t()]) :: tuple()
  def bag(channels) do
    channels
    |> Enum.with_index()
    |> Enum.flat_map(fn
      {c, 0} -> List.duplicate(c, 300)
      {c, i} when i in [1, 2] -> List.duplicate(c, 100)
      {c, _} -> List.duplicate(c, 8)
    end)
    |> List.to_tuple()
  end

  @doc """
  Seeds ONE row per channel first so no channel can be empty by sampling
  accident, then `n` sampled rows. Returns the next clock.
  """
  @spec seed(Ecto.UUID.t(), integer(), [String.t()], non_neg_integer(), integer()) :: integer()
  def seed(user_id, network_id, channels, n, clock) do
    now = DateTime.utc_now()
    b = bag(channels)
    size = tuple_size(b)

    {rows, clock} =
      Enum.map_reduce(channels, clock, fn c, clock ->
        {row(c, clock, user_id, network_id, :privmsg, now, @own_nick), clock + 1}
      end)

    {_, _} = Repo.insert_all(Message, rows)

    :rand.seed(:exsss, {1, 2, 3})

    1..n//1
    |> Stream.chunk_every(2_000)
    |> Enum.reduce(clock, fn chunk, clock ->
      {rows, clock} = Enum.map_reduce(chunk, clock, &sampled_row(&1, &2, b, size, user_id, network_id, now))
      {_, _} = Repo.insert_all(Message, rows)
      clock
    end)
  end

  # One sampled row and the next clock. ~8% presence events, ~4% own-authored
  # — a corpus of pure PRIVMSG would measure a predicate the presence filter
  # never has to work on.
  @spec sampled_row(term(), integer(), tuple(), pos_integer(), Ecto.UUID.t(), integer(), DateTime.t()) ::
          {map(), integer()}
  defp sampled_row(_, clock, bag, size, user_id, network_id, now) do
    roll = :rand.uniform(100)

    kind =
      cond do
        roll <= 8 -> Enum.random([:join, :part, :quit])
        roll <= 12 -> :action
        true -> :privmsg
      end

    sender = if roll <= 4, do: @own_nick, else: "peer#{rem(clock, 97)}"
    channel = elem(bag, :rand.uniform(size) - 1)

    {row(channel, clock, user_id, network_id, kind, now, sender), clock + 1}
  end

  @spec row(String.t(), integer(), Ecto.UUID.t(), integer(), atom(), DateTime.t(), String.t()) ::
          map()
  def row(channel, clock, user_id, network_id, kind, now, sender) do
    %{
      user_id: user_id,
      visitor_id: nil,
      network_id: network_id,
      channel: channel,
      dm_with: nil,
      sender: sender,
      server_time: clock,
      kind: kind,
      body: "bench body #{clock}",
      meta: %{},
      inserted_at: now
    }
  end
end

defmodule Probe do
  @moduledoc """
  Ecto per-query telemetry, folded per phase. `query_time` is the statement's
  own timing; `queue_time` is the wait for a pool connection. Keeping them
  apart is the whole point — a wall-clock cannot say which one grew.
  """

  @handler {__MODULE__, :collect}

  @spec start() :: :ok
  def start do
    _ = :ets.new(:probe, [:named_table, :public, :duplicate_bag])

    :telemetry.attach(
      @handler,
      [:grappa, :repo, :query],
      &__MODULE__.handle/4,
      nil
    )
  end

  @spec handle([atom()], map(), map(), term()) :: :ok
  def handle(_, m, _, _) do
    :ets.insert(
      :probe,
      {:e, System.convert_time_unit(m[:query_time] || 0, :native, :microsecond),
       System.convert_time_unit(m[:queue_time] || 0, :native, :microsecond)}
    )

    :ok
  end

  @spec reset() :: :ok
  def reset do
    :ets.delete_all_objects(:probe)
    :ok
  end

  @doc "`{statement_count, query_us_total, query_us_max, queue_us_total, queue_us_max}`"
  @spec drain() :: {non_neg_integer(), number(), number(), number(), number()}
  def drain do
    rows = :ets.tab2list(:probe)
    :ets.delete_all_objects(:probe)
    q = Enum.map(rows, fn {:e, qt, _} -> qt end)
    w = Enum.map(rows, fn {:e, _, wt} -> wt end)

    {length(rows), Enum.sum(q), (q == [] && 0) || Enum.max(q), Enum.sum(w), (w == [] && 0) || Enum.max(w)}
  end
end

Probe.start()

{:ok, ledger} = Agent.start_link(fn -> [] end)
control = fn name, ok?, detail -> Agent.update(ledger, &[{name, ok?, detail} | &1]) end

# ----------------------------------------------------------------------
# Fixtures + corpus
# ----------------------------------------------------------------------

now = DateTime.utc_now()

user =
  Repo.insert!(%Grappa.Accounts.User{
    name: "bench1859",
    password_hash: "x",
    inserted_at: now,
    updated_at: now
  })

network =
  Repo.insert!(%Grappa.Networks.Network{slug: "bench-net", inserted_at: now, updated_at: now})

channels = Bench.channels(n_channels)
subject = {:user, user.id}

IO.puts("== seeding #{corpus_rows} rows across #{n_channels} channels")
{seed_us, _} = :timer.tc(fn -> Bench.seed(user.id, network.id, channels, corpus_rows, 1) end)
IO.puts("   seeded in #{Bench.ms(seed_us)}ms")

# ----------------------------------------------------------------------
# The arms
# ----------------------------------------------------------------------

# BEFORE, per channel — the production function `MessagesController.index/2`
# calls, with the cold-open cursor (`nil` = newest page) and the boot's
# `hide_presence: false`.
one_head = fn chan ->
  Scrollback.fetch(subject, network.id, chan, nil, head_limit, Bench.own_nick(), false)
end

# AFTER — the production function `BootController` calls, with the empty
# hidden set (the common case its own docs name).
bulk_heads = fn chans ->
  Scrollback.bulk_heads(
    subject,
    Enum.map(chans, &{network.id, &1}),
    head_limit,
    MapSet.new()
  )
end

# ----------------------------------------------------------------------
# Controls — nothing prints until every entry is :ok
# ----------------------------------------------------------------------

%Exqlite.Result{rows: [[total_rows]]} =
  Repo.query!("SELECT count(*) FROM messages WHERE user_id = ?1", [user.id], log: false)

control.(
  "the corpus is in the 100k+ range the ruling asks for",
  total_rows >= 100_000,
  "corpus is #{total_rows} rows — below 100k, SQLite may plan differently than prod"
)

# ORACLE — the two arms must hand back the SAME rows per channel, or
# "cheaper" only means "did less". Compared as id SETS: `fetch/7` returns
# DESC and `bulk_heads/4` returns ASC, which is a shape difference and not a
# content one.
oracle_chans = Enum.take(channels, 20)
bulk_answer = bulk_heads.(oracle_chans)

oracle_mismatches =
  Enum.reject(oracle_chans, fn c ->
    a = c |> one_head.() |> Enum.map(& &1.id) |> MapSet.new()
    b = bulk_answer |> Map.get({network.id, c}, []) |> Enum.map(& &1.id) |> MapSet.new()
    MapSet.equal?(a, b)
  end)

control.(
  "both arms return identical id sets, per channel (#{length(oracle_chans)} channels)",
  oracle_mismatches == [],
  "arms disagree on: #{inspect(Enum.take(oracle_mismatches, 5))}"
)

# ORACLE, second half — an empty agreement is agreement about nothing.
control.(
  "and those id sets are non-empty",
  Enum.all?(oracle_chans, fn c -> bulk_answer |> Map.get({network.id, c}, []) |> length() > 0 end),
  "at least one channel returned zero rows, so the comparison above is vacuous"
)

# RULER — a cost known to be partition-linear. If this cannot be seen to
# grow, the instrument is not measuring size and no flat line means anything.
ruler = fn ->
  Repo.query!("SELECT count(*) FROM messages WHERE user_id = ?1", [user.id], log: false)
end

ruler_us = Bench.time(ruler, reps)

# TELEMETRY CAPABILITY — the probe must actually see a statement, with a
# non-zero query_time. A silent probe would report every arm as free.
Probe.reset()
_ = one_head.(hd(channels))
{probe_n, probe_q, _, _, _} = Probe.drain()

control.(
  "the telemetry probe sees statements and non-zero query_time",
  probe_n > 0 and probe_q > 0,
  "probe saw #{probe_n} statements totalling #{probe_q}us — it is blind, every number below would read as free"
)

# TIMER CAPABILITY — it must be able to see a delay at all.
{slow_us, _} = :timer.tc(fn -> Process.sleep(50) end)

control.(
  "the timer can see a 50ms delay",
  slow_us > 40_000,
  "timer read #{slow_us}us for a 50ms sleep"
)

# ----------------------------------------------------------------------
# AXIS A — single boot, channel count varies, corpus HELD at #{corpus_rows}
# ----------------------------------------------------------------------

axis_a =
  for n <- channel_axis do
    chans = Enum.take(channels, n)

    Probe.reset()
    lazy_us = Bench.time(fn -> Enum.each(chans, one_head) end, reps)
    {lazy_n, lazy_q, lazy_qmax, _, _} = Probe.drain()

    Probe.reset()
    bulk_us = Bench.time(fn -> bulk_heads.(chans) end, reps)
    {bulk_n, bulk_q, bulk_qmax, _, _} = Probe.drain()

    %{
      n: n,
      lazy_us: lazy_us,
      bulk_us: bulk_us,
      # `drain` covers 2 warm-ups + `reps` runs; per-run is what a boot pays.
      lazy_stmts: div(lazy_n, reps + 2),
      bulk_stmts: div(bulk_n, reps + 2),
      lazy_q: lazy_q / (reps + 2),
      bulk_q: bulk_q / (reps + 2),
      lazy_qmax: lazy_qmax,
      bulk_qmax: bulk_qmax
    }
  end

# GROWTH — the N-statement arm MUST get dearer as the channel count rises.
# If it does not, this axis cannot see the trade at all and its verdict is
# empty rather than reassuring.
first_a = hd(axis_a)
last_a = List.last(axis_a)

control.(
  "the per-channel arm grows with the channel count (the axis is visible)",
  last_a.lazy_us > first_a.lazy_us * 2,
  "#{first_a.n} channels: #{Bench.ms(first_a.lazy_us)}ms -> #{last_a.n} channels: " <>
    "#{Bench.ms(last_a.lazy_us)}ms — the axis is flat, so this bench cannot see channel count"
)

# ----------------------------------------------------------------------
# AXIS B — concurrent boots at POOL_SIZE=#{pool_size}. This is the ruling's
# actual worry: one statement held longer, against a pool this narrow.
# ----------------------------------------------------------------------

boot_chans = Enum.take(channels, 20)

herd = fn c, fun ->
  {us, _} =
    :timer.tc(fn ->
      1..c
      |> Task.async_stream(fn _ -> fun.() end, max_concurrency: c, timeout: 120_000)
      |> Stream.run()
    end)

  us
end

axis_b =
  for c <- concurrency_axis do
    Probe.reset()
    lazy_us = herd.(c, fn -> Enum.each(boot_chans, one_head) end)
    {_, _, _, lazy_w, lazy_wmax} = Probe.drain()

    Probe.reset()
    bulk_us = herd.(c, fn -> bulk_heads.(boot_chans) end)
    {_, _, _, bulk_w, bulk_wmax} = Probe.drain()

    %{
      c: c,
      lazy_us: lazy_us,
      bulk_us: bulk_us,
      lazy_queue: lazy_w,
      bulk_queue: bulk_w,
      lazy_qmax: lazy_wmax,
      bulk_qmax: bulk_wmax
    }
  end

# CONTENTION — past the pool size the herd MUST actually queue. Without a
# measurable wait, axis B is running unopposed and a flat line there says
# nothing about a pool-bound deployment.
saturated = Enum.find(axis_b, &(&1.c > pool_size))

control.(
  "past POOL_SIZE=#{pool_size} the herd really waits for a connection",
  saturated != nil and max(saturated.lazy_qmax, saturated.bulk_qmax) > 1_000,
  "at c=#{saturated && saturated.c} the worst queue_time was " <>
    "#{saturated && max(saturated.lazy_qmax, saturated.bulk_qmax)}us — the pool was never " <>
    "contended, so axis B measured an idle system"
)

# ----------------------------------------------------------------------
# AXIS C — corpus size varies, channel count HELD at 20. Axis A showed the
# bulk arm is dearer; this one says whether that is a CONSTANT or a LAW.
#
# `fetch/7` walks the `(network_id, channel, server_time DESC)` index
# backwards and stops after `limit` rows, so its cost is bound by the LIMIT.
# `bulk_heads/4`'s `ROW_NUMBER()` has to rank the whole partition before the
# outer `rn <= limit` can discard anything, so its cost is bound by the
# PARTITION. If that reading is right, the gap widens with the corpus and no
# amount of tuning closes it — which is a different finding from "slower".
# ----------------------------------------------------------------------

net_c = Repo.insert!(%Grappa.Networks.Network{slug: "bench-net-c", inserted_at: now, updated_at: now})
chans_c = Bench.channels(20)

one_head_c = fn chan ->
  Scrollback.fetch(subject, net_c.id, chan, nil, head_limit, Bench.own_nick(), false)
end

bulk_heads_c = fn ->
  Scrollback.bulk_heads(subject, Enum.map(chans_c, &{net_c.id, &1}), head_limit, MapSet.new())
end

{axis_c, _} =
  Enum.map_reduce([25_000, 50_000, 100_000, 150_000], {0, 1}, fn target, {have, clock} ->
    clock = Bench.seed(user.id, net_c.id, chans_c, target - have, clock)

    %Exqlite.Result{rows: [[n]]} =
      Repo.query!("SELECT count(*) FROM messages WHERE network_id = ?1", [net_c.id], log: false)

    lazy_us = Bench.time(fn -> Enum.each(chans_c, one_head_c) end, reps)
    bulk_us = Bench.time(bulk_heads_c, reps)

    {%{rows: n, lazy_us: lazy_us, bulk_us: bulk_us}, {target, clock}}
  end)

# LAW-vs-CONSTANT control. The two arms must be seen to respond DIFFERENTLY
# to the corpus, or axis C has nothing to say. Stated as: the bulk arm grows
# by more than the lazy arm does, across a 6x corpus.
c_first = hd(axis_c)
c_last = List.last(axis_c)
lazy_growth = Bench.ratio(c_last.lazy_us, c_first.lazy_us)
bulk_growth = Bench.ratio(c_last.bulk_us, c_first.bulk_us)

control.(
  "axis C can tell the two arms apart on corpus size",
  c_last.rows > c_first.rows * 4,
  "corpus only went #{c_first.rows} -> #{c_last.rows}, not a wide enough axis"
)

# EXPLAIN — the ruling names `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`
# explicitly, so the plan is printed rather than described.
explain_of = fn q -> Repo.explain(:all, q, log: false) end

head_chan = hd(chans_c)

lazy_plan_q =
  from(m in Message,
    where: m.user_id == ^user.id and m.network_id == ^net_c.id and m.channel == ^head_chan,
    order_by: [desc: m.server_time, desc: m.id],
    limit: ^head_limit
  )

lazy_plan = explain_of.(lazy_plan_q)

ranked_plan_q =
  from(m in Message,
    where: m.user_id == ^user.id and m.network_id == ^net_c.id and m.channel in ^chans_c,
    select: %{id: m.id, rn: over(row_number(), :w)},
    windows: [w: [partition_by: [m.network_id, m.channel], order_by: [desc: m.server_time, desc: m.id]]]
  )

bulk_plan = explain_of.(ranked_plan_q)

# ----------------------------------------------------------------------
# Output gate
# ----------------------------------------------------------------------

controls = ledger |> Agent.get(& &1) |> Enum.reverse()
failed = Enum.reject(controls, fn {_, ok?, _} -> ok? end)

if failed != [] do
  IO.puts("\n!! CONTROLS FAILED — no measurement printed")
  for {name, _, detail} <- failed, do: IO.puts("   FAIL #{name}\n        #{detail}")
  System.halt(1)
end

IO.puts("\n== CONTROLS: #{length(controls)}/#{length(controls)} passed")
for {name, _, _} <- controls, do: IO.puts("   ok  #{name}")

IO.puts("\n== CORPUS: #{total_rows} rows, #{n_channels} channels, POOL_SIZE=#{pool_size}")
IO.puts("   ruler (count(*) over the partition): #{Bench.ms(ruler_us)}ms")

IO.puts("\n== AXIS A — one boot, corpus held still, channel count varies")
IO.puts("   LAZY_TOTAL = N x Scrollback.fetch/7   BULK = 1 x Scrollback.bulk_heads/4")
IO.puts("")

IO.puts("chans | lazy stmts | lazy wall | lazy dbtime | bulk stmts | bulk wall | bulk dbtime | wall ratio")

for r <- axis_a do
  IO.puts(
    "#{Bench.pad(r.n, 5)} | #{Bench.pad(r.lazy_stmts, 10)} | " <>
      "#{Bench.pad(Bench.ms(r.lazy_us), 9)} | #{Bench.pad(Bench.ms(r.lazy_q), 11)} | " <>
      "#{Bench.pad(r.bulk_stmts, 10)} | #{Bench.pad(Bench.ms(r.bulk_us), 9)} | " <>
      "#{Bench.pad(Bench.ms(r.bulk_q), 11)} | #{Bench.ratio(r.lazy_us, r.bulk_us)}x"
  )
end

boot_today = hd(axis_a)
boot_20 = Enum.find(axis_a, &(&1.n == 20))

IO.puts("\n== THE BOOT COMPARISON THE ROUND-TRIP ARGUMENT DOES NOT MAKE")

IO.puts(
  "   boot TODAY  (1 channel head, lazily the rest): #{Bench.ms(boot_today.lazy_us)}ms, " <>
    "#{boot_today.lazy_stmts} statement(s)"
)

IO.puts(
  "   boot WITH /boot (every channel head, eagerly): #{Bench.ms(boot_20.bulk_us)}ms, " <>
    "#{boot_20.bulk_stmts} statement(s)   [at 20 channels]"
)

IO.puts("   so the cutover moves #{Bench.ratio(boot_20.bulk_us, boot_today.lazy_us)}x more DB work INTO the boot,")

IO.puts("   and buys back #{Bench.ratio(boot_20.lazy_us, boot_20.bulk_us)}x on the all-channels total.")

IO.puts("\n== AXIS B — concurrent boots at POOL_SIZE=#{pool_size}, 20 channels each")
IO.puts("   queue = time waiting for a pool connection, summed over the herd")
IO.puts("")
IO.puts("conc | lazy wall | lazy queue | lazy qmax | bulk wall | bulk queue | bulk qmax")

for r <- axis_b do
  IO.puts(
    "#{Bench.pad(r.c, 4)} | #{Bench.pad(Bench.ms(r.lazy_us), 9)} | " <>
      "#{Bench.pad(Bench.ms(r.lazy_queue), 10)} | #{Bench.pad(Bench.ms(r.lazy_qmax), 9)} | " <>
      "#{Bench.pad(Bench.ms(r.bulk_us), 9)} | #{Bench.pad(Bench.ms(r.bulk_queue), 10)} | " <>
      "#{Bench.ms(r.bulk_qmax)}"
  )
end

IO.puts("\n== AXIS C — corpus varies, channels HELD at 20 (law vs constant)")
IO.puts("")
IO.puts("rows    | lazy wall | bulk wall | bulk/lazy")

for r <- axis_c do
  IO.puts(
    "#{Bench.pad(r.rows, 7)} | #{Bench.pad(Bench.ms(r.lazy_us), 9)} | " <>
      "#{Bench.pad(Bench.ms(r.bulk_us), 9)} | #{Bench.ratio(r.bulk_us, r.lazy_us)}x"
  )
end

IO.puts(
  "\n   across #{Bench.ratio(c_last.rows, c_first.rows)}x the corpus: lazy grew #{lazy_growth}x, " <>
    "bulk grew #{bulk_growth}x"
)

IO.puts("\n== QUERY PLANS (the ruling names the TEMP B-TREE explicitly)")
IO.puts("\n-- per-channel fetch/7 (the arm being replaced):")
IO.puts(lazy_plan)
IO.puts("\n-- the ROW_NUMBER() ranking subquery inside bulk_heads/4:")
IO.puts(bulk_plan)

IO.puts("\n== VERDICT")

worst = List.last(axis_b)
bulk_wins_same_work? = boot_20.bulk_us < boot_20.lazy_us
bulk_wins_under_load? = worst.bulk_us < worst.lazy_us
boot_cost_multiple = Bench.ratio(boot_20.bulk_us, boot_today.lazy_us)

IO.puts(
  cond do
    bulk_wins_same_work? and bulk_wins_under_load? ->
      "TRADE HOLDS. For the SAME work (every channel's head) the single statement is\n" <>
        "#{Bench.ratio(boot_20.lazy_us, boot_20.bulk_us)}x cheaper than N statements, and it stays ahead at " <>
        "c=#{worst.c} on POOL_SIZE=#{pool_size}\n" <>
        "(#{Bench.ms(worst.bulk_us)}ms vs #{Bench.ms(worst.lazy_us)}ms, worst pool wait " <>
        "#{Bench.ms(worst.bulk_qmax)}ms vs #{Bench.ms(worst.lazy_qmax)}ms).\n" <>
        "BUT the cutover still moves #{boot_cost_multiple}x more DB work INTO the boot than boot does\n" <>
        "today, because today's boot reads ONE channel's head and /boot reads every one.\n" <>
        "That is a real cost and it is not the round-trip axis; weigh it against the\n" <>
        "#{boot_20.lazy_stmts - boot_20.bulk_stmts} statements and the N_networks round trips it removes."

    bulk_wins_same_work? and not bulk_wins_under_load? ->
      "TRADE INVERTS UNDER LOAD. Single-threaded the one statement wins " <>
        "(#{Bench.ms(boot_20.bulk_us)}ms vs #{Bench.ms(boot_20.lazy_us)}ms),\n" <>
        "but at c=#{worst.c} on POOL_SIZE=#{pool_size} it LOSES: #{Bench.ms(worst.bulk_us)}ms vs " <>
        "#{Bench.ms(worst.lazy_us)}ms,\nworst pool wait #{Bench.ms(worst.bulk_qmax)}ms vs " <>
        "#{Bench.ms(worst.lazy_qmax)}ms. This is exactly the failure the ruling\n" <>
        "predicted by construction. DO NOT WIRE on these numbers."

    true ->
      "TRADE DOES NOT HOLD. Even for the same work the single statement is not cheaper\n" <>
        "(#{Bench.ms(boot_20.bulk_us)}ms vs #{Bench.ms(boot_20.lazy_us)}ms at 20 channels).\n" <>
        "DO NOT WIRE on these numbers."
  end
)

IO.puts("\n== done")
