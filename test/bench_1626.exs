# Bench harness for #1626 — the measurement that justified taking a
# field OFF the wire. Committed, deliberately: this change cost a
# `protocol_version` bump and a doctrine reversal, and a ruling of that
# weight should rest on evidence somebody else can re-run rather than on
# a table pasted into a PR.
#
# It is NOT a test and `mix test` never collects it (no `_test.exs`
# suffix, by design — a multi-minute 1.3M-row corpus build has no place
# in the suite). The DURABLE regression guard for this property is the
# EXPLAIN-plan test in `test/grappa/scrollback_test.exs`, which pins the
# plan off the SQL `list_archive/3` EMITS; this file is the one-time
# quantitative record behind it.
#
# Run (from the worktree root):
#
#   ./scripts/mix.sh --env=dev run --no-start test/bench_1626.exs
#
# Takes a couple of minutes: axis A alone builds 1.3M rows. To exercise
# the machinery quickly, shrink `@axis_a_sizes` / `@axis_b_rows` below —
# an edit and not an env knob, deliberately, because `scripts/mix.sh`
# does not forward host environment into the container and a knob that
# silently does nothing is worse than no knob. A shrunk run is a DRY RUN
# of the harness, not a measurement: at toy sizes SQLite may decline the
# index, and no number produced that way may be quoted.
#
# Boots ONLY Grappa.Repo, pointed at a scratch SQLite file, migrated with
# the real migration set, so `Scrollback.list_archive/3` runs through the
# app's own pool (SQLite plans are per-connection — a hand-driven sqlite3
# would measure a different thing) and OUTSIDE the test sandbox.
#
# ── WHAT THIS BENCH IS FOR, AND WHAT WOULD MAKE IT WORTHLESS ──────────
#
# #1626 is a claim about a COMPLEXITY CLASS, not about a constant: the
# archive listing must stop being bound to the size of the account. A
# single measurement, or a set of measurements at ONE partition size,
# cannot tell a law from a factor — it is exactly the confusion that
# filed #1626 and #1759. So the harness measures TWO axes:
#
#   AXIS A — partition size varies (10k → 1.3M), target count HELD STILL.
#            A partition-bound cost grows here. A target-bound cost does
#            not. This is the axis the claim is about.
#   AXIS B — target count varies (20 → 1000), partition size HELD STILL
#            at exactly 100k rows. This is the axis the cost is claimed
#            to have MOVED ONTO, and measuring it is what makes the flat
#            line on axis A a displacement rather than a disappearance.
#
# Flatness on axis A alone is consistent with "the harness cannot see
# size at all". Two independent KNOWN-ANSWER controls rule that out: a
# ruler query (`count(*)` over the partition) and the PRE-#1626 shape
# itself must BOTH visibly grow on the same instrument, in the same run.
#
# ── THE OUTPUT GATE ───────────────────────────────────────────────────
#
# Every control is buffered into a ledger and every number is withheld
# until the ledger is clean. A failing control prints the failures and
# halts rc=1 having printed NO measurement — an output that cannot exist
# without its controls cannot lie in silence.
#
# The CLAIM is deliberately NOT a control. Controls check the instrument
# and the answers it can be checked against; gating the output on the
# claim would hide the numbers in exactly the case where they are most
# worth reading. The claim is printed as a VERDICT computed from the
# numbers, with the ratios it rests on.

import Ecto.Query

alias Grappa.IRC.Identifier
alias Grappa.Repo
alias Grappa.Scrollback
alias Grappa.Scrollback.Message

db = System.get_env("BENCH_DB", "/tmp/bench_1626.db")
for suffix <- ["", "-wal", "-shm"], do: File.rm(db <> suffix)

# The two axes. 650k is #1626's prod anchor and 1.3M is its doubling —
# the pair that tells a law from a constant. Shrink to dry-run the
# harness; see the header for why that is not a measurement.
axis_a_sizes = [10_000, 100_000, 650_000, 1_300_000]
axis_b_rows = 100_000

# `--no-start` keeps :grappa's supervision tree down (no Endpoint, no
# sessions) but Ecto's own registry must be up before a repo can start.
{:ok, _} = Application.ensure_all_started(:ecto_sql)
{:ok, _} = Application.ensure_all_started(:exqlite)

{:ok, _} =
  Repo.start_link(
    database: db,
    pool_size: 1,
    journal_mode: :wal,
    cache_size: -64_000,
    busy_timeout: 30_000,
    log: false
  )

IO.puts("== migrating #{db}")
Ecto.Migrator.run(Repo, Path.expand("priv/repo/migrations"), :up, all: true, log: false)

defmodule Bench do
  @moduledoc false

  import Ecto.Query

  alias Grappa.{IRC.Identifier, Repo, Scrollback.Message, Subject}

  require Identifier

  @own_nick "vjt"

  @type target :: {:chan, String.t()} | {:dm, String.t()}
  @type sampler :: {tuple(), pos_integer(), [String.t()], [String.t()], [String.t()]}

  @spec own_nick() :: String.t()
  def own_nick, do: @own_nick

  @spec median([number()]) :: number()
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
  def ratio(a, b), do: Float.round(a / b, 2)

  @spec pad(term(), pos_integer()) :: String.t()
  def pad(v, n), do: String.pad_trailing(to_string(v), n)

  @doc """
  Median of `reps` timings after 2 warm-up calls — warm, so the number
  is the steady-state cost and not the page-cache miss.
  """
  @spec time((-> any()), pos_integer()) :: number()
  def time(fun, reps) do
    for _ <- 1..2, do: fun.()
    us = for _ <- 1..reps, do: fun |> :timer.tc() |> elem(0)
    median(us)
  end

  @doc """
  Target inventory for a corpus. Prod-shaped heavy tail: one dominant
  channel, two busy, the rest thin; DM peers with their own tail.

  Returns `{bag, bag_size, channels, peers, variants}` where `bag` is a
  weight-expanded tuple for O(1) sampling.
  """
  @spec sampler(pos_integer(), pos_integer(), [String.t()]) :: sampler()
  def sampler(n_channels, n_peers, case_variants) do
    channels = for i <- 0..(n_channels - 1), do: "#chan#{String.pad_leading(to_string(i), 3, "0")}"
    peers = for i <- 0..(n_peers - 1), do: "peer#{String.pad_leading(to_string(i), 3, "0")}"

    chan_weights =
      channels
      |> Enum.with_index()
      |> Enum.map(fn
        {c, 0} -> {{:chan, c}, 300}
        {c, i} when i in [1, 2] -> {{:chan, c}, 100}
        {c, _} -> {{:chan, c}, 8}
      end)

    peer_weights =
      peers
      |> Enum.with_index()
      |> Enum.map(fn {p, i} -> {{:dm, p}, max(1, 8 - div(i, 25))} end)

    variant_weights = Enum.map(case_variants, fn v -> {{:dm, v}, 4} end)

    bag =
      (chan_weights ++ peer_weights ++ variant_weights)
      |> Enum.flat_map(fn {t, w} -> List.duplicate(t, w) end)
      |> List.to_tuple()

    {bag, tuple_size(bag), channels, peers, case_variants}
  end

  @doc """
  The FOLDED target set the corpus is built to contain — the known
  answer the entry-set control checks against.
  """
  @spec expected_targets(sampler()) :: [String.t()]
  def expected_targets({_, _, channels, peers, variants}) do
    (channels ++ peers ++ variants)
    |> Enum.map(&Identifier.canonical_target/1)
    |> Enum.uniq()
  end

  @doc """
  Seeds ONE row per target so no target can be missing by sampling
  accident — the entry-set control must not be able to measure a short
  set and call it agreement. Returns the next clock.
  """
  @spec seed_every_target(Ecto.UUID.t(), integer(), sampler(), integer()) :: integer()
  def seed_every_target(user_id, network_id, {bag, _, _, _, _}, clock) do
    now = DateTime.utc_now()
    targets = bag |> Tuple.to_list() |> Enum.uniq()

    {rows, clock} =
      Enum.map_reduce(targets, clock, fn target, clock ->
        {row(target, clock, user_id, network_id, :privmsg, now, @own_nick), clock + 1}
      end)

    {_, _} = Repo.insert_all(Message, rows)
    clock
  end

  @doc """
  Appends EXACTLY `n_to_add` rows to `(user_id, network_id)`, sampling
  targets from the bag. Returns the next clock. Exact rather than
  grow-to-total so axis B can hold the partition size perfectly still —
  a "within 2%" size axis is not a held axis.
  """
  @spec grow(Ecto.UUID.t(), integer(), sampler(), non_neg_integer(), integer()) :: integer()
  def grow(user_id, network_id, {bag, bag_size, _, peers, _}, n_to_add, clock) do
    now = DateTime.utc_now()
    :rand.seed(:exsss, {1, 2, 3 + clock})

    1..n_to_add//1
    |> Stream.chunk_every(2_000)
    |> Enum.reduce(clock, fn chunk, clock ->
      {rows, clock} =
        Enum.map_reduce(chunk, clock, fn _, clock ->
          sampled_row(
            elem(bag, :rand.uniform(bag_size) - 1),
            peers,
            clock,
            user_id,
            network_id,
            now
          )
        end)

      {_, _} = Repo.insert_all(Message, rows)
      clock
    end)
  end

  # One sampled row and the next clock. ~8% presence events on channel
  # targets, ~4% own-authored, DM targets always content kinds (a presence
  # event never carries `dm_with`).
  @spec sampled_row(target(), [String.t()], integer(), Ecto.UUID.t(), integer(), DateTime.t()) ::
          {map(), integer()}
  defp sampled_row(target, peers, clock, user_id, network_id, now) do
    roll = :rand.uniform(100)

    kind =
      cond do
        match?({:dm, _}, target) -> if roll <= 4, do: :action, else: :privmsg
        roll <= 8 -> Enum.random([:join, :part, :quit])
        roll <= 12 -> :action
        true -> :privmsg
      end

    sender = if roll <= 4, do: @own_nick, else: Enum.random(peers)

    {row(target, clock, user_id, network_id, kind, now, sender), clock + 1}
  end

  # Channel rows: dm_with = nil, channel FOLDED (the write-time rule).
  # DM rows (CP14 B3): inbound `channel = own_nick, dm_with = peer`,
  # outbound `channel = peer (folded), dm_with = peer`. `dm_with` is
  # stored RAW — that is what makes the #372 fold load-bearing, and what
  # lets the casing-variant control below have anything to collapse.
  @spec row(target(), integer(), Ecto.UUID.t(), integer(), atom(), DateTime.t(), String.t()) ::
          map()
  def row(target, clock, user_id, network_id, kind, now, sender_override) do
    shape =
      case target do
        {:chan, chan} ->
          %{channel: chan, dm_with: nil, sender: sender_override}

        {:dm, peer} ->
          if rem(clock, 2) == 0 do
            %{channel: @own_nick, dm_with: peer, sender: peer}
          else
            %{channel: Identifier.canonical_target(peer), dm_with: peer, sender: @own_nick}
          end
      end

    Map.merge(shape, %{
      user_id: user_id,
      visitor_id: nil,
      network_id: network_id,
      server_time: clock,
      kind: kind,
      body: "bench body #{clock}",
      meta: %{},
      inserted_at: now
    })
  end

  @doc """
  The PRE-#1626 query, transcribed verbatim from
  `origin/main:lib/grappa/scrollback.ex`'s `list_archive/3` — the same
  Ecto expression, through the same Ecto→SQL compiler.

  It is the BASELINE (what the change is measured against) and the
  correctness ORACLE (what the new answer must equal). It shares no code
  with the new implementation: this one groups in SQLite and leans on
  SQLite's bare-column rule for the display spelling; the new one seeks
  per target and folds in Elixir with `Enum.max_by/2`. Comparing the new
  function against a prototype that shared its implementation would
  prove nothing.
  """
  @spec legacy_query(Subject.t() | {:user, Ecto.UUID.t()}, integer()) :: Ecto.Query.t()
  def legacy_query(subject, network_id) do
    Message
    |> Subject.subject_where(subject)
    |> where([m], m.network_id == ^network_id)
    |> group_by([m], Identifier.nick_fold(fragment("COALESCE(?, ?)", m.dm_with, m.channel)))
    |> select([m], %{
      target: fragment("COALESCE(?, ?)", m.dm_with, m.channel),
      last_activity: max(m.server_time),
      row_count: count(m.id)
    })
  end
end

# ----------------------------------------------------------------------
# The arms
# ----------------------------------------------------------------------

# UNDER TEST — the production function, called the way the controller
# calls it.
current_fun = fn uid, nid -> Scrollback.list_archive({:user, uid}, nid, MapSet.new()) end

# BASELINE + ORACLE — the pre-#1626 shape, Elixir tail included.
legacy_fun = fn uid, nid ->
  {:user, uid}
  |> Bench.legacy_query(nid)
  |> Repo.all()
  |> Enum.reject(fn %{target: t} -> t == "$server" end)
  |> Enum.map(fn entry -> Map.put(entry, :kind, Scrollback.target_kind(entry.target)) end)
  |> Enum.sort_by(& &1.last_activity, :desc)
end

# The two answers differ by exactly one field, and that field IS the
# subject of the ruling — so the oracle comparison is on the three that
# survived. Dropping `row_count` here is not weakening the check: it is
# the whole content of the wire change, checked separately by the
# protocol tests.
oracle_shape = fn entries -> Enum.map(entries, &Map.drop(&1, [:row_count])) end

# RULER — a query whose cost is known to be partition-linear. If this
# does not grow with the partition, the instrument is not measuring size
# and no flat line elsewhere means anything.
ruler_sql = "SELECT count(*) FROM messages WHERE user_id = ?1 AND network_id = ?2"
ruler_fun = fn uid, nid -> Repo.query!(ruler_sql, [uid, nid], log: false) end

count_rows = fn uid, nid ->
  %Exqlite.Result{rows: [[n]]} = ruler_fun.(uid, nid)
  n
end

# DISCRIMINATION — the same grouping WITHOUT the #372 fold. On a corpus
# carrying casing variants it must answer DIFFERENTLY, or the row-for-row
# comparator cannot see a fold at all and its agreement is vacuous.
unfolded_sql = """
SELECT COALESCE(dm_with, channel), max(server_time)
  FROM messages
 WHERE user_id = ?1 AND network_id = ?2
 GROUP BY COALESCE(dm_with, channel)
"""

unfolded_fun = fn uid, nid ->
  %Exqlite.Result{rows: rows} = Repo.query!(unfolded_sql, [uid, nid], log: false)
  Enum.map(rows, fn [t, la] -> {t, la} end)
end

# ----------------------------------------------------------------------
# Control ledger — nothing prints until every entry is :ok
# ----------------------------------------------------------------------

{:ok, ledger} = Agent.start_link(fn -> [] end)
control = fn name, ok?, detail -> Agent.update(ledger, &[{name, ok?, detail} | &1]) end

# ----------------------------------------------------------------------
# Fixtures
# ----------------------------------------------------------------------

user =
  Repo.insert!(%Grappa.Accounts.User{
    name: "bench1626",
    password_hash: "x",
    inserted_at: DateTime.utc_now(),
    updated_at: DateTime.utc_now()
  })

mknet = fn slug ->
  Repo.insert!(%Grappa.Networks.Network{
    slug: slug,
    inserted_at: DateTime.utc_now(),
    updated_at: DateTime.utc_now()
  })
end

# ----------------------------------------------------------------------
# AXIS A — partition grows, target SET constant
# ----------------------------------------------------------------------

net_a = mknet.("bench-axis-a")
sampler_a = Bench.sampler(30, 146, ["debugserv", "DebugServ", "chanserv", "ChanServ"])
expected_a = Bench.expected_targets(sampler_a)

IO.puts("== building corpus (axis A, #{length(expected_a)} targets) — the slow part")

clock = Bench.seed_every_target(user.id, net_a.id, sampler_a, 1)

# `$server` is the pseudo-channel that must NEVER appear in an archive.
{1, _} =
  Repo.insert_all(Message, [
    Bench.row({:chan, "$server"}, clock, user.id, net_a.id, :server_event, DateTime.utc_now(), "-")
  ])

clock = clock + 1
seeded_a = clock - 1

{axis_a, _} =
  Enum.map_reduce(axis_a_sizes, {seeded_a, clock}, fn size, {have, clock} ->
    clock = Bench.grow(user.id, net_a.id, sampler_a, size - have, clock)
    n_rows = count_rows.(user.id, net_a.id)
    IO.puts("   .. #{n_rows} rows")

    legacy = Bench.time(fn -> legacy_fun.(user.id, net_a.id) end, 5)
    cur = Bench.time(fn -> current_fun.(user.id, net_a.id) end, 5)
    ruler = Bench.time(fn -> ruler_fun.(user.id, net_a.id) end, 5)

    entries = current_fun.(user.id, net_a.id)

    control.(
      "axis A @#{size}: list_archive/3 == the pre-#1626 answer, row for row",
      entries == oracle_shape.(legacy_fun.(user.id, net_a.id)),
      "row-for-row mismatch at partition size #{size}"
    )

    {{n_rows, length(entries), legacy, cur, ruler}, {size, clock}}
  end)

final_entries = current_fun.(user.id, net_a.id)
got_targets = final_entries |> Enum.map(&Identifier.canonical_target(&1.target)) |> Enum.sort()
want_targets = Enum.sort(expected_a)

# CONTROL (known answer): the corpus is built to hold exactly this folded
# target set, one seeded row each, so the listing must return it in full
# — minus `$server`, which is always excluded.
control.(
  "entry set == constructed target set (#{length(want_targets)} targets)",
  got_targets == want_targets,
  "missing=#{inspect(want_targets -- got_targets)} extra=#{inspect(got_targets -- want_targets)}"
)

# CONTROL (negative, known answer): a target that was never seeded must
# be ABSENT. Without this, "the set matches" could be true of a
# comparator that accepts anything.
control.(
  "a never-seeded target is absent",
  "#chan999" not in got_targets,
  "the listing returned a target the corpus never contained"
)

# CONTROL (known answer): `$server` was inserted and must not surface.
control.(
  "$server excluded from the listing",
  not Enum.any?(final_entries, &(&1.target == "$server")),
  "found $server in the listing"
)

# CONTROL (known answer): the two casing variants of one peer collapse to
# ONE entry — the #372 fold, which the loose scan does in Elixir now.
control.(
  "DebugServ/debugserv collapse to one entry",
  Enum.count(final_entries, &(Identifier.canonical_target(&1.target) == "debugserv")) == 1,
  "got #{Enum.count(final_entries, &(Identifier.canonical_target(&1.target) == "debugserv"))}"
)

# CONTROL (known answer): `active_keyset` still excludes, and it excludes
# on the FOLD of both sides — pass the target in a casing that appears
# nowhere in the corpus and the entry must still disappear, exactly one.
excluded = Scrollback.list_archive({:user, user.id}, net_a.id, MapSet.new(["DEBUGSERV"]))

control.(
  "active_keyset excludes on the fold (DEBUGSERV removes debugserv, and only it)",
  length(excluded) == length(final_entries) - 1 and
    not Enum.any?(excluded, &(Identifier.canonical_target(&1.target) == "debugserv")),
  "before=#{length(final_entries)} after=#{length(excluded)}"
)

# CONTROL (discrimination): the comparator must be ABLE to see a fold.
# The unfolded grouping answers differently on this corpus; if it did
# not, every agreement above would be vacuous.
control.(
  "comparator discriminates (the unfolded grouping answers differently)",
  length(unfolded_fun.(user.id, net_a.id)) != length(final_entries),
  "unfolded and folded set sizes are equal — the corpus carries no casing variant"
)

# CONTROL (precondition for the display-spelling comparison): the clock
# is strictly increasing, so no two rows share a `server_time`. That is
# what makes the oracle comparison legitimate on the `target` field —
# SQLite's bare-column rule picks an ARBITRARY row among ties, and
# `Enum.max_by/2` picks the first, so a tie would let the two disagree
# for a reason that is not a defect.
%Exqlite.Result{rows: [[dupes]]} =
  Repo.query!(
    "SELECT count(*) - count(DISTINCT server_time) FROM messages " <>
      "WHERE user_id = ?1 AND network_id = ?2",
    [user.id, net_a.id],
    log: false
  )

control.(
  "no two corpus rows share a server_time (no display-spelling tie)",
  dupes == 0,
  "#{dupes} duplicate server_time value(s) — the oracle comparison on `target` is not sound"
)

# The bar both instrument controls must clear: a partition-LINEAR cost
# should track the partition ratio, so a quarter of it is a generous
# floor that still cannot be cleared by noise. Derived from the axis
# rather than hardcoded, so shrinking the axis (smoke) relaxes it by the
# same amount it relaxes the evidence.
{rows_first, _, _, _, _} = List.first(axis_a)
{rows_last, _, _, _, _} = List.last(axis_a)
growth_floor = rows_last / rows_first / 4

# CONTROL (instrument, known answer #1): a query known to be
# partition-linear MUST grow with the partition on this instrument.
rulers = Enum.map(axis_a, fn {_, _, _, _, r} -> r end)

control.(
  "instrument sees size: the ruler count(*) grows >=x#{Float.round(growth_floor, 1)}",
  List.last(rulers) / List.first(rulers) >= growth_floor,
  "ruler medians (us): #{inspect(rulers)}"
)

# CONTROL (instrument, known answer #2 — the load-bearing one): the
# PRE-#1626 shape is partition-bound by construction, and must be
# visibly so in this very run. This is what turns the new arm's flat
# line into evidence instead of an artefact: same corpus, same pool,
# same timing code, one arm grows and one does not.
legacies = Enum.map(axis_a, fn {_, _, l, _, _} -> l end)

control.(
  "instrument sees size: the pre-#1626 shape grows >=x#{Float.round(growth_floor, 1)}",
  List.last(legacies) / List.first(legacies) >= growth_floor,
  "pre-1626 medians (us): #{inspect(legacies)}"
)

# ----------------------------------------------------------------------
# AXIS B — target count varies, partition size CONSTANT
# ----------------------------------------------------------------------

IO.puts("== building corpora (axis B, partition pinned at #{axis_b_rows})")

axis_b =
  for {n_chan, n_peer, slug} <- [
        {4, 16, "bench-b-20"},
        {30, 150, "bench-b-180"},
        {200, 800, "bench-b-1000"}
      ] do
    net = mknet.(slug)
    sampler = Bench.sampler(n_chan, n_peer, [])
    expected = Bench.expected_targets(sampler)

    clock = Bench.seed_every_target(user.id, net.id, sampler, 1)
    _ = Bench.grow(user.id, net.id, sampler, axis_b_rows - (clock - 1), clock)

    n_rows = count_rows.(user.id, net.id)
    IO.puts("   .. #{slug}: #{length(expected)} targets, #{n_rows} rows")

    legacy = Bench.time(fn -> legacy_fun.(user.id, net.id) end, 5)
    cur = Bench.time(fn -> current_fun.(user.id, net.id) end, 5)

    entries = current_fun.(user.id, net.id)
    got = entries |> Enum.map(&Identifier.canonical_target(&1.target)) |> Enum.sort()

    control.(
      "axis B #{slug}: entry set == constructed target set",
      got == Enum.sort(expected),
      "want=#{length(expected)} got=#{length(got)}"
    )

    control.(
      "axis B #{slug}: list_archive/3 == the pre-#1626 answer, row for row",
      entries == oracle_shape.(legacy_fun.(user.id, net.id)),
      "row-for-row mismatch"
    )

    control.(
      "axis B #{slug}: the partition is EXACTLY #{axis_b_rows} rows (size axis held still)",
      n_rows == axis_b_rows,
      "partition has #{n_rows} rows, not #{axis_b_rows} — the size axis moved under axis B"
    )

    {length(entries), n_rows, legacy, cur}
  end

# ----------------------------------------------------------------------
# EXPLAIN — off the SQL the PRODUCTION function actually emits (#1372)
# ----------------------------------------------------------------------

me = self()

:telemetry.attach(
  "bench-1626",
  [:grappa, :repo, :query],
  fn _, _, meta, _ -> send(me, {:sql, meta.query, meta.params}) end,
  nil
)

_ = current_fun.(user.id, net_a.id)
:telemetry.detach("bench-1626")

drain = fn drain, acc ->
  receive do
    {:sql, q, p} -> drain.(drain, [{q, p} | acc])
  after
    0 -> Enum.reverse(acc)
  end
end

emitted = Enum.filter(drain.(drain, []), fn {q, _} -> String.starts_with?(q, ["SELECT", "WITH"]) end)

# CONTROL (known answer): answering in ONE statement is part of the
# property, not a detail. Two statements under one snapshot would need a
# transaction; #1626 answers in one, so the plans below are the whole
# story rather than a sample of it.
control.(
  "production SQL captured from repo telemetry: exactly 1 statement",
  length(emitted) == 1,
  "captured #{length(emitted)} readable statement(s) — the plan below would be partial"
)

explain = fn sql, params ->
  %Exqlite.Result{rows: rows} = Repo.query!("EXPLAIN QUERY PLAN " <> sql, params, log: false)
  Enum.map_join(rows, "\n    ", fn row -> List.last(row) end)
end

after_plan =
  case emitted do
    [{sql, params}] -> explain.(sql, params)
    _ -> ""
  end

{legacy_sql, legacy_params} = Repo.to_sql(:all, Bench.legacy_query({:user, user.id}, net_a.id))
before_plan = explain.(legacy_sql, legacy_params)

# CONTROL (structural corroboration, known answer): the emitted plan must
# SEARCH the archive expression index. `messages_archive_user_idx`
# (`20260522073826`) is the index the loose scan seeks on; SQLite declines
# an expression index the moment the query's spelling of the expression
# drifts by one character, and it does so SILENTLY — the seek degrades to
# a scan and nothing fails. The timing would catch it, but only if
# somebody read the timing; this makes it a red.
control.(
  "the emitted plan seeks messages_archive_user_idx",
  String.contains?(after_plan, "messages_archive_user_idx"),
  "plan:\n    #{after_plan}"
)

# CONTROL (known answer, the other side): the PRE-#1626 plan must NOT be
# a per-target seek — it is the partition-visiting shape, and if the
# planner had already been seeking, there would have been nothing to fix.
control.(
  "the pre-#1626 plan visits the partition (SCAN or a full index walk)",
  not String.contains?(before_plan, "USING INDEX messages_archive_user_idx (") or
    String.contains?(before_plan, "SCAN"),
  "plan:\n    #{before_plan}"
)

# ----------------------------------------------------------------------
# GATE — no number is printed unless every control passed
# ----------------------------------------------------------------------

controls = ledger |> Agent.get(& &1) |> Enum.reverse()
failed = Enum.reject(controls, fn {_, ok?, _} -> ok? end)

if failed != [] do
  IO.puts("\n!! CONTROLS FAILED — no measurement printed")

  for {name, _, detail} <- failed do
    IO.puts("   FAIL #{name}\n        #{detail}")
  end

  IO.puts("\n   (#{length(controls) - length(failed)}/#{length(controls)} controls passed)")
  System.halt(1)
end

IO.puts("\n== CONTROLS: #{length(controls)}/#{length(controls)} passed")
for {name, _, _} <- controls, do: IO.puts("   ok  #{name}")

IO.puts("\n== AXIS A — partition size varies, target count HELD STILL")
IO.puts("rows      | targets | pre-1626 ms | list_archive/3 ms | ruler count(*) ms")

for {rows, n, legacy, cur, ruler} <- axis_a do
  IO.puts(
    "#{Bench.pad(rows, 9)} | #{Bench.pad(n, 7)} | #{Bench.pad(Bench.ms(legacy), 11)} | " <>
      "#{Bench.pad(Bench.ms(cur), 17)} | #{Bench.ms(ruler)}"
  )
end

IO.puts("\n== AXIS B — target count varies, partition size HELD STILL at #{axis_b_rows}")
IO.puts("targets   | rows    | pre-1626 ms | list_archive/3 ms")

for {n, rows, legacy, cur} <- axis_b do
  IO.puts(
    "#{Bench.pad(n, 9)} | #{Bench.pad(rows, 7)} | #{Bench.pad(Bench.ms(legacy), 11)} | " <>
      "#{Bench.ms(cur)}"
  )
end

# ----------------------------------------------------------------------
# VERDICT — the claim, computed from the numbers above
# ----------------------------------------------------------------------

{rows_lo, _, legacy_lo, cur_lo, ruler_lo} = List.first(axis_a)
{rows_hi, _, legacy_hi, cur_hi, ruler_hi} = List.last(axis_a)

{tgt_lo, _, legacy_b_lo, cur_b_lo} = List.first(axis_b)
{tgt_hi, _, legacy_b_hi, cur_b_hi} = List.last(axis_b)

IO.puts("\n== VERDICT")

IO.puts(
  "AXIS A  partition x#{Bench.ratio(rows_hi, rows_lo)} " <>
    "(#{rows_lo} -> #{rows_hi} rows, targets held):\n" <>
    "          pre-1626        x#{Bench.ratio(legacy_hi, legacy_lo)}   " <>
    "(#{Bench.ms(legacy_lo)} -> #{Bench.ms(legacy_hi)} ms)\n" <>
    "          ruler count(*)  x#{Bench.ratio(ruler_hi, ruler_lo)}   " <>
    "(#{Bench.ms(ruler_lo)} -> #{Bench.ms(ruler_hi)} ms)\n" <>
    "          list_archive/3  x#{Bench.ratio(cur_hi, cur_lo)}   " <>
    "(#{Bench.ms(cur_lo)} -> #{Bench.ms(cur_hi)} ms)"
)

IO.puts(
  "AXIS B  targets x#{Bench.ratio(tgt_hi, tgt_lo)} " <>
    "(#{tgt_lo} -> #{tgt_hi} targets, partition held at #{axis_b_rows}):\n" <>
    "          pre-1626        x#{Bench.ratio(legacy_b_hi, legacy_b_lo)}   " <>
    "(#{Bench.ms(legacy_b_lo)} -> #{Bench.ms(legacy_b_hi)} ms)\n" <>
    "          list_archive/3  x#{Bench.ratio(cur_b_hi, cur_b_lo)}   " <>
    "(#{Bench.ms(cur_b_lo)} -> #{Bench.ms(cur_b_hi)} ms)"
)

IO.puts(
  "\nThe claim is a DISPLACEMENT, and it needs both axes: the cost left\n" <>
    "the partition axis (A) and appeared on the target axis (B). Two arms\n" <>
    "that DO grow on axis A, in this same run, are what make the flat one\n" <>
    "a measurement rather than a blind instrument."
)

IO.puts("\n== EXPLAIN QUERY PLAN — AFTER (the SQL list_archive/3 emits)")
[{after_sql, _}] = emitted
IO.puts("-- statement:\n#{after_sql}")
IO.puts("-- plan:\n    #{after_plan}\n")

IO.puts("== EXPLAIN QUERY PLAN — BEFORE (the pre-#1626 shape)")
IO.puts("-- statement:\n#{legacy_sql}")
IO.puts("-- plan:\n    #{before_plan}")

IO.puts("\n== done")
