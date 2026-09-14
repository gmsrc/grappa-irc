defmodule Grappa.Identd.BindingsTest do
  @moduledoc """
  The 4-tuple → ident table behind the identd listener (issue 227).

  Three properties matter here and each has its own test: the table is
  keyed on the FULL `{source_ip, local_port, peer_ip, peer_port}` tuple,
  a lookup that misses WAITS for a late registration instead of
  answering cold, and a binding dies with the process that registered
  it.
  """
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  alias Grappa.Identd
  alias Grappa.Identd.Bindings

  @local {127, 0, 0, 1}
  @peer {192, 0, 2, 10}
  @key {@local, 51_234, @peer, 6667}

  describe "with the table running" do
    setup do
      start_supervised!(Bindings)
      :ok
    end

    test "a registered 4-tuple resolves to its ident" do
      :ok = Identd.register(@key, "grappa")

      assert Identd.lookup(@key, 0) == {:ok, "grappa"}
    end

    test "a tuple differing only in peer_ip does NOT resolve" do
      # This is the anti-enumeration invariant in its smallest form: the
      # querier's address is part of the KEY, so a lookup from anyone but
      # the peer cannot match. See the listener test for the end-to-end
      # byte-identity assertion built on it.
      :ok = Identd.register(@key, "grappa")

      assert Identd.lookup({@local, 51_234, {198, 51, 100, 7}, 6667}, 0) == :none
    end

    test "a tuple differing only in source_ip does NOT resolve" do
      :ok = Identd.register(@key, "grappa")

      assert Identd.lookup({{127, 0, 0, 2}, 51_234, @peer, 6667}, 0) == :none
    end

    test "an unknown tuple answers :none once the wait budget elapses" do
      started = System.monotonic_time(:millisecond)

      assert Identd.lookup(@key, 150) == :none

      assert System.monotonic_time(:millisecond) - started >= 150
    end

    test "a lookup parked on a cold miss is answered by a LATER registration" do
      # The race the slice exists to close: the ircd starts its lookup the
      # instant it accepts, which is the instant `connect/4` returns here —
      # so the query can arrive before the binding is written. Answering
      # NO-USER cold is exactly the failure that leaves the `~` in place.
      task = Task.async(fn -> Identd.lookup(@key, 2_000) end)

      # Let the waiter park before the registration lands, so the reply can
      # only come from the waiter-wakeup path and not from a warm table.
      Process.sleep(50)
      :ok = Identd.register(@key, "grappa")

      assert Task.await(task, 3_000) == {:ok, "grappa"}
    end

    test "a binding dies with the process that registered it" do
      holder =
        spawn(fn ->
          :ok = Identd.register(@key, "grappa")
          # Resolve the registration before exiting, so the teardown under
          # test is the monitor and not a lost cast.
          {:ok, "grappa"} = Identd.lookup(@key, 0)
        end)

      ref = Process.monitor(holder)
      assert_receive {:DOWN, ^ref, :process, ^holder, _}

      assert await_unbound(@key)
    end

    test "an ident that would break the reply framing is refused, loudly" do
      log =
        capture_log(fn ->
          :ok = Identd.register(@key, "bad" <> <<10>> <> "user")
          assert Identd.lookup(@key, 0) == :none
        end)

      assert log =~ "identd"
    end

    test "re-registering the same tuple replaces the ident" do
      :ok = Identd.register(@key, "first")
      :ok = Identd.register(@key, "second")

      assert Identd.lookup(@key, 0) == {:ok, "second"}
    end
  end

  describe "with the table absent (identd disabled — the default)" do
    test "register/2 is a silent no-op rather than a crash on the connect path" do
      # `Grappa.IRC.Client` calls this on every successful connect. With the
      # feature off there is no process to receive it, and an upstream IRC
      # connection must not care.
      refute Process.whereis(Bindings)

      assert Identd.register(@key, "grappa") == :ok
    end
  end

  # Condition-based wait: the monitor DOWN reaching the table and this test
  # process observing the holder's death are two unordered signals.
  defp await_unbound(key), do: await_unbound(key, System.monotonic_time(:millisecond) + 1_000)

  defp await_unbound(key, deadline) do
    case Identd.lookup(key, 0) do
      :none ->
        true

      {:ok, _} ->
        if System.monotonic_time(:millisecond) >= deadline do
          false
        else
          Process.sleep(10)
          await_unbound(key, deadline)
        end
    end
  end
end
