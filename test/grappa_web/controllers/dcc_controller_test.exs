defmodule GrappaWeb.DccControllerTest do
  @moduledoc """
  issue 2089 — the four REST doors behind the DCC consent banner.

  Two nouns, two controllers, and the split is the point: an OFFER is
  per-session memory with a hold that runs out, a FILE is bytes on disk
  with a retention the reaper enforces. Different lifetimes, and since
  issue 2127 different GATES too — which is why one resource with a mode
  was never going to work.

  ## The gate split (issue 2127)

  The offer doors keep `:authn` + `ResolveNetwork`: they act on a live
  `Session.Server` for a `(subject, network)`, so ownership has to be
  proved. The FILE door has none — it is `GET /dcc_files/:slug` at top
  level, beside `GET /uploads/:slug`, and the 26-char base32 slug is the
  access token. Not a relaxation: the gated shape could not be used at
  all, because a tapped scrollback link opens a tab with no
  `Authorization` header and `Plugs.Authn` reads nothing else.

  What this file has to pin beyond the happy paths:

    * the accept answers **202**, not 200. The transfer runs detached and
      the outcome arrives as a scrollback row, so a 200 would be claiming
      an arrival nobody has observed;
    * a handle that names nothing is **404** on both write doors — they
      are HTTP-reachable and must not double as a way to silently succeed;
    * the file door serves `application/octet-stream` with
      `Content-Disposition: attachment` and `nosniff` — **on the
      unauthenticated path**, which is now the one an attacker reaches.
      These bytes came off a stranger's socket: anything that lets a
      browser decide for itself what they are is a stored-XSS door;
    * the file door answers a request carrying **no bearer at all**. That
      is the defect issue 2127 closed, so it is asserted rather than
      implied by the absence of a 401 test;
    * an `.ext` on the file URL addresses the SAME row and changes NO
      response header — the lookup is the 26 characters only;
    * every miss on the file door — expired, unknown, malformed — answers
      identically. With the pipeline gone, a distinguishing 404 would be
      a probe for which slugs exist.

  `async: false` for the usual singleton reason (`Grappa.SessionRegistry`,
  `Grappa.SessionSupervisor`, `Grappa.PubSub`).
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Dcc, IRCServer, Repo, Session}
  alias Grappa.Dcc.SpoolFile

  @nick "grappa-test"
  @public_ip "1.2.3.4"
  @filename "holiday.jpg"
  @size 12_345
  @bytes "the stranger's bytes"

  setup %{conn: conn} do
    vjt = user_fixture(name: "vjt-#{u()}")
    {:ok, conn: put_bearer(conn, session_fixture(vjt).id), vjt: vjt}
  end

  describe "GET /networks/:network_id/dcc_offers" do
    test "lists the held offer in the same shape the live event carried", ctx do
      %{network: network, offer_id: offer_id} = held_offer(ctx.vjt)

      conn = get(ctx.conn, "/networks/#{network.slug}/dcc_offers")

      assert %{"offers" => [offer]} = json_response(conn, 200)
      assert offer["offer_id"] == offer_id
      assert offer["from"] == "alice"
      assert offer["filename"] == @filename
      assert offer["size"] == @size
      assert offer["channel"] == "$server"
    end

    test "holding nothing lists nothing", ctx do
      %{network: network} = connected(ctx.vjt)

      conn = get(ctx.conn, "/networks/#{network.slug}/dcc_offers")

      assert json_response(conn, 200) == %{"offers" => []}
    end
  end

  describe "POST /networks/:network_id/dcc_offers/:offer_id/accept" do
    test "answers 202 — admitted and started, never arrived", ctx do
      %{network: network, offer_id: offer_id} = held_offer(ctx.vjt)

      conn = post(ctx.conn, "/networks/#{network.slug}/dcc_offers/#{offer_id}/accept")

      assert json_response(conn, 202) == %{"ok" => true}
    end

    test "a handle that names nothing is 404", ctx do
      %{network: network} = held_offer(ctx.vjt)

      conn = post(ctx.conn, "/networks/#{network.slug}/dcc_offers/nosuchhandle/accept")

      assert json_response(conn, 404) == %{"error" => "not_held"}
    end
  end

  describe "DELETE /networks/:network_id/dcc_offers/:offer_id" do
    test "refuses the offer and answers 200 — the drop is fully applied", ctx do
      %{network: network, offer_id: offer_id} = held_offer(ctx.vjt)

      conn = delete(ctx.conn, "/networks/#{network.slug}/dcc_offers/#{offer_id}")

      assert json_response(conn, 200) == %{"ok" => true}

      listed = get(ctx.conn, "/networks/#{network.slug}/dcc_offers")
      assert json_response(listed, 200) == %{"offers" => []}
    end

    test "refusing twice is 404 the second time, not a silent success", ctx do
      %{network: network, offer_id: offer_id} = held_offer(ctx.vjt)
      _ = delete(ctx.conn, "/networks/#{network.slug}/dcc_offers/#{offer_id}")

      conn = delete(ctx.conn, "/networks/#{network.slug}/dcc_offers/#{offer_id}")

      assert json_response(conn, 404) == %{"error" => "not_held"}
    end
  end

  describe "GET /dcc_files/:slug[.ext] — public, the slug IS the credential" do
    test "serves the bytes as an opaque attachment the browser may not interpret", ctx do
      %{slug: slug} = spooled(ctx.vjt)

      conn = get(ctx.conn, "/dcc_files/#{slug}")

      assert response(conn, 200) == @bytes
      assert get_resp_header(conn, "content-type") == ["application/octet-stream"]
      assert get_resp_header(conn, "x-content-type-options") == ["nosniff"]
      assert [disposition] = get_resp_header(conn, "content-disposition")
      assert disposition =~ "attachment"
    end

    test "a request with NO bearer at all is served — the whole point of issue 2127", ctx do
      # The load-bearing assertion of the ruling, and the one the old shape
      # could not pass. `Plugs.Authn` reads only an `authorization: Bearer`
      # header; a tapped scrollback link opens a plain tab that carries
      # none, so the gated route answered 401 and the delivery row's link
      # was unusable by the one person it was minted for.
      #
      # `build_conn/0` with no `put_bearer` IS that tab.
      %{slug: slug} = spooled(ctx.vjt)

      conn = get(build_conn(), "/dcc_files/#{slug}")

      assert response(conn, 200) == @bytes
    end

    test "the three headers hold on the unauthenticated path too", ctx do
      # Ungating moved these from "defence in depth" to "the defence", so
      # they are asserted on the door an attacker actually reaches rather
      # than only on the authenticated one above.
      %{slug: slug} = spooled(ctx.vjt)

      conn = get(build_conn(), "/dcc_files/#{slug}")

      assert get_resp_header(conn, "content-type") == ["application/octet-stream"]
      assert get_resp_header(conn, "x-content-type-options") == ["nosniff"]
      assert [disposition] = get_resp_header(conn, "content-disposition")
      assert disposition =~ "attachment"
    end

    test "an extension addresses the SAME row — the lookup is the 26 chars only", ctx do
      %{slug: slug} = spooled(ctx.vjt)

      for ext <- ["jpg", "mp4", "html", "svg"] do
        conn = get(build_conn(), "/dcc_files/#{slug}.#{ext}")

        assert response(conn, 200) == @bytes,
               "extension #{ext} must address the same row"

        # And it must not talk the server into a content type. A lying
        # `.html`/`.svg` is exactly the stored-XSS shape the three
        # unconditional headers exist for, and the extension reaches
        # neither the lookup nor the response.
        assert get_resp_header(conn, "content-type") == ["application/octet-stream"]
        assert get_resp_header(conn, "x-content-type-options") == ["nosniff"]
      end
    end

    test "an EXPIRED row is 404 — the only revocation a public URL has", ctx do
      %{slug: slug} = spooled(ctx.vjt)
      past = DateTime.add(DateTime.utc_now(), -60, :second)
      {1, _} = Repo.update_all(SpoolFile, set: [expires_at: past])

      conn = get(build_conn(), "/dcc_files/#{slug}")

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "a slug that names nothing is 404" do
      conn = get(build_conn(), "/dcc_files/#{Dcc.mint_slug()}")

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "a malformed slug is 404 and never reaches the filesystem" do
      conn = get(build_conn(), "/dcc_files/..%2F..%2Fetc%2Fpasswd")

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "every miss answers identically — no oracle for which slugs exist", ctx do
      %{slug: live} = spooled(ctx.vjt)
      {1, _} = Repo.update_all(SpoolFile, set: [expires_at: DateTime.utc_now()])

      misses =
        for path <- ["/dcc_files/#{live}", "/dcc_files/#{Dcc.mint_slug()}", "/dcc_files/nope"] do
          conn = get(build_conn(), path)
          {conn.status, json_response(conn, 404)}
        end

      # Expired, never-existed and malformed must be indistinguishable.
      # Asserted as ONE set rather than three equal assertions: a future
      # change that makes any of them diverge fails here with the pair
      # visible, which is what the oracle rule is actually about.
      assert Enum.uniq(misses) == [{404, %{"error" => "not_found"}}]
    end
  end

  # Boots a session and feeds a real DCC SEND, returning the minted handle.
  # Driven through the parser + EventRouter rather than poked into state:
  # the routing and the neutralisation both happen on that ingress path,
  # and a test that bypassed it would pass while the real door missed.
  defp held_offer(user) do
    ctx = connected(user)

    IRCServer.feed(
      ctx.server,
      ":alice!u@h PRIVMSG #{@nick} :\x01DCC SEND #{@filename} #{@public_ip} 5000 #{@size}\x01\r\n"
    )

    IRCServer.feed(ctx.server, "PING :flush\r\n")
    {:ok, _} = IRCServer.wait_for_line(ctx.server, &(&1 == "PONG :flush\r\n"), 1_000)

    {:ok, [%{offer_id: offer_id}]} = Session.list_dcc_offers(ctx.subject, ctx.network.id)
    Map.put(ctx, :offer_id, offer_id)
  end

  # A spooled file, written the way the session writes one: bytes on disk
  # first, then the row.
  defp spooled(user) do
    ctx = connected(user)
    slug = Dcc.mint_slug()
    :ok = File.write!(Dcc.storage_path(slug), @bytes)

    {:ok, _} =
      Dcc.store(ctx.subject, ctx.network.id, slug, %{
        peer_nick: "alice",
        filename: @filename,
        bytes: byte_size(@bytes),
        retention_seconds: Dcc.retention_seconds(nil)
      })

    Map.put(ctx, :slug, slug)
  end

  defp connected(user) do
    {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", @nick))
    {network, _} = network_with_server(port: port, slug: "azzurra-#{u()}")
    _ = credential_fixture(user, network, %{nick: @nick, autojoin_channels: []})

    pid = start_session_for(user, network)
    :ok = IRCServer.await_handshake(server, 1_000)
    on_exit(fn -> Session.stop_session({:user, user.id}, network.id) end)

    %{server: server, pid: pid, network: network, subject: {:user, user.id}}
  end

  defp u, do: System.unique_integer([:positive])
end
