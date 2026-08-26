# Bench for #1767 — does a dirty SQLite NIF parked on a contended write
# lock actually block `:persistent_term.put/2` in this file's topology?
#
#   ./scripts/mix.sh --env=dev run --no-start test/bench_1767.exs
#
# WHY THIS EXISTS. `lock_watch_test.exs` calls `LockWatch.put_test_enabled/1`
# — which is `:persistent_term.put/2` (`lock_watch.ex:392`) — in `setup` AND
# in `on_exit`, once per test, in the one file whose whole purpose is parking
# a writer on a contended `BEGIN IMMEDIATE`. CLAUDE.md's #1715 entry says a
# dirty NIF parked on a SQLite write-lock blocks EVERY `persistent_term`
# write for the whole wait, word-sized ones included — and says in the same
# breath that the mechanism was measured in the field and NEVER reproduced on
# a bench, with its final causal link INFERRED. This is that bench.
#
# It is a falsification attempt, not a demonstration: a null result kills the
# hypothesis that #1767's missing time sits in those two puts, and that is
# worth as much as a positive.
#
# EVERY NUMBER IS GATED on known-answer controls. Nothing prints if one fails.

db = "/tmp/bench_1767.db"
for suffix <- ["", "-wal", "-shm"], do: File.rm(db <> suffix)

{:ok, _} = Application.ensure_all_started(:ecto_sql)
{:ok, _} = Application.ensure_all_started(:exqlite)

defmodule TmpRepo do
  @moduledoc false
  use Ecto.Repo, otp_app: :grappa, adapter: Ecto.Adapters.SQLite3
end

# The same shape `lock_watch_test.exs` builds: pool_size 2 so two writers can
# genuinely contend, and a busy_timeout long enough that the waiter is still
# WAITING while we measure rather than erroring out.
busy_timeout_ms = 20_000

{:ok, _} =
  TmpRepo.start_link(
    database: db,
    pool_size: 2,
    busy_timeout: busy_timeout_ms,
    journal_mode: :wal,
    log: false
  )

TmpRepo.query!("CREATE TABLE t(id integer)")

parent = self()

# A writer that takes RESERVED and parks, exactly like the test file's
# `unobserved_write/2`: `timeout: :infinity` so the pool's 15s checkout
# deadline is not the thing we end up measuring.
park = fn id ->
  spawn(fn ->
    TmpRepo.transaction(
      fn ->
        TmpRepo.query!("INSERT INTO t VALUES (?)", [id], log: false)
        send(parent, {:holding, self()})

        receive do
          :release -> :ok
        end
      end,
      mode: :immediate,
      timeout: :infinity
    )
  end)
end

# A writer that just tries to BEGIN IMMEDIATE and therefore parks INSIDE the
# dirty NIF on SQLite's busy handler. It never reports, by construction —
# that silence is what the control below checks.
contend = fn id ->
  spawn(fn ->
    TmpRepo.transaction(
      fn ->
        TmpRepo.query!("INSERT INTO t VALUES (?)", [id], log: false)
        send(parent, {:got_through, self()})
      end,
      mode: :immediate,
      timeout: :infinity
    )
  end)
end

# `put` a WORD-SIZED value: CLAUDE.md singles those out as the surprising
# case, because they trigger no global GC of their own and the shipped docs
# do not lead you to expect them to queue behind somebody else's.
time_puts = fn label, n ->
  us =
    for i <- 1..n do
      key = {:bench_1767, label, i}
      {t, :ok} = :timer.tc(fn -> :persistent_term.put(key, i) end)
      :persistent_term.erase(key)
      t
    end

  %{label: label, max_us: Enum.max(us), median_us: Enum.at(Enum.sort(us), div(n, 2))}
end

{:ok, ledger} = Agent.start_link(fn -> [] end)
control = fn name, ok?, detail -> Agent.update(ledger, &[{name, ok?, detail} | &1]) end

# ── BASELINE: no contention at all ───────────────────────────────────
baseline = time_puts.(:baseline, 20)

# ── CONTENDED: one holder parked, one writer inside the busy handler ──
holder = park.(1)

holder_ok? =
  receive do
    {:holding, ^holder} -> true
  after
    5_000 -> false
  end

control.("the holder took RESERVED and parked", holder_ok?, "no {:holding, holder} within 5s")

waiter = contend.(2)

# Give the waiter time to reach BEGIN IMMEDIATE and enter the busy handler.
Process.sleep(500)

# CONTROL (known answer): the waiter must still be BLOCKED. If it got
# through, there is no contention and every number below measures nothing.
got_through? =
  receive do
    {:got_through, ^waiter} -> true
  after
    0 -> false
  end

control.(
  "the waiter is still blocked in BEGIN IMMEDIATE",
  not got_through?,
  "the waiter got through — no contention was measured"
)

# CONTROL (known answer): and it must be alive to be blocked.
control.("the waiter process is alive", Process.alive?(waiter), "the waiter died instead of waiting")

contended = time_puts.(:contended, 20)

# ── RELEASE and re-measure: the recovery is what makes it causal ──────
send(holder, :release)

drained? =
  receive do
    {:got_through, ^waiter} -> true
  after
    busy_timeout_ms -> false
  end

control.("releasing the holder let the waiter through", drained?, "the waiter never got through after release")

after_release = time_puts.(:after_release, 20)

# CONTROL (instrument): the timer must be able to see a delay at all.
{slow_us, _} = :timer.tc(fn -> Process.sleep(50) end)
control.("the timer can see a 50ms delay", slow_us > 40_000, "timer read #{slow_us}us for a 50ms sleep")

controls = ledger |> Agent.get(& &1) |> Enum.reverse()
failed = Enum.reject(controls, fn {_, ok?, _} -> ok? end)

if failed != [] do
  IO.puts("\n!! CONTROLS FAILED — no measurement printed")
  for {name, _, detail} <- failed, do: IO.puts("   FAIL #{name}\n        #{detail}")
  System.halt(1)
end

IO.puts("\n== CONTROLS: #{length(controls)}/#{length(controls)} passed")
for {name, _, _} <- controls, do: IO.puts("   ok  #{name}")

IO.puts("\n== :persistent_term.put/2, 20 word-sized puts per phase")
IO.puts("phase          | median us | max us")

for m <- [baseline, contended, after_release] do
  IO.puts(
    "#{String.pad_trailing(to_string(m.label), 14)} | " <>
      "#{String.pad_trailing(to_string(m.median_us), 9)} | #{m.max_us}"
  )
end

IO.puts("\n== VERDICT")

# The bar is NOT a multiple of the idle cost. A ratio between microsecond
# quantities is noise with an opinion: 5us -> 385us is 77x and explains
# nothing. The hypothesis under test is that these puts hold the tens of
# SECONDS #1767 cannot account for, so the comparison has to be against the
# WAIT the put is supposed to be trapped behind.
wait_us = busy_timeout_ms * 1000
holds_the_wait? = contended.max_us > div(wait_us, 2)
measurable_tail? = contended.max_us > 10 * max(baseline.max_us, 1)

IO.puts(
  cond do
    holds_the_wait? ->
      "BLOCKS FOR THE WAIT: worst contended put #{contended.max_us}us against a " <>
        "#{wait_us}us busy_timeout — a put really is trapped behind the parked NIF."

    measurable_tail? ->
      "TAIL, NOT A BLOCK: worst contended put #{contended.max_us}us vs #{baseline.max_us}us " <>
        "idle — a real contention-correlated tail, and #{Float.round(contended.max_us / wait_us * 100, 4)}% " <>
        "of the #{div(wait_us, 1000)}ms wait it would have to hold.\n" <>
        "REFUTES the hypothesis that #1767's missing tens of seconds sit in these puts.\n" <>
        "It does NOT refute #1715, whose field mechanism was a COMMIT and not a busy-handler wait."

    true ->
      "NOT BLOCKED: worst contended put #{contended.max_us}us vs #{baseline.max_us}us idle,\n" <>
        "no contention-correlated tail at all."
  end
)

IO.puts("\n== done")
