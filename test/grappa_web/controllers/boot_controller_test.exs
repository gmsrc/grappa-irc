defmodule GrappaWeb.BootControllerTest do
  @moduledoc """
  #1679 — `GET /boot` behaviour. The COST half (the N+1 pin, the baseline it
  is measured against) lives in `GrappaWeb.BootCostTest`; this file is about
  what the envelope says.

  Both subject kinds, because #211 ruling A makes a visitor multi-network
  with real per-network credentials — a boot endpoint that served only users
  would leave every visitor on the fan-out this issue exists to remove.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{MuteSession, ScrollbackHelpers}

  describe "authorization" do
    test "an unauthenticated caller is refused, and does NOT fall through to the SPA" do
      conn = get(build_conn(), "/boot")

      # The route sits under `:authn` but BELOW `get "/*path", SpaController`
      # in the router file, so "refused" has to be asserted as a 401 with a
      # JSON body — a 200 `text/html` here would mean the request never
      # reached this controller at all, which is how the catch-all silently
      # green-lit the cost tests before the route existed.
      assert json_response(conn, 401)
    end
  end

  describe "the user subject" do
    test "answers the networks, the channel tree and the heads in one envelope" do
      %{conn: conn, slug: slug, channels: channels} = account_with_history()

      body = json_response(get(conn, "/boot"), 200)

      assert [network] = body["networks"]
      assert network["slug"] == slug
      assert network["kind"] == "user"

      assert Enum.map(body["channels"][slug], & &1["name"]) == Enum.sort(channels)
    end

    test "the head carries the channel's NEWEST rows, oldest-first, and only its own" do
      %{conn: conn, slug: slug} = account_with_history()

      body = json_response(get(conn, "/boot"), 200)

      head = body["heads"][slug]["#alpha"]
      assert Enum.map(head, & &1["body"]) == ["alpha 1", "alpha 2", "alpha 3"]

      # A channel's head must not bleed into its sibling's. The partition is
      # `(network_id, channel)`; a broken one shows up here as one list
      # holding both channels' rows.
      assert Enum.map(body["heads"][slug]["#beta"], & &1["body"]) == ["beta 1"]
    end

    test "a channel with no history is ABSENT from heads, not mapped to an empty list" do
      %{conn: conn, slug: slug} = account_with_history()

      heads = json_response(get(conn, "/boot"), 200)["heads"][slug]

      # `#quiet` is in the channel tree and has no rows. Absent rather than
      # `[]` — the `read_cursors` convention, and what keeps the envelope
      # from growing a key per empty window on a large account.
      assert Map.has_key?(heads, "#alpha")
      refute Map.has_key?(heads, "#quiet")
      assert Enum.any?(json_response(get(conn, "/boot"), 200)["channels"][slug], &(&1["name"] == "#quiet"))
    end

    test "never leaks another subject's rows into the head" do
      %{conn: conn, slug: slug, network: network} = account_with_history()

      other = user_fixture(name: "other-#{System.unique_integer([:positive])}")
      credential_fixture(other, network, %{autojoin_channels: ["#alpha"]})
      insert_message(other, network, "#alpha", "not yours")

      heads = json_response(get(conn, "/boot"), 200)["heads"][slug]

      refute "not yours" in Enum.map(heads["#alpha"], & &1["body"])
    end

    test "an account with no networks gets empty collections, not a 404" do
      user = user_fixture(name: "bare-#{System.unique_integer([:positive])}")
      conn = put_bearer(build_conn(), session_fixture(user).id)

      body = json_response(get(conn, "/boot"), 200)

      assert body["networks"] == []
      assert body["channels"] == %{}
      assert body["heads"] == %{}
    end
  end

  describe "the visitor subject" do
    test "gets the same envelope, discriminated as a visitor" do
      {network, _} =
        network_with_server(port: 6667, slug: "vis-#{System.unique_integer([:positive])}")

      {visitor, session} = visitor_and_session_with_credential(network_slug: network.slug)
      visitor_channel_fixture(visitor, network.slug, "#vis")
      conn = put_bearer(build_conn(), session.id)

      body = json_response(get(conn, "/boot"), 200)

      assert [row] = body["networks"]
      assert row["kind"] == "visitor"
      assert row["slug"] == network.slug
      assert Enum.map(body["channels"][network.slug], & &1["name"]) == ["#vis"]
    end
  end

  # issue 2239 — `GET /boot` reaches `Session.list_channels/2` once per
  # network row, through `Networks.session_channels/2`. That wrapper matched
  # the two shapes the (wrong) `@spec` declared and had no clause for the
  # `{:error, :timeout}` the 5s `call_session/3` budget really can return, so
  # ONE session too busy to answer raised a `CaseClauseError` out of the map
  # comprehension — taking every OTHER network's tree down with it, since the
  # envelope is assembled before anything is rendered.
  #
  # The 5s is the caller's own budget, not a knob this test can shrink:
  # `list_channels/2` has no timeout parameter (that is `/3`, which
  # `Grappa.LiveIntrospection` uses at 250 ms precisely because it needed the
  # honest signal this endpoint throws away).
  #
  # Asserted as a 200, and NOT as a channel-tree shape, on purpose: what a
  # timed-out session should DEGRADE to is an open ruling on issue 2239 — `[]`
  # ("no channels joined") is a different claim from "the session did not
  # answer". No candidate ruling makes a 500 the answer, so this is the part
  # that can be pinned before the ruling lands.
  describe "a session that does not answer within the call budget" do
    @tag timeout: 30_000
    test "does not 500 the envelope, and does not take the sibling networks with it" do
      user = user_fixture(name: "boot-mute-#{System.unique_integer([:positive])}")
      conn = put_bearer(build_conn(), session_fixture(user).id)

      {stuck, _} =
        network_with_server(port: 6667, slug: "stuck-#{System.unique_integer([:positive])}")

      {healthy, _} =
        network_with_server(port: 6667, slug: "ok-#{System.unique_integer([:positive])}")

      credential_fixture(user, stuck, %{autojoin_channels: ["#stuck"]})
      credential_fixture(user, healthy, %{autojoin_channels: ["#healthy"]})

      _ = MuteSession.register!({:user, user.id}, stuck.id)

      body = json_response(get(conn, "/boot"), 200)

      assert Enum.sort(Enum.map(body["networks"], & &1["slug"])) ==
               Enum.sort([stuck.slug, healthy.slug])

      # The healthy network's tree is intact — the blast radius of one stuck
      # session must not be the whole account.
      assert Enum.map(body["channels"][healthy.slug], & &1["name"]) == ["#healthy"]
    end
  end

  # A user on one network with three channels: `#alpha` (three rows),
  # `#beta` (one), `#quiet` (none).
  defp account_with_history do
    user = user_fixture(name: "boot-#{System.unique_integer([:positive])}")
    session = session_fixture(user)

    {network, _} =
      network_with_server(port: 6667, slug: "boot-#{System.unique_integer([:positive])}")

    channels = ["#alpha", "#beta", "#quiet"]
    credential_fixture(user, network, %{autojoin_channels: channels})

    for body <- ["alpha 1", "alpha 2", "alpha 3"],
        do: insert_message(user, network, "#alpha", body)

    insert_message(user, network, "#beta", "beta 1")

    %{
      conn: put_bearer(build_conn(), session.id),
      slug: network.slug,
      network: network,
      channels: channels
    }
  end

  defp insert_message(user, network, channel, body) do
    {:ok, message} =
      ScrollbackHelpers.insert(%{
        user_id: user.id,
        network_id: network.id,
        channel: channel,
        sender: "peer",
        kind: :privmsg,
        body: body,
        server_time: System.system_time(:millisecond)
      })

    message
  end
end
