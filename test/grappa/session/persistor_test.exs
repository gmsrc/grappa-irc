defmodule Grappa.Session.PersistorTest do
  @moduledoc """
  #1657b — the census line and the row's existence must never disagree.

  #1657 moved the `scrollback row dropped` line to the one door every
  persist passes through, so the #1429 count stopped being a floor taken
  from two of five call sites. It did NOT check the other direction: the
  line asserts a row is GONE, and the write path had an arm where the row
  was durably written and the line fired anyway.

  That arm was the second retry-wrapped op in `Scrollback.persist_row/1` —
  `Repo.preload(message, :network)`, run AFTER the insert had committed.
  `scrollback.ex` knew it ("the row IS durably written but has no
  `:network` assoc for the wire payload") and returned the same
  `:persist_unavailable` atom as a row that never landed, so `Persistor`
  logged the drop for a row sitting in the table.

  An instrument that over-reports a loss is the same defect class #1657
  spent its night removing, only pointed the other way. A count that is
  neither a floor nor a ceiling is worse than one known to be a floor,
  because nothing on the line says which arm produced it.

  The pair below pins BOTH directions, and it has to be a pair: the lazy
  way to make the first test green is to delete the line, and the second
  test is what makes that cost visible.
  """
  use Grappa.DataCase, async: false

  import ExUnit.CaptureLog

  alias Grappa.{Accounts, Networks, Repo}
  alias Grappa.Repo.BusyRetry
  alias Grappa.Scrollback.Message
  alias Grappa.Session.Persistor

  @census_prefix "scrollback row dropped"

  setup do
    {:ok, user} =
      Accounts.create_user(%{name: "vjt-#{uniq()}", password: "correct horse battery"})

    {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra-#{uniq()}"})

    %{user: user, network: network}
  end

  defp uniq, do: System.unique_integer([:positive])

  defp attrs(user, network, channel) do
    %{
      user_id: user.id,
      network_id: network.id,
      channel: channel,
      server_time: System.system_time(:millisecond),
      kind: :privmsg,
      sender: "alice",
      body: "ciao",
      meta: %{}
    }
  end

  defp ctx(user, network) do
    %{
      subject: {:user, user.id},
      subject_label: user.name,
      network_slug: network.slug,
      network_id: network.id,
      nick: "vjt"
    }
  end

  defp rows_in(network, channel) do
    query = from(m in Message, where: m.network_id == ^network.id and m.channel == ^channel)
    Repo.aggregate(query, :count)
  end

  # Arm the retry engine against THIS process and hand back what the door
  # logged. `fire_on` is 1-indexed over `BusyRetry.run/2` fault CHECKS on this
  # pid, and the whole point of the pair below is which check gets faulted:
  # the persist's FIRST retry-wrapped op, or a LATER one that can only run
  # once the insert has already committed. 10_000 armed faults outlast the
  # wall-clock budget, so the op degrades instead of recovering.
  defp capture_faulted_persist(fire_on, fun) do
    BusyRetry.arm_faults(self(), 10_000, fire_on: fire_on)
    on_exit(fn -> BusyRetry.disarm_faults(self()) end)

    log = capture_log(fun)

    BusyRetry.disarm_faults(self())
    log
  end

  describe "the census line never claims a drop for a row that is in the table (#1657b)" do
    test "a durably-written row is not reported as dropped", %{user: user, network: net} do
      channel = "#durable-#{uniq()}"

      # `fire_on: 2` rides out the persist's FIRST retry-wrapped op and faults
      # from the second on. The insert therefore commits, and only whatever
      # runs after it can fail — which is exactly the arm that used to report
      # a loss that had not happened.
      log =
        capture_faulted_persist(2, fn ->
          Persistor.persist_and_broadcast(attrs(user, net, channel), ctx(user, net), push: false)
        end)

      # The row is the product, and it is THERE. Asserted first and
      # unconditionally: without it the refute below could pass on a path that
      # simply never wrote anything.
      assert rows_in(net, channel) == 1

      refute log =~ @census_prefix
    end

    test "a row that never landed IS reported as dropped", %{user: user, network: net} do
      channel = "#lost-#{uniq()}"

      # `fire_on: 1` faults the persist's own first attempt, so nothing ever
      # commits. This is the #1657 property, restated here as the guard that
      # stops the test above from being satisfied by deleting the line.
      log =
        capture_faulted_persist(1, fn ->
          assert {:error, :persist_unavailable} =
                   Persistor.persist_and_broadcast(
                     attrs(user, net, channel),
                     ctx(user, net),
                     push: false
                   )
        end)

      assert rows_in(net, channel) == 0
      assert log =~ @census_prefix
    end
  end
end
