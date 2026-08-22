defmodule Grappa.ScrollbackTelemetryTest do
  @moduledoc """
  #357 Deliverable 1 — write-latency telemetry on the scrollback insert path.

  Two signals, both proving the mechanisms the issue traced:

    * `[:grappa, :scrollback, :persist, :start | :stop]` — a `:telemetry.span`
      around `persist_event/1`'s insert, tagged by `channel` so the
      per-channel insert latency (mechanism 3, index write-amplification) is
      correlatable against a channel's inbound msg/s. This is ALSO the "pure
      insert" half of the split-span pair (the other half is the send-path
      span on `Grappa.Session.send_privmsg/4`); the gap between the two is
      the mailbox head-of-line blocking (mechanism 1).

    * `[:grappa, :scrollback, :persist, :contention]` — emitted from
      `with_pool_retry/1` on each transient busy/locked/queue_timeout fault,
      surfacing SQLite single-writer contention (mechanism 2) as telemetry
      rather than only a log grep.

  `async: false` for the same reason as `Grappa.ScrollbackTest`: the
  credential-less write path is the heaviest in the suite; serializing dodges
  busy_timeout collisions under `max_cases`.
  """
  use Grappa.DataCase, async: false

  alias Grappa.{Accounts, Networks, Scrollback}
  alias Grappa.IRC.Identifier

  setup do
    {:ok, user} = Accounts.create_user(%{name: "vjt-#{uniq()}", password: "correct horse battery"})
    {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra-#{uniq()}"})
    %{user: user, network: network}
  end

  defp uniq, do: System.unique_integer([:positive])

  # Attach a forwarding handler for `events`; auto-detached on test exit.
  defp attach(events) do
    handler_id = {__MODULE__, System.unique_integer([:positive])}
    test_pid = self()

    :telemetry.attach_many(
      handler_id,
      events,
      fn event, measurements, metadata, _ ->
        send(test_pid, {:telemetry, event, measurements, metadata})
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler_id) end)
    :ok
  end

  defp valid_attrs(user, network, overrides) do
    Map.merge(
      %{
        user_id: user.id,
        network_id: network.id,
        channel: "#sniffo",
        server_time: 0,
        kind: :privmsg,
        sender: "vjt",
        body: "ciao",
        meta: %{}
      },
      overrides
    )
  end

  describe "persist_event/1 span — [:grappa, :scrollback, :persist, *]" do
    test "a successful insert emits :stop tagged by channel/kind/network_id with outcome: :ok",
         %{user: user, network: net} do
      attach([[:grappa, :scrollback, :persist, :stop]])

      assert {:ok, _} = Scrollback.persist_event(valid_attrs(user, net, %{}))

      assert_receive {:telemetry, [:grappa, :scrollback, :persist, :stop], measurements, metadata}
      # Channel is stored canonical (ASCII fold) — the tag matches storage.
      assert metadata.channel == Identifier.canonical_target("#sniffo")
      assert metadata.kind == :privmsg
      assert metadata.network_id == net.id
      assert metadata.subject == :user
      assert metadata.outcome == :ok
      # The span measures wall-clock insert time — a real, non-negative span.
      assert is_integer(measurements.duration) and measurements.duration >= 0
    end

    test "a validation failure still emits :stop with outcome: :validation_error",
         %{user: user, network: net} do
      attach([[:grappa, :scrollback, :persist, :stop]])

      # :privmsg requires a non-nil body — body: nil is a changeset error,
      # not a raise: the span must still close, tagged as such.
      assert {:error, %Ecto.Changeset{}} =
               Scrollback.persist_event(valid_attrs(user, net, %{body: nil}))

      assert_receive {:telemetry, [:grappa, :scrollback, :persist, :stop], _m, metadata}
      assert metadata.outcome == :validation_error
      assert metadata.channel == Identifier.canonical_target("#sniffo")
    end

    test "the :start event fires before the insert with the same channel tag",
         %{user: user, network: net} do
      attach([[:grappa, :scrollback, :persist, :start]])

      assert {:ok, _} = Scrollback.persist_event(valid_attrs(user, net, %{}))

      assert_receive {:telemetry, [:grappa, :scrollback, :persist, :start], _m, metadata}
      assert metadata.channel == Identifier.canonical_target("#sniffo")
      assert metadata.kind == :privmsg
    end
  end

  describe "with_pool_retry/1 contention — [:grappa, :scrollback, :persist, :contention]" do
    defp raise_busy, do: raise(%Exqlite.Error{message: "database is locked", statement: nil})

    defp raise_queue_timeout do
      raise %DBConnection.ConnectionError{
        message: "connection not available and request was dropped from queue after 186ms",
        reason: :queue_timeout
      }
    end

    test "a transient busy fault that clears within budget emits contention fault: :busy_locked, dropped: false" do
      attach([[:grappa, :scrollback, :persist, :contention]])
      {:ok, counter} = Agent.start_link(fn -> 0 end)

      op = fn ->
        n = Agent.get_and_update(counter, fn n -> {n, n + 1} end)
        if n < 1, do: raise_busy(), else: {:ok, :served}
      end

      assert {:ok, :served} = Scrollback.with_pool_retry(op)

      assert_receive {:telemetry, [:grappa, :scrollback, :persist, :contention], measurements, metadata}

      assert metadata.fault == :busy_locked
      assert metadata.dropped == false
      assert measurements.attempt == 1
    end

    # #523 — with_pool_retry now delegates to `Grappa.Repo.BusyRetry`, passing
    # `&Telemetry.contention/3` as the engine's `:on_contention` observer. This
    # locks that the shipped #357 counters keep INCREMENTING once per ridden-out
    # attempt — proof the delegation did not silently mutilate the telemetry (a
    # green suite alone would only prove the RETURN behaviour survived).
    test "each ridden-out transient attempt emits its own contention event with an INCREMENTING attempt" do
      attach([[:grappa, :scrollback, :persist, :contention]])
      {:ok, counter} = Agent.start_link(fn -> 0 end)

      op = fn ->
        n = Agent.get_and_update(counter, fn n -> {n, n + 1} end)
        if n < 3, do: raise_busy(), else: {:ok, :served}
      end

      assert {:ok, :served} = Scrollback.with_pool_retry(op)

      # Three raises → three contention events, attempts 1, 2, 3, all
      # dropped: false. The counters advance per attempt, never stall.
      for expected <- 1..3 do
        assert_receive {:telemetry, [:grappa, :scrollback, :persist, :contention], %{attempt: ^expected},
                        %{fault: :busy_locked, dropped: false}}
      end
    end

    test "a queue_timeout sustained past the budget emits contention dropped: true, fault: :queue_timeout" do
      attach([[:grappa, :scrollback, :persist, :contention]])

      assert {:error, :persist_unavailable} =
               Scrollback.with_pool_retry(fn -> raise_queue_timeout() end)

      # Drain to the terminal (dropped: true) contention event.
      assert_receive {:telemetry, [:grappa, :scrollback, :persist, :contention], _m,
                      %{fault: :queue_timeout, dropped: true}},
                     3_000
    end

    test "a non-transient syntax error emits NO contention event (not mechanism 2)" do
      attach([[:grappa, :scrollback, :persist, :contention]])

      assert {:error, :persist_unavailable} =
               Scrollback.with_pool_retry(fn ->
                 raise %Exqlite.Error{message: "near \"SLECT\": syntax error", statement: nil}
               end)

      refute_receive {:telemetry, [:grappa, :scrollback, :persist, :contention], _m, _meta}, 100
    end
  end
end
