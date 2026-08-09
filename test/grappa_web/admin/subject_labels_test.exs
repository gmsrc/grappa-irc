defmodule GrappaWeb.Admin.SubjectLabelsTest do
  @moduledoc """
  #1140 — the ONE batched `subject → display name` resolver every admin
  listing shares (`/admin/sessions` since M-9, `/admin/vhosts` grants
  since #1140).

  Two batched context lookups, one per subject kind, regardless of how
  many subjects are asked for. A subject that resolves to nothing is
  ABSENT from the map — callers render `nil`, the honesty signal, rather
  than a fabricated name.

  ## Test isolation

  `async: true` — freshly-created rows through the Repo sandbox.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks.Credentials
  alias GrappaWeb.Admin.SubjectLabels

  describe "resolve/1" do
    test "labels a user subject with the account name" do
      user = user_fixture(name: "labeluser1140")

      assert SubjectLabels.resolve([{:user, user.id}]) == %{{:user, user.id} => "labeluser1140"}
    end

    test "labels a visitor subject with its representative credential nick" do
      {visitor, network} = visitor_with_network(7220)

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, network.id, %{
          nick: "labelvis1140",
          auth_method: :none
        })

      assert SubjectLabels.resolve([{:visitor, visitor.id}]) ==
               %{{:visitor, visitor.id} => "labelvis1140"}
    end

    test "labels users and visitors in the same call" do
      user = user_fixture(name: "mixeduser1140")
      {visitor, network} = visitor_with_network(7221)

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, network.id, %{
          nick: "mixedvis1140",
          auth_method: :none
        })

      labels = SubjectLabels.resolve([{:user, user.id}, {:visitor, visitor.id}])

      assert labels == %{
               {:user, user.id} => "mixeduser1140",
               {:visitor, visitor.id} => "mixedvis1140"
             }
    end

    test "omits a subject that resolves to nothing" do
      # A visitor whose network slug resolves to no row gets no credential —
      # the shape `Credentials.list_visitor_credentials/1` documents as
      # reachable ("a fresh row the reconcile hasn't touched"). No nick
      # exists, and we do not invent one.
      visitor = visitor_fixture(network_slug: "absent-network-1140")

      assert SubjectLabels.resolve([{:visitor, visitor.id}]) == %{}
    end

    test "an empty subject list short-circuits with no DB round-trip" do
      assert count_repo_queries(fn -> assert SubjectLabels.resolve([]) == %{} end) == 0
    end

    test "asks the DB the same number of times whatever the subject count (no N+1)" do
      users = for n <- 1..5, do: user_fixture(name: "batch1140u#{n}")
      {visitor, _} = visitor_with_network(7222)

      one = count_repo_queries(fn -> SubjectLabels.resolve([{:user, hd(users).id}]) end)

      many =
        count_repo_queries(fn ->
          subjects = [{:visitor, visitor.id} | Enum.map(users, &{:user, &1.id})]
          assert map_size(SubjectLabels.resolve(subjects)) == 6
        end)

      # Six subjects must not cost more round-trips than one does per kind:
      # a per-subject loop would grow with the list.
      assert many <= one + 1,
             "one subject cost #{one} queries, six cost #{many} — that grows with N"
    end

    test "a repeated subject is asked for once and labelled once" do
      user = user_fixture(name: "dup1140")
      subjects = List.duplicate({:user, user.id}, 4)

      assert SubjectLabels.resolve(subjects) == %{{:user, user.id} => "dup1140"}
    end
  end

  # Counts `[:grappa, :repo, :query]` telemetry events emitted while `fun`
  # runs (Ecto emits one per statement, synchronously in the caller
  # process). Same shape as `Grappa.WindowCountsTest`'s N+1 pin.
  defp count_repo_queries(fun) do
    ref = make_ref()
    test_pid = self()

    :telemetry.attach(
      {__MODULE__, ref},
      [:grappa, :repo, :query],
      fn _, _, _, _ -> send(test_pid, {ref, :q}) end,
      nil
    )

    try do
      fun.()
    after
      :telemetry.detach({__MODULE__, ref})
    end

    drain_query_count(ref, 0)
  end

  defp drain_query_count(ref, acc) do
    receive do
      {^ref, :q} -> drain_query_count(ref, acc + 1)
    after
      0 -> acc
    end
  end
end
