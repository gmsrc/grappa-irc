defmodule Grappa.NickMigrationTest do
  @moduledoc """
  #1378 — the nick-rename migration set must not take SQLite's write lock to
  migrate nothing.

  ## The oracle, and why it is a savepoint and not `BEGIN IMMEDIATE`

  `Grappa.Repo.TransactionModeGateTest` establishes that the transaction MODE
  is undecidable at runtime: under the SQL Sandbox every test already runs
  inside a transaction, so `exqlite` collapses every mode to
  `SAVEPOINT exqlite_savepoint`. That argument does not reach THIS defect.
  Whether a transaction is opened AT ALL is perfectly decidable — the
  savepoint statement is emitted or it is not — and it is the same statement
  that, unsandboxed, is the `BEGIN IMMEDIATE` that took the lock. So the
  oracle counts transaction-control statements off Ecto's own query
  telemetry, and reads a savepoint as the sandbox's image of the write lock.

  The e2e half of the proof (the `busy_locked` fault disappearing from
  `issue458-presence-page-yield` under load) lives where load exists; this
  file owns the decision, deterministically and with no IRC in sight.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{NickMigration, QueryWindows, Scrollback, UserSettings}
  alias Grappa.IRC.Identifier

  # Every SQL statement Ecto reports while `fun` runs, lowercased. `async:
  # false` because the handler is global: a concurrent test's queries would
  # land in this list and the counts below would stop meaning anything.
  defp capture_sql(fun) do
    ref = make_ref()
    test = self()

    :telemetry.attach(
      "nm-sql-#{inspect(ref)}",
      [:grappa, :repo, :query],
      fn _, _, %{query: query}, _ -> send(test, {ref, String.downcase(query)}) end,
      nil
    )

    try do
      fun.()
    after
      :telemetry.detach("nm-sql-#{inspect(ref)}")
    end

    drain(ref, [])
  end

  defp drain(ref, acc) do
    receive do
      {^ref, query} -> drain(ref, [query | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  defp transaction_statements(queries) do
    Enum.filter(queries, &(&1 =~ "savepoint" or String.starts_with?(&1, "begin")))
  end

  describe "peer_renamed/5 opens no transaction when there is nothing to migrate" do
    test "a peer with no query window and no mute costs zero transaction statements" do
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}

      queries =
        capture_sql(fn ->
          assert {:ok, %{window: :noop, rows: 0, mute: :noop}} =
                   NickMigration.peer_renamed(subject, net.id, net.slug, "oldnick", "newnick")
        end)

      assert transaction_statements(queries) == [],
             "a rename with nothing to move opened a write transaction: " <>
               inspect(transaction_statements(queries))
    end

    test "the probe is the only reason it is cheap — a peer WITH a window still transacts" do
      # The complement, and the assertion that stops the fix from degrading
      # into "never transact": the real migration path must keep its
      # transaction, which is the whole atomicity contract.
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}
      {:ok, _} = QueryWindows.open(subject, net.id, "oldnick", user.name)

      queries =
        capture_sql(fn ->
          assert {:ok, %{window: :renamed}} =
                   NickMigration.peer_renamed(subject, net.id, net.slug, "oldnick", "newnick")
        end)

      refute transaction_statements(queries) == [],
             "the migration path lost its transaction"
    end
  end

  describe "peer_renamed/5 still migrates everything it used to" do
    test "a windowed peer moves window, DM history and cursor together" do
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}
      {:ok, _} = QueryWindows.open(subject, net.id, "oldnick", user.name)

      {:ok, _} =
        Scrollback.persist_event(%{
          network_id: net.id,
          user_id: user.id,
          channel: "oldnick",
          dm_with: "oldnick",
          server_time: System.system_time(:millisecond),
          kind: :privmsg,
          sender: "oldnick",
          body: "before the rename"
        })

      assert {:ok, %{window: :renamed, rows: rows}} =
               NickMigration.peer_renamed(subject, net.id, net.slug, "oldnick", "newnick")

      assert rows >= 1
      assert QueryWindows.exists?(subject, net.id, "newnick")
      refute QueryWindows.exists?(subject, net.id, "oldnick")
    end

    test "a windowless peer's MUTE still follows — the store that outlives the window" do
      # The reason the no-transaction path is not simply an early return: with
      # no window the mute is the one store that can still move, and #1340
      # migrates it UNCONDITIONALLY because a mute outlives the window it
      # silenced. A fix that skipped the whole call when no window exists
      # would strand exactly the mute nobody can see to fix.
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}
      old_key = Identifier.channel_key(net.slug, "oldnick")
      new_key = Identifier.channel_key(net.slug, "newnick")

      prefs = UserSettings.default_notification_prefs()

      {:ok, _} =
        UserSettings.put_notification_prefs(subject, %{
          prefs
          | muted_targets: %{old_key => %{"until" => nil}}
        })

      assert {:ok, %{window: :noop, mute: :renamed}} =
               NickMigration.peer_renamed(subject, net.id, net.slug, "oldnick", "newnick")

      # `get_notification_prefs/1` closes over ATOM keys — `merge_with_defaults/1`
      # rebuilds the map rather than returning the stored blob — so reaching for
      # the string key here silently reads `nil` off a map that does have the
      # mute. Asked with the string key, this assertion could only ever crash.
      muted = UserSettings.get_notification_prefs(subject).muted_targets
      assert Map.has_key?(muted, new_key)
      refute Map.has_key?(muted, old_key)
    end
  end
end
