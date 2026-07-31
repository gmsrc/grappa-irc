defmodule Grappa.Net.SourceAliasManagerTest do
  @moduledoc """
  #543 INC-5 — ref-count lifecycle + boot reconcile + arm gate. A Mox adapter
  (`Grappa.Net.SourceAliasMock`) stands in for the platform, so no real
  `ifconfig` runs. The manager is a GenServer that calls the adapter during
  `init` (arm_check) + `handle_continue` (reconcile) — before any `allow/3`
  could land — so the mock runs in GLOBAL mode (safe: the suite is fully
  serial via `max_cases: 1`).
  """
  use ExUnit.Case, async: false

  import Mox

  alias Grappa.Net.SourceAliasManager, as: Manager

  @prefix "2a03:4000:20:2d3:cb::/80"
  @addr "2a03:4000:20:2d3:cb::1"
  @addr2 "2a03:4000:20:2d3:cb::2"

  setup :set_mox_global
  setup :verify_on_exit!

  # Start a manager wired to the Mox adapter + a fixed prefix. The boot-path
  # calls (arm_check, then reconcile's list_aliases) are stubbed so a clean
  # boot is a no-op; individual tests layer `expect/3` on top.
  defp start_manager do
    stub(Grappa.Net.SourceAliasMock, :arm_check, fn @prefix -> :ok end)
    stub(Grappa.Net.SourceAliasMock, :list_aliases, fn @prefix -> {:ok, []} end)

    start_supervised!({Manager, adapter: Grappa.Net.SourceAliasMock, prefix: @prefix})
  end

  describe "acquire/release ref-counting" do
    test "binds once on 0→1, stays bound across a second acquire, unbinds on last release" do
      start_manager()

      # ensure_source ONCE (0→1); no ensure on the second acquire.
      expect(Grappa.Net.SourceAliasMock, :ensure_source, fn @addr, @prefix -> :ok end)
      assert :ok = Manager.acquire(@addr)
      assert :ok = Manager.acquire(@addr)

      # First release (2→1) does NOT unbind; second (1→0) unbinds once.
      expect(Grappa.Net.SourceAliasMock, :release_source, fn @addr, @prefix -> :ok end)
      assert :ok = Manager.release(@addr)
      assert :ok = Manager.release(@addr)
    end

    test "a failed bind does not leave a phantom ref-count" do
      start_manager()

      expect(Grappa.Net.SourceAliasMock, :ensure_source, fn @addr, @prefix -> {:error, :eacces} end)
      assert {:error, :eacces} = Manager.acquire(@addr)

      # A release of the never-bound address must NOT call release_source
      # (no expect set — an unexpected call fails verify).
      assert :ok = Manager.release(@addr)
    end
  end

  describe "reconcile" do
    test "releases an OS-bound alias that is not in the held set" do
      start_manager()

      # Hold @addr (bind it); @addr2 is an orphan the OS still reports.
      expect(Grappa.Net.SourceAliasMock, :ensure_source, fn @addr, @prefix -> :ok end)
      assert :ok = Manager.acquire(@addr)

      expect(Grappa.Net.SourceAliasMock, :list_aliases, fn @prefix -> {:ok, [@addr, @addr2]} end)
      # Only the orphan @addr2 is released; the held @addr is left alone.
      expect(Grappa.Net.SourceAliasMock, :release_source, fn @addr2, @prefix -> :ok end)

      assert :ok = Manager.reconcile()
    end

    # #543 INC-6 Part B — the crash-boundary the held-set widening closes. When
    # THIS manager restarts, its ref-count table resets to empty while live
    # `Session.Server` processes stay up + their aliases stay OS-bound. The
    # held set MUST union the refcount keys with the live holders (via the
    # injected `held_source_fn`, default `&Grappa.Session.live_derived_sources/0`
    # in prod), else the next reconcile classifies every in-use alias as an
    # orphan and RELEASES it — pulling the source out from under live sockets.
    test "reconcile keeps a live-held alias even when the refcount table is empty" do
      stub(Grappa.Net.SourceAliasMock, :arm_check, fn @prefix -> :ok end)
      stub(Grappa.Net.SourceAliasMock, :list_aliases, fn @prefix -> {:ok, []} end)

      # A live session holds @addr; the refcount table is empty (restart).
      start_supervised!(
        {Manager, adapter: Grappa.Net.SourceAliasMock, prefix: @prefix, held_source_fn: fn -> [@addr] end}
      )

      expect(Grappa.Net.SourceAliasMock, :list_aliases, fn @prefix -> {:ok, [@addr, @addr2]} end)
      # ONLY the orphan @addr2 is released; the live-held @addr survives even
      # though it is absent from the (empty) refcount table.
      expect(Grappa.Net.SourceAliasMock, :release_source, fn @addr2, @prefix -> :ok end)

      assert :ok = Manager.reconcile()
    end

    test "held set is the UNION of refcount keys and live holders" do
      stub(Grappa.Net.SourceAliasMock, :arm_check, fn @prefix -> :ok end)
      stub(Grappa.Net.SourceAliasMock, :list_aliases, fn @prefix -> {:ok, []} end)

      # @addr2 is live-held (from the fn); @addr is ref-counted (acquired here).
      start_supervised!(
        {Manager, adapter: Grappa.Net.SourceAliasMock, prefix: @prefix, held_source_fn: fn -> [@addr2] end}
      )

      expect(Grappa.Net.SourceAliasMock, :ensure_source, fn @addr, @prefix -> :ok end)
      assert :ok = Manager.acquire(@addr)

      # OS reports both held addresses + one true orphan; only the orphan goes.
      orphan = "2a03:4000:20:2d3:cb::dead"
      expect(Grappa.Net.SourceAliasMock, :list_aliases, fn @prefix -> {:ok, [@addr, @addr2, orphan]} end)
      expect(Grappa.Net.SourceAliasMock, :release_source, fn ^orphan, @prefix -> :ok end)

      assert :ok = Manager.reconcile()
    end
  end

  describe "arm gate" do
    test "armed? true + disarm_reason nil when arm_check passes at boot" do
      start_manager()
      assert Manager.armed?() == true
      assert Manager.disarm_reason() == nil
    end

    test "armed? false + concrete reason when arm_check refuses" do
      stub(Grappa.Net.SourceAliasMock, :list_aliases, fn @prefix -> {:ok, []} end)

      expect(Grappa.Net.SourceAliasMock, :arm_check, fn @prefix ->
        {:error, :wrapper_unavailable}
      end)

      start_supervised!({Manager, adapter: Grappa.Net.SourceAliasMock, prefix: @prefix})

      assert Manager.armed?() == false
      assert Manager.disarm_reason() == :wrapper_unavailable
    end

    test "armed? false with :no_static_prefix when no prefix is configured" do
      stub(Grappa.Net.SourceAliasMock, :list_aliases, fn _ -> {:ok, []} end)
      # arm_check is NEVER invoked with a nil prefix — the manager short-circuits.
      start_supervised!({Manager, adapter: Grappa.Net.SourceAliasMock, prefix: nil})

      assert Manager.armed?() == false
      assert Manager.disarm_reason() == :no_static_prefix
    end
  end
end
