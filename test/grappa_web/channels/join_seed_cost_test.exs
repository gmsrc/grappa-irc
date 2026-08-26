defmodule GrappaWeb.JoinSeedCostTest do
  @moduledoc """
  #1759 — what the per-channel JOIN door costs the database, measured.

  The badge math has three doors. Two are bounded and one is not:

    * `/me` cold load → `WindowCounts.bulk_snapshot/4`, pinned at a CONSTANT
      2 queries for any window count (`WindowCountsTest`, #396);
    * the per-row push → `WindowCounts.Pusher.Coalescer`, O(distinct windows
      touched) per `window_ms` (#1768);
    * the per-channel join reply → `WindowCounts.snapshot/7` in full, once
      per join, behind neither of those.

  This file measures the third, which #1759 found unmeasured. It exists
  because a path read in the code says only that it EXISTS — never what it
  costs nor how many times it fires.

  What the measurement found was NOT what reading it suggested. The badge
  arithmetic was five of the eleven queries a live join cost; SIX were one
  `(subject, network)` pair resolved three times over in the same join.
  #1759 resolves it once (`channel_context/1`) and threads it, taking a join
  from 11 to 7. The tally below pins WHICH reads moved, so the win cannot be
  confused with a change to the arithmetic itself — and the law is unchanged:
  `11·W + 1` became `7·W + 1`, and W full snapshots are still W.

  ## Why the storm is the unit, not one join

  `cicchetto/src/lib/socket.ts` documents phoenix.js's behaviour on its
  `joinChannel` wrapper: `onJoinOk` *"fires on EVERY successful join — both
  the initial join and every auto-rejoin after a socket disconnect"*. A
  socket drop therefore re-joins every topic the client held, so the door
  fires W times at once for a W-window account — and it fires in the
  instant AFTER a saturation, which is when the pool has least to give.

  So the measurement moves W and reads the query count off it
  (displacement), rather than timing anything: a timing would measure this
  host's disk, while a count measures the fan-out that is the defect.

  ## The counter does NOT filter on `self()`

  `GrappaWeb.BootCostTest` filters its telemetry handler to the test pid,
  which is exact there because a controller runs inside the request that
  the test process drives. **Copied verbatim it would report zero here**:
  `Phoenix.ChannelTest.subscribe_and_join/3` runs `join/3` in the spawned
  CHANNEL process, so every query this file is about is emitted off the
  test pid. A filtered count would read `0` and be indistinguishable from
  "this door is already free", which is the exact false green the file
  exists to prevent. `async: false` is what buys the unfiltered count back:
  no sibling test is running to contaminate the mailbox.

  ## The storm arm measures a FLOOR, and says so

  With no live `Session.Server` there is no own nick, and
  `WindowCounts.count_mentions/6`'s `nil` clause then answers `0` without
  touching the database — so the cheap arm below is one `messages` read
  short of what a real socket pays. `a live session pays MORE` is the arm
  that closes that gap: it stands up the IRC fake so `Session.current_nick/2`
  answers, and pins the difference.

  The storm is then measured on that SAME live fixture at more than one W,
  never extrapolated from one: W windows on one network is ONE session, not
  W of them, so there was never a reason to measure the shape on the cheap
  bench and multiply. The cheap arm is kept only as the control that isolates
  which read the nil nick hides.
  """
  use GrappaWeb.ChannelCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Networks, Repo, ScrollbackHelpers, Session}
  alias Grappa.Networks.{Credentials, Servers}
  alias Grappa.PubSub.Topic
  alias GrappaWeb.UserSocket

  @query_event [:grappa, :repo, :query]

  describe "the per-channel join door" do
    test "the counter sees the join at all — the instrument's own control" do
      %{user_name: user_name, slug: slug, channels: [chan | _]} = account(1)

      {_, sources} = measure(fn -> join_topic(user_name, slug, chan) end)

      # The known-answer control, and the reason it is a test rather than a
      # comment: with the `self()` filter this file deliberately does NOT
      # use, every arm here would read zero and pass as "already free". So
      # the instrument is proven to see the door before any number it
      # produces is believed.
      assert "read_cursors" in sources and "messages" in sources, """
      the join did not reach `join_reply/2` — the counter is filtered, or the
      topic was rejected before the seed. A zero is an instrument fault, not
      a free door. See the moduledoc on the `self()` filter.
        sources: #{inspect(sources)}
      """
    end

    test "the storm cost MOVES with the number of windows — displacement, not correlation" do
      one = storm_cost(1)
      eight = storm_cost(8)

      # The claim under test is that the join door is the unbounded one. If
      # it were bounded like `/me`, these two would be equal.
      assert eight.total > one.total, """
      the join door did NOT scale with the window count, which contradicts
      reading `join_reply/2` as an uncoalesced per-window snapshot.
        W=1: #{one.total} #{inspect(one.sources)}
        W=8: #{eight.total} #{inspect(eight.sources)}
      """

      per_join = div(eight.total - one.total, 7)

      assert eight.total == one.total * 8, """
      DISPLACEMENT — the storm is linear in W at #{per_join} queries a join.
        W=1: #{one.total}
        W=8: #{eight.total}  (expected #{one.total * 8})
        per-join delta: #{per_join}
      Sources at W=1: #{inspect(one.sources)}
      """
    end

    test "a live session pays MORE — the cheap fixture's nil own_nick hides one read" do
      {irc, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      %{user: user, network: network, channels: [chan]} = account_with_session(port, 1)
      welcome(irc)

      {_, sources} = measure(fn -> join_topic(user.name, network.slug, chan) end)

      # The mention tail is the read the nil-nick clause skips. Its presence
      # here is what makes the cheap arm's number a FLOOR rather than the
      # cost: a real socket always has a nick.
      assert Enum.count(sources, &(&1 == "messages")) == 2, """
      expected the mention tail AND the split aggregate with a live nick.
        sources: #{inspect(sources)}
      """

      # Pinned as a TALLY, not an ordered list: the counter is unfiltered and
      # the session process emits into the same window, so arrival ORDER is a
      # race (measured — `network_credentials` moved from position 9 to
      # position 2 between two runs of this same test). The multiset is
      # deterministic; the sequence is not, and pinning the sequence would
      # have shipped a flake.
      #
      #   users/networks ×1  — the (subject, network) pair, resolved ONCE by
      #                        `channel_context/1` and threaded. Measured at
      #                        ×3 before #1759, when `canonicalize_topic`,
      #                        `join_reply` and `push_channel_snapshot` each
      #                        resolved it — half the door.
      #   read_cursors       — the cursor the snapshot counts from
      #   user_settings ×2   — highlight patterns, then the #505 presence
      #                        prefs. The lever #1768 named and left alone,
      #                        deliberately still here.
      #   messages ×2        — the split aggregate and the mention tail
      #   network_credentials— the fixture's own `mark_registered/1` on 001,
      #                        NOT part of the door: it does not scale with W
      #                        and drops out of `per_join_tally/3`.
      assert Enum.frequencies(sources) == %{
               "users" => 1,
               "networks" => 1,
               "read_cursors" => 1,
               "user_settings" => 2,
               "messages" => 2,
               "network_credentials" => 1
             }

      assert length(sources) == 8
    end

    test "the LIVE storm is linear in W — measured at three W, never extrapolated" do
      # Displacement on the fixture that pays the real per-join cost. Three
      # points, because two can be joined by any line and the claim is
      # linearity through the origin — that the door fires once per window
      # with no amortization between firings.
      {one, _} = w1 = live_storm(1)
      {four, _} = w4 = live_storm(4)
      {eight, _} = w8 = live_storm(8)

      # Three points, because two can be joined by any line. The claim is a
      # CONSTANT marginal cost — the door fires once per window with nothing
      # amortized between firings — so the two independent deltas must agree.
      low = per_join_tally(w4, w1, 3)
      high = per_join_tally(w8, w4, 4)

      assert low == high, """
      the marginal cost of a join is not constant across W.
        W=1→4: #{inspect(low)}
        W=4→8: #{inspect(high)}
        totals: #{one}, #{four}, #{eight}
      """

      # WHICH reads scale, named — not a bare total.
      #
      # THE DISPLACEMENT. Measured on this same harness at the same three W:
      #
      #   before: users 3, networks 3, read_cursors 1, user_settings 2,
      #           messages 2  =  11 a join   (totals 12, 45, 89)
      #   after:  users 1, networks 1, read_cursors 1, user_settings 2,
      #           messages 2  =   7 a join   (totals  8, 29, 57)
      #
      # Only the two reads the de-duplication touches moved, and by exactly
      # the two redundant resolutions removed. The arithmetic did not move,
      # which is the control: had the total dropped while `messages` changed
      # too, something other than the cause under test would have acted.
      assert high == %{
               "users" => 1,
               "networks" => 1,
               "read_cursors" => 1,
               "user_settings" => 2,
               "messages" => 2
             }

      assert Enum.sum(Map.values(high)) == 7
    end

    test "routing the join door through bulk_snapshot/4 does NOT fit — the 20% named" do
      # The first hypothesis, tested rather than argued: `/me` does this same
      # arithmetic for this same subject at a constant 2, so route the join
      # door there. The measurement below is why it is declined.
      #
      # `bulk_snapshot/4` amortizes ACROSS a subject's windows WITHIN ONE
      # CALL. The join door is W separate calls of ONE window each, so there
      # is nothing to amortize inside any of them — and each call does the
      # WHOLE account's arithmetic to keep one window's answer.
      %{subject: subject} = account(8)

      {answered, per_call} =
        measure(fn -> Grappa.WindowCounts.bulk_snapshot(subject, %{}, [], %{}) end)

      windows = answered |> Map.values() |> Enum.flat_map(&Map.keys/1)

      # Constant in queries, yes — but it answered for ALL EIGHT windows,
      # and a join needs one. There is no arity that asks it for one: the
      # whole-subject shape IS the primitive. Eight joins routed here would
      # each compute eight windows and discard seven.
      assert length(windows) == 8, """
      expected the whole-subject envelope; got #{inspect(windows)}
      """

      assert length(per_call) == 2, "bulk cost #{length(per_call)}: #{inspect(per_call)}"
    end

    test "the SAME account through the /me door costs 2, whatever W is" do
      # The positive control, and the reason the join number is a defect
      # rather than the intrinsic price of the arithmetic: the identical
      # per-window math for the identical subject is already available at a
      # constant two queries. Any per-join figure above that is the gap.
      %{subject: subject_one} = account(1)
      %{subject: subject_eight} = account(8)

      {_, one} = measure(fn -> Grappa.WindowCounts.bulk_snapshot(subject_one, %{}, [], %{}) end)
      {_, eight} = measure(fn -> Grappa.WindowCounts.bulk_snapshot(subject_eight, %{}, [], %{}) end)

      assert length(one) == 2, "W=1 bulk cost #{length(one)}: #{inspect(one)}"
      assert length(eight) == 2, "W=8 bulk cost #{length(eight)}: #{inspect(eight)}"
    end
  end

  # ---------------------------------------------------------------------------
  # Harness
  # ---------------------------------------------------------------------------

  # Joins every one of the account's channel topics, the way a phoenix.js
  # auto-rejoin does after a socket drop, and returns the total query count
  # plus the sources of the FIRST join (so a regression names the read).
  defp storm_cost(w) do
    %{user_name: user_name, slug: slug, channels: channels} = account(w)

    {_, sources} =
      measure(fn ->
        for chan <- channels, do: join_topic(user_name, slug, chan)
      end)

    %{total: length(sources), sources: Enum.take(sources, 12)}
  end

  defp join_topic(user_name, slug, chan) do
    {:ok, _, socket} =
      user_name
      |> build_socket()
      |> subscribe_and_join(Topic.channel(user_name, slug, chan), %{})

    socket
  end

  # `join_reply/1` resolves the subject from the user NAME, not from this
  # assign, so the generated subject here only has to satisfy the authz
  # check — the same shape `GrappaChannelPresenceParamsTest` uses.
  defp build_socket(user_name) do
    socket(UserSocket, "user_socket:#{user_name}", %{
      user_name: user_name,
      current_subject: {:user, Ecto.UUID.generate()},
      current_session_id: Ecto.UUID.generate(),
      socket_ref: Ecto.UUID.generate()
    })
  end

  # A subject on ONE network holding `w` channel windows, each with an
  # anchor row, a read cursor on it, and one unread row after it — so the
  # snapshot has real arithmetic to do rather than short-circuiting on an
  # empty window.
  defp account(w) do
    uniq = System.unique_integer([:positive])
    user_name = "join-cost-#{uniq}"
    user = user_fixture(name: user_name)
    subject = {:user, user.id}

    {:ok, network} = Networks.find_or_create_network(%{slug: "join-cost-#{uniq}"})

    channels =
      for i <- 1..w do
        chan = "#jc#{i}"
        {:ok, anchor} = row(user, network, chan, 1, "anchor")
        {:ok, _} = row(user, network, chan, 2, "unread")
        {:ok, _} = Grappa.ReadCursor.set(subject, network.id, chan, anchor.id)
        chan
      end

    %{user_name: user_name, subject: subject, slug: network.slug, channels: channels}
  end

  # A user + network with a LIVE `Session.Server` against the IRC fake, so
  # `Session.current_nick/2` answers and the mention tail is actually read.
  # Mirrors `GrappaWeb.GrappaChannelTest`'s session fixture, including its
  # `on_exit` teardown — without it the fake's shutdown drives a `:transient`
  # respawn that leaves an orphan in `SessionRegistry`.
  defp account_with_session(port, w) do
    uniq = System.unique_integer([:positive])
    user = user_fixture(name: "join-cost-live-#{uniq}")
    subject = {:user, user.id}

    {:ok, network} = Networks.find_or_create_network(%{slug: "join-cost-live-#{uniq}"})
    {:ok, _} = Servers.add_server(network, %{host: "127.0.0.1", port: port, tls: false})

    channels = for i <- 1..w, do: "#jc#{i}"

    {:ok, credential} =
      Credentials.bind_credential(user, network, %{
        nick: "grappa-jc",
        auth_method: :none,
        autojoin_channels: channels
      })

    {:ok, plan} = credential |> Repo.preload(:network) |> Networks.SessionPlan.resolve()
    {:ok, _} = Session.start_session(subject, network.id, plan)

    on_exit(fn -> Session.stop_session(subject, network.id) end)

    for chan <- channels do
      {:ok, anchor} = row(user, network, chan, 1, "anchor")
      {:ok, _} = row(user, network, chan, 2, "unread")
      {:ok, _} = Grappa.ReadCursor.set(subject, network.id, chan, anchor.id)
    end

    %{user: user, network: network, channels: channels}
  end

  # Registers the fake so `Session.current_nick/2` answers — without the 001
  # the session is still connecting and the nick is `{:error, :no_session}`,
  # which is exactly the degraded shape the cheap bench measures.
  defp welcome(irc) do
    :ok = IRCServer.await_handshake(irc, 1_000)
    IRCServer.feed(irc, ":irc.test.org 001 grappa-jc :Welcome\r\n")
  end

  # The live storm: one session, W channel topics re-joined the way a
  # phoenix.js auto-rejoin does. Returns `{total, tally}`.
  #
  # ## Why the caller must compare two W and never read one
  #
  # The counter is unfiltered (see the moduledoc), so it also catches the
  # SESSION process's own reads — `Networks.mark_registered/1` fires on the
  # 001 this fixture feeds, and whether that write lands inside or outside
  # the measured window is a race. Measured: it shifted `network_credentials`
  # from position 9 to position 2 between two runs of the same test, and it
  # is why the total is `11·W + 1` rather than `12·W`.
  #
  # A DELTA between two W cancels any such fixture-constant noise exactly,
  # and a tally is immune to the arrival ORDER that the cross-process race
  # scrambles. So both robustness problems are solved by the same move, and
  # neither is papered over with a retry or a sleep.
  defp live_storm(w) do
    {irc, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    %{user: user, network: network, channels: channels} = account_with_session(port, w)
    welcome(irc)

    {_, sources} =
      measure(fn ->
        for chan <- channels, do: join_topic(user.name, network.slug, chan)
      end)

    {length(sources), Enum.frequencies(sources)}
  end

  # The per-join cost, isolated: what `hi - lo` joins added, divided by how
  # many they were. Any read that does NOT scale with W cancels out and is
  # absent from the result — which is the point, and how the fixture's own
  # registration write disappears without being special-cased.
  defp per_join_tally({_, hi_tally}, {_, lo_tally}, joins) do
    hi_tally
    |> Map.merge(lo_tally, fn _source, hi, lo -> hi - lo end)
    |> Enum.reject(fn {_source, n} -> n == 0 end)
    |> Map.new(fn {source, n} -> {source, div(n, joins)} end)
  end

  defp row(user, network, chan, st, body) do
    ScrollbackHelpers.insert(%{
      user_id: user.id,
      network_id: network.id,
      channel: chan,
      server_time: 1_700_000_000_000 + st,
      kind: :privmsg,
      sender: "bob",
      body: body
    })
  end

  # Counts `[:grappa, :repo, :query]` emitted by ANY process while `fun`
  # runs. Unfiltered on purpose — see the moduledoc.
  defp measure(fun) do
    test_pid = self()
    ref = make_ref()
    handler_id = {__MODULE__, ref}

    :ok = :telemetry.attach(handler_id, @query_event, &__MODULE__.forward_query/4, {test_pid, ref})

    try do
      result = fun.()
      {result, drain(ref, [])}
    after
      :telemetry.detach(handler_id)
    end
  end

  @doc false
  @spec forward_query([atom()], map(), map(), {pid(), reference()}) :: :ok
  def forward_query(_, _, metadata, {test_pid, ref}) do
    send(test_pid, {ref, Map.get(metadata, :source)})
    :ok
  end

  defp drain(ref, acc) do
    receive do
      {^ref, source} -> drain(ref, [source | acc])
    after
      20 -> Enum.reverse(acc)
    end
  end
end
