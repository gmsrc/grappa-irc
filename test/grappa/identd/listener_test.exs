defmodule Grappa.Identd.ListenerTest do
  @moduledoc """
  End-to-end RFC 1413 exchanges over a real loopback socket (issue 227).

  The listener is the only surface a stranger can reach, so the tests
  that matter here are the ones about what it refuses to tell them. The
  anti-oracle test is deliberately built so that a plausible weakening —
  dropping the querier's address from the lookup key — turns it red.

  Not covered, and said out loud rather than implied: the dual-stack
  (`::` with `ipv6_v6only: false`) bind is exercised by no test here.
  These tests bind `127.0.0.1` so the accepted socket's address family is
  deterministic on every host the suite runs on; the v4-mapped
  normalisation that a dual-stack bind needs is pinned as a pure unit
  test below instead.
  """
  use ExUnit.Case, async: true

  alias Grappa.Identd
  alias Grappa.Identd.Bindings
  alias Grappa.Identd.Listener

  @crlf <<13, 10>>
  @loopback {127, 0, 0, 1}
  @off_path {192, 0, 2, 10}

  # A port pair held FIXED across the three probes below. The echoed ports
  # are the only part of the reply that varies with the query, so holding
  # them still is what lets the two failure replies be compared byte for
  # byte rather than by shape.
  @local_port 51_234
  @peer_port 6667

  @wait_ms 200

  setup do
    start_supervised!(Bindings)
    start_supervised!({Task.Supervisor, name: Grappa.Identd.Acceptors, max_children: 4})
    start_supervised!({Listener, port: 0, bind: "127.0.0.1", wait_ms: @wait_ms})

    {:ok, port: Listener.port(Listener)}
  end

  describe "the peer's own query" do
    test "is answered with the session's ident", %{port: port} do
      :ok = Identd.register({@loopback, @local_port, @loopback, @peer_port}, "grappa")

      assert query(port, "#{@local_port} , #{@peer_port}") ==
               "#{@local_port} , #{@peer_port} : USERID : UNIX : grappa" <> @crlf
    end
  end

  describe "no oracle" do
    test "a wrong querier and an unknown tuple are byte-identical and equally slow", %{port: port} do
      line = "#{@local_port} , #{@peer_port}"

      # (C) Nothing registered at all.
      {unknown, unknown_ms} = timed_query(port, line)

      # (B) The tuple EXISTS, but its peer is not the host asking. The
      # querier here is loopback; the binding names an off-path peer.
      :ok = Identd.register({@loopback, @local_port, @off_path, @peer_port}, "secret-ident")
      {wrong_querier, wrong_querier_ms} = timed_query(port, line)

      # (A) The positive control: the SAME port pair, registered to the
      # host that is actually asking. Without this the byte-equality above
      # could be satisfied by a listener that answers nobody.
      :ok = Identd.register({@loopback, @local_port, @loopback, @peer_port}, "grappa")
      hit = query(port, line)

      assert wrong_querier == unknown
      assert unknown == "#{@local_port} , #{@peer_port} : ERROR : NO-USER" <> @crlf
      refute hit == unknown
      assert hit =~ "USERID"
      refute wrong_querier =~ "secret-ident"

      # The content is uniform; so is the timing. A fast refusal for a
      # tuple that exists and a slow one for a tuple that does not would
      # re-open by the clock exactly what the identical bytes closed.
      assert unknown_ms >= @wait_ms
      assert wrong_querier_ms >= @wait_ms
    end

    test "a malformed query gets the same error type, with no ports to echo", %{port: port} do
      assert query(port, "not-a-port-pair") == "0 , 0 : ERROR : NO-USER" <> @crlf
    end

    test "a query naming an out-of-range port is treated as malformed", %{port: port} do
      assert query(port, "70000 , 6667") == "0 , 0 : ERROR : NO-USER" <> @crlf
    end
  end

  describe "port/1" do
    test "reports the ephemeral port the listener actually bound", %{port: port} do
      assert is_integer(port) and port > 0
    end
  end

  describe "unmap_v4/1" do
    test "folds a v4-mapped v6 address onto its v4 tuple" do
      # What a dual-stack (`::`, ipv6_v6only: false) listener sees for an
      # IPv4 querier. The binding was written from an IPv4 outbound socket,
      # so the two spellings have to meet on one key.
      assert Listener.unmap_v4({0, 0, 0, 0, 0, 0xFFFF, 0x7F00, 0x0001}) == {127, 0, 0, 1}
    end

    test "leaves a native v6 address alone" do
      assert Listener.unmap_v4({0x2001, 0xDB8, 0, 0, 0, 0, 0, 1}) ==
               {0x2001, 0xDB8, 0, 0, 0, 0, 0, 1}
    end

    test "leaves a v4 address alone" do
      assert Listener.unmap_v4({192, 0, 2, 1}) == {192, 0, 2, 1}
    end
  end

  defp query(port, line) do
    {:ok, reply} = do_query(port, line)
    reply
  end

  defp timed_query(port, line) do
    started = System.monotonic_time(:millisecond)
    reply = query(port, line)
    {reply, System.monotonic_time(:millisecond) - started}
  end

  defp do_query(port, line) do
    {:ok, socket} =
      :gen_tcp.connect(@loopback, port, [:binary, :inet, active: false, packet: :line])

    :ok = :gen_tcp.send(socket, line <> @crlf)
    result = :gen_tcp.recv(socket, 0, 5_000)
    :ok = :gen_tcp.close(socket)
    result
  end
end
