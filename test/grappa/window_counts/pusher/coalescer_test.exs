defmodule Grappa.WindowCounts.Pusher.CoalescerTest do
  @moduledoc """
  #1768 — a burst of persisted rows in ONE window must cost ONE snapshot,
  not one per row.

  ## What is asserted, and what is deliberately not

  The oracle is the NUMBER of `window_counts` broadcasts, because that is
  one-to-one with the number of snapshot tasks: `Pusher.emit/1` broadcasts
  exactly once per invocation, and the flush is the only thing that
  invokes it. A timing assertion ("the burst finishes faster") would be a
  flake wearing a performance costume — nothing here measures duration.

  The second test is the anti-over-coalescing guard: collapsing every
  window of a subject into one snapshot would satisfy the first test and
  be a correctness regression, since the payload is per-channel and each
  channel's subscribers get their own topic.

  The third covers the half the first two cannot see. "At most one emit
  per window" is satisfied by a resetting DEBOUNCE as well, and a debounce
  emits nothing at all while rows keep arriving faster than the window —
  which is the regime the whole change exists for. So the third test keeps
  the arrivals coming and asserts an emit lands anyway. Verified by
  mutation: turning `arm/3` into a resetting debounce leaves the first two
  green and takes only this one red.

  ## Why the setup carries no race

  Every row is inserted BEFORE the first push, so the counts the flush
  reads are already final and the assertion never depends on an insert
  winning a race against the coalescing window. The only thing the pushes
  race is the window itself, and they are `GenServer.cast/2` calls issued
  back to back — microseconds against `Coalescer.window_ms/0`.

  `async: false` — touches the `Grappa.WSPresence` singleton and the
  node-wide `Coalescer`, and its flush queries the Repo from a task that
  needs the shared sandbox the async:false lane provides (same stance as
  `Grappa.WindowCounts.PusherTest`).
  """
  use Grappa.DataCase, async: false

  alias Grappa.{AuthFixtures, ScrollbackHelpers, WSPresence}
  alias Grappa.PubSub.Topic
  alias Grappa.WindowCounts.Pusher
  alias Grappa.WindowCounts.Pusher.Coalescer

  @burst 10
  @own_nick "vjt"
  @peer "alice"

  # Four windows: long enough that the one coalesced emit (armed at the
  # first touch, fired one window later) has certainly landed, and that an
  # UNcoalesced burst — which emits immediately, per row — would have
  # delivered every one of its broadcasts. Derived from the production
  # constant rather than restated, so retuning the window cannot silently
  # turn this into a test of nothing.
  @drain_ms Coalescer.window_ms() * 4

  setup do
    user = AuthFixtures.user_fixture()
    network = AuthFixtures.network_fixture()

    :ok = WSPresence.reset_for_test()
    :ok = WSPresence.register(user.name, self())
    on_exit(fn -> WSPresence.reset_for_test() end)

    %{user: user, network: network, subject: {:user, user.id}, label: user.name}
  end

  test "a burst in ONE window produces one snapshot carrying the final counts", ctx do
    subscribe(ctx, "#chan")
    for _ <- 1..@burst, do: insert(ctx, "#chan")

    for _ <- 1..@burst, do: push(ctx, "#chan")

    assert [
             %{
               kind: :window_counts,
               channel: "#chan",
               messages: @burst,
               mentions: 0,
               events: 0,
               severity: :message
             }
           ] = drain()
  end

  test "two windows in the same burst coalesce SEPARATELY — one snapshot each", ctx do
    subscribe(ctx, "#one")
    subscribe(ctx, "#two")

    for _ <- 1..@burst do
      insert(ctx, "#one")
      insert(ctx, "#two")
    end

    for _ <- 1..@burst do
      push(ctx, "#one")
      push(ctx, "#two")
    end

    payloads = drain()

    assert Enum.sort(Enum.map(payloads, & &1.channel)) == ["#one", "#two"]
    assert Enum.all?(payloads, &(&1.messages == @burst))
  end

  test "arrivals faster than the window still emit — a throttle, not a debounce", ctx do
    subscribe(ctx, "#chan")
    insert(ctx, "#chan")

    window = Coalescer.window_ms()

    # Feeds for THREE windows at one push every fifth of a window, so the
    # arrivals never stop while the assertion below is waiting.
    {feeder, ref} =
      spawn_monitor(fn ->
        feed_until(ctx, "#chan", System.monotonic_time(:millisecond) + window * 3, div(window, 5))
      end)

    # The discriminator. A debounce restarts its timer on every arrival and
    # so emits NOTHING before the feeder stops — not before three windows.
    # The armed-once flush lands one window in, and the budget here is two,
    # so the two designs are separated by a whole window rather than by a
    # margin. This is the "at least one emit within `window_ms/0` of any
    # arrival" half of the contract; the other tests only pin "at most one".
    assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :window_counts}}, window * 2

    # Let the feeder retire and its last flush land before the test ends,
    # so nothing from this window leaks into the next test's sandbox.
    assert_receive {:DOWN, ^ref, :process, ^feeder, :normal}, window * 8
    drain()
  end

  defp feed_until(ctx, channel, deadline, gap_ms) do
    if System.monotonic_time(:millisecond) < deadline do
      push(ctx, channel)
      Process.sleep(gap_ms)
      feed_until(ctx, channel, deadline, gap_ms)
    end
  end

  defp subscribe(ctx, channel) do
    :ok =
      Phoenix.PubSub.subscribe(
        Grappa.PubSub,
        Topic.channel(ctx.label, ctx.network.slug, channel)
      )
  end

  defp insert(ctx, channel) do
    {:ok, message} =
      ScrollbackHelpers.insert(%{
        user_id: ctx.user.id,
        network_id: ctx.network.id,
        channel: channel,
        server_time: System.unique_integer([:positive]),
        kind: :privmsg,
        sender: @peer,
        body: "hi"
      })

    message
  end

  defp push(ctx, channel) do
    :ok =
      Pusher.push(%{
        subject: ctx.subject,
        network_id: ctx.network.id,
        network_slug: ctx.network.slug,
        subject_label: ctx.label,
        channel: channel,
        own_nick: @own_nick
      })
  end

  # Every `window_counts` payload that lands before the deadline, in
  # arrival order. A deadline (not a per-message timeout) so the whole
  # drain is bounded by `@drain_ms` however many payloads arrive.
  defp drain, do: collect(System.monotonic_time(:millisecond) + @drain_ms)

  defp collect(deadline) do
    remaining = deadline - System.monotonic_time(:millisecond)

    if remaining <= 0 do
      []
    else
      receive do
        %Phoenix.Socket.Broadcast{payload: %{kind: :window_counts} = payload} ->
          [payload | collect(deadline)]
      after
        remaining -> []
      end
    end
  end
end
