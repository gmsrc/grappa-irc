defmodule Grappa.Session.RefreshPlanCostTest do
  @moduledoc """
  #1410 — what the plan re-resolve inside `Grappa.Session.Server.init/1`
  costs, MEASURED rather than derived.

  The issue quotes "three SQLite round-trips inside `init/1`" and
  "Bootstrap's spawn loop is serialised on N × 3 queries", and says of
  itself that the figure is read off the call chain, not executed. So does
  the 2026-08-17 recon, and so does the #1410 entry in `DESIGN_NOTES`.
  This file executes it. Measured here: the door costs **nine** queries,
  not three, and the boot loop pays **fifteen** per credential (six in
  `Bootstrap`'s own `resolve/1`, nine in the `init/1` re-resolve).

  The five the call-chain reading misses are `Grappa.Networks.SessionPlan`'s
  `base_plan/7` tail — `addressing_config/0` (two `server_settings` rows,
  read one `Repo.get_by` each) plus `Grappa.Vhosts.effective_source/3`
  (`vhost_grants`, `vhosts`, `user_settings`). None is cached:
  `ServerSettings` reads go straight to `Repo.get_by/2`. They are paid by
  BOTH plan producers and on BOTH doors, which is why the visitor half
  costs the same nine as the user half despite reading a different set of
  rows for the first four.

  The tables are pinned as an ordered list rather than a bare total, so a
  changed count says WHICH read appeared or vanished. Two doors, one
  closure: `Bootstrap` resolves a plan and hands it to `start_child`;
  `init/1` invokes the injected `refresh_plan` and resolves it again. Only
  the respawn door needs the re-read (the 2026-05-27 `kazamobile` /
  `kazam02` stale-cached-opts class, plus the #93 ring counter that is
  authoritative only at restart) and one closure cannot tell the doors
  apart, so the spawn door pays it too.

  Scope of the measurement: the DEFAULT addressing configuration — mode 1,
  no `vhosts` rows, no grants. Mode 2 (`static_mapping_with_reservations`)
  walks a different branch of `effective_source/3` and was not measured.

  The counter runs in the TEST process and the telemetry handler filters on
  `self()`, which is what makes the file `async: true`-safe: a query
  emitted by another test runs in that test's process and never reaches
  this mailbox.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks.{Credentials, SessionPlan}
  alias Grappa.Visitors.SessionPlan, as: VisitorSessionPlan

  @query_event [:grappa, :repo, :query]

  # `base_plan/7`'s source resolution, shared by both producers and both
  # doors: `addressing_config/0` reads two `server_settings` keys, then
  # `Vhosts.effective_source/3` reads the grant set, the vhost set and the
  # subject's persisted selection.
  @source_resolution ["server_settings", "server_settings", "vhost_grants", "vhosts", "user_settings"]

  describe "the user door" do
    test "the SPAWN door — Bootstrap's own resolve, network preloaded — costs six queries" do
      {user, network, _} = user_with_credential(6667, %{})
      credential = Repo.preload(Credentials.get_credential!(user, network), network: :servers)

      {{:ok, _}, sources} = measure(fn -> SessionPlan.resolve(credential) end)

      assert sources == ["users"] ++ @source_resolution
    end

    test "the RESPAWN door — the refresh_plan closure init/1 invokes — costs nine queries" do
      {user, network, _} = user_with_credential(6667, %{})
      {:ok, plan} = SessionPlan.resolve(Credentials.get_credential!(user, network))

      {{:ok, _}, sources} = measure(plan.refresh_plan)

      assert sources ==
               ["network_credentials", "networks", "network_servers", "users"] ++
                 @source_resolution
    end
  end

  describe "the visitor door" do
    test "the RESPAWN door costs nine queries too, on a different first four" do
      {network, _} =
        network_with_server(port: 6667, slug: "vis-#{System.unique_integer([:positive])}")

      visitor = visitor_fixture(network_slug: network.slug)
      {:ok, plan} = VisitorSessionPlan.resolve(visitor, network)

      {{:ok, _}, sources} = measure(plan.refresh_plan)

      assert sources ==
               ["visitors", "networks", "network_credentials", "network_servers"] ++
                 @source_resolution
    end
  end

  # Runs `fun` and returns `{result, sources}`, where `sources` is the
  # ordered list of `metadata.source` values Ecto emitted for the queries
  # THIS process executed. Telemetry handlers run in the emitting process,
  # so the `self()` guard is an exact filter, not a heuristic — and the
  # events are emitted synchronously, so the mailbox is complete the moment
  # `fun` returns.
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
