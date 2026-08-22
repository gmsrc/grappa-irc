defmodule GrappaWeb.BootCostTest do
  @moduledoc """
  #1679 — what a cold boot costs the DATABASE, measured rather than derived.

  The issue measures the boot burst in HTTP requests (`1 + N + (1..3)·C`) and
  says of the fix that "the single round trip must not become an N+1
  underneath". That requirement is only checkable against a number, so this
  file executes the boot sequence and counts `[:grappa, :repo, :query]`.

  Counted in the TEST process with a `self()` filter, the shape
  `Grappa.Session.RefreshPlanCostTest` established: telemetry handlers run in
  the emitting process and Ecto emits synchronously, so the filter is exact
  and the mailbox is complete the moment the request returns. That is also
  what makes the file `async: true`-safe.

  Two halves:

    * `the boot sequence as it exists today` — the BASELINE, pinned so the
      win is a measured delta and not a claim. Measured `11 + 5N` queries
      over `2 + N` requests.
    * `GET /boot` — the N+1 pin. The count must be INVARIANT under account
      size, on BOTH axes (networks and channels). A pinned ordered source
      list rather than a bare total, so a regression says WHICH read
      appeared.

  The invariance assertion is the whole point of the file: an endpoint that
  answers in one round trip while issuing one query per network has moved
  the thundering herd from the proxy to SQLite and bought nothing.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  @query_event [:grappa, :repo, :query]

  describe "the boot sequence as it exists today" do
    test "costs 11 + 5N queries across 2 + N requests — the baseline the fix is measured against" do
      one = today_boot_cost(1, 3)
      four = today_boot_cost(4, 3)

      assert one.requests == 3
      assert four.requests == 6

      # Per-request: /me and /networks are already constant in N; only the
      # per-network channel call scales, at five queries a network (two of
      # them the bearer plug's `sessions` + `users`, paid once per request).
      assert one.me == 7
      assert four.me == 7
      assert one.networks == 4
      assert four.networks == 4
      assert one.channels_each == [5]
      assert four.channels_each == [5, 5, 5, 5]

      assert one.total == 16
      assert four.total == 31
      assert four.total - one.total == 15
    end
  end

  describe "GET /boot" do
    test "answers the whole boot picture in ONE request" do
      %{conn: conn, slugs: slugs} = boot_account(3, 4)

      body = json_response(get(conn, "/boot"), 200)

      assert length(body["networks"]) == 3

      for slug <- slugs do
        assert Enum.any?(body["networks"], &(&1["slug"] == slug))
        assert length(body["channels"][slug]) == 4
      end
    end

    test "carries EVERY channel of EVERY network — the half that breaks in silence" do
      %{conn: conn, slugs: slugs} = boot_account(3, 4)

      body = json_response(get(conn, "/boot"), 200)

      # The per-network channel lists must be byte-identical to what the
      # endpoint they replace answers. Anything less is a boot that renders
      # a short sidebar and looks fine.
      for slug <- slugs do
        per_network = json_response(get(conn, "/networks/#{slug}/channels"), 200)
        assert body["channels"][slug] == per_network
      end
    end

    test "costs six queries, and this is WHICH six" do
      {sources, count} = measure_boot(3, 5)

      # Pinned as an ordered list, not a total: a regression then says which
      # read appeared or vanished instead of only that something moved.
      #
      #   sessions + users     — the bearer plug, once per request
      #   network_credentials  — the credential set...
      #   networks             — ...and its `:network` preload
      #   user_settings        — the presence-filter prefs, read in bulk once
      #   messages             — the ONE windowed per-channel head statement
      #
      # Everything else a boot needs (live nick, connection info, the session
      # channel list) is a Registry / GenServer read and costs no query — which
      # is why this list does not grow with the account.
      assert sources == [
               "sessions",
               "users",
               "network_credentials",
               "networks",
               "user_settings",
               "messages"
             ]

      assert count == 6
    end

    test "the query count is INVARIANT under the number of NETWORKS" do
      {one_src, one} = measure_boot(1, 3)
      {seven_src, seven} = measure_boot(7, 3)

      assert {one, one_src} == {seven, seven_src},
             """
             /boot fans out per network — the HTTP burst became a SQL burst.
               N=1: #{one} #{inspect(one_src)}
               N=7: #{seven} #{inspect(seven_src)}
             """
    end

    test "the query count is INVARIANT under the number of CHANNELS" do
      {few_src, few} = measure_boot(2, 2)
      {many_src, many} = measure_boot(2, 20)

      assert {few, few_src} == {many, many_src},
             """
             /boot fans out per channel — the HTTP burst became a SQL burst.
               C=2:  #{few} #{inspect(few_src)}
               C=20: #{many} #{inspect(many_src)}
             """
    end

    test "the WIN, stated as the delta the issue asked for" do
      today = today_boot_cost(7, 3)
      {_, boot} = measure_boot(7, 3)

      # Seven networks is the account the prod incident was measured on.
      assert today.requests == 9
      assert today.total == 46

      # `/me` is deliberately not folded in (see BootController's moduledoc),
      # so a boot is `/me` + `/boot`: two requests, and both flat in account
      # size. That is the "single digits of requests" the Decision asked for,
      # and it stays single-digit at seventy networks.
      assert boot == 6
      assert today.me + boot == 13
    end
  end

  # ---------------------------------------------------------------------------
  # Harness
  # ---------------------------------------------------------------------------

  # Runs one `GET /boot` and returns `{sources, count}`.
  #
  # The known-answer control is INSIDE the instrument on purpose. `/boot` has
  # a catch-all above it in the router (`get "/*path", SpaController, :index`)
  # which answers 200 `text/html` for any unrouted path — so before the route
  # existed BOTH invariance tests passed, comparing the SPA's query cost
  # against itself. A count is only evidence once the thing counted is the
  # thing under test, so the response is proven to be the boot envelope, with
  # the account it was built for, before its cost is believed.
  defp measure_boot(n, c) do
    %{conn: conn, slugs: slugs} = boot_account(n, c)
    {conn, sources} = measure(fn -> get(conn, "/boot") end)

    body = json_response(conn, 200)
    assert length(body["networks"]) == n
    assert map_size(body["channels"]) == n
    for slug <- slugs, do: assert(length(body["channels"][slug]) == c)

    {sources, length(sources)}
  end

  defp today_boot_cost(n, c) do
    %{conn: conn, slugs: slugs} = boot_account(n, c)

    {_, me} = measure(fn -> get(conn, "/me") end)
    {_, nets} = measure(fn -> get(conn, "/networks") end)

    per_channel =
      Enum.map(slugs, fn slug ->
        {_, q} = measure(fn -> get(conn, "/networks/#{slug}/channels") end)
        length(q)
      end)

    %{
      requests: 2 + length(slugs),
      me: length(me),
      networks: length(nets),
      channels_each: per_channel,
      total: length(me) + length(nets) + Enum.sum(per_channel)
    }
  end

  # Builds a user bound to `n` networks, each credential carrying `c`
  # autojoin channels, and returns a bearer-carrying conn plus the slugs.
  defp boot_account(n, c) do
    user = user_fixture(name: "boot-#{System.unique_integer([:positive])}")
    session = session_fixture(user)

    slugs =
      for i <- 1..n do
        {network, _} =
          network_with_server(port: 6667, slug: "boot-#{System.unique_integer([:positive])}")

        channels = for j <- 1..c, do: "#c#{i}-#{j}"
        credential_fixture(user, network, %{autojoin_channels: channels})
        network.slug
      end

    %{conn: put_bearer(build_conn(), session.id), slugs: slugs}
  end

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
    if self() == test_pid, do: send(test_pid, {ref, Map.get(metadata, :source)})
    :ok
  end

  defp drain(ref, acc) do
    receive do
      {^ref, source} -> drain(ref, [source | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end
end
