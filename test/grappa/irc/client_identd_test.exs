defmodule Grappa.IRC.ClientIdentdTest do
  @moduledoc """
  `Grappa.IRC.Client` publishes the 4-tuple of every upstream socket it
  opens, so the identd can answer for it (issue 227).

  The local port of an outbound socket was tracked nowhere before this —
  `:inet.sockname/1` had zero occurrences under `lib/`. It is read here
  from the FAR END (`Grappa.IRCServer.peername/1`), which is the
  independent oracle: the fake upstream reports the source address it
  actually accepted, so a binding built from the wrong socket cannot
  match by accident.
  """
  use ExUnit.Case, async: true

  alias Grappa.{Identd, IRCServer}
  alias Grappa.Identd.Bindings
  alias Grappa.IRC.Client

  setup do
    start_supervised!(Bindings)
    :ok
  end

  defp start_client(port) do
    {:ok, client} =
      Client.start_link(%{
        host: "127.0.0.1",
        port: port,
        tls: false,
        dispatch_to: self(),
        logger_metadata: [],
        nick: "grappa-test",
        ident: "grp",
        realname: "grappa-test",
        sasl_user: "grappa-test",
        auth_method: :none
      })

    client
  end

  test "a connected client binds its {source, local_port, peer, peer_port} tuple to its ident" do
    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    _ = start_client(port)
    :ok = IRCServer.await_handshake(server, 1_000)

    {:ok, {source_ip, local_port}} = IRCServer.peername(server)

    assert await_bound({source_ip, local_port, {127, 0, 0, 1}, port}) == {:ok, "grp"}
  end

  test "the ident on the wire and the ident the identd answers are the same value" do
    # Not a tautology: the USER line is built by AuthFSM from its own opts
    # map and the binding by the Client from its. Reading the ident back
    # off the wire is what pins them to one value.
    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    _ = start_client(port)
    :ok = IRCServer.await_handshake(server, 1_000)

    {:ok, user_line} =
      IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER "), 1_000)

    {:ok, {source_ip, local_port}} = IRCServer.peername(server)
    {:ok, bound_ident} = await_bound({source_ip, local_port, {127, 0, 0, 1}, port})

    assert ["USER", ^bound_ident | _] = String.split(String.trim(user_line), " ")
  end

  test "the binding dies with the client process" do
    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    client = start_client(port)
    :ok = IRCServer.await_handshake(server, 1_000)

    {:ok, {source_ip, local_port}} = IRCServer.peername(server)
    key = {source_ip, local_port, {127, 0, 0, 1}, port}
    assert {:ok, "grp"} = await_bound(key)

    # Unlink first: this client is linked to the test process, and the
    # exit signal would take the test down with it.
    Process.unlink(client)
    ref = Process.monitor(client)
    Process.exit(client, :kill)
    assert_receive {:DOWN, ^ref, :process, ^client, _}

    assert await_unbound(key)
  end

  # The registration is a cast (the connect path must never block on, nor
  # crash from, an optional subsystem), so its arrival is not ordered
  # against this process's own reads. Poll instead of sleeping.
  defp await_bound(key), do: poll(key, :bound, System.monotonic_time(:millisecond) + 1_000)

  defp await_unbound(key),
    do: poll(key, :unbound, System.monotonic_time(:millisecond) + 1_000) == :none

  defp poll(key, want, deadline) do
    result = Identd.lookup(key, 0)

    cond do
      matches?(result, want) ->
        result

      System.monotonic_time(:millisecond) >= deadline ->
        result

      true ->
        Process.sleep(10)
        poll(key, want, deadline)
    end
  end

  defp matches?({:ok, _}, :bound), do: true
  defp matches?(:none, :unbound), do: true
  defp matches?(_, _), do: false
end
