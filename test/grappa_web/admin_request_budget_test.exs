defmodule GrappaWeb.AdminRequestBudgetTest do
  @moduledoc """
  #1404 — the operator console consumes the same per-subject request
  budget every other authenticated scope does.

  **Driven, not read.** `Phoenix.Router.__routes__/0` does not expose a
  route's `pipe_through` list, so a structural assertion about the scope is
  not available; and a test that greps `router.ex` for the pipeline name
  would pin the SOURCE, which is not a witness that the plug ran. So this
  drives a real admin write until the budget refuses it.

  `async: false` — `put_test_config/1` writes `:persistent_term`, which is
  node-global.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Accounts
  alias Grappa.RateLimit.RequestBudget, as: Budget

  # Small enough to exhaust in a handful of calls, and `sever_after` set
  # above the number of refusals this test provokes: crossing it would
  # revoke the bearer and turn the 429 under test into a 401, which is a
  # different control answering.
  @capacity 3
  @sever_after 50

  setup do
    original = Budget.config()

    Budget.put_test_config(%Budget{
      capacity: @capacity,
      refill_per_sec: 0.001,
      sever_after: @sever_after,
      sever_window_ms: 60_000
    })

    on_exit(fn -> Budget.put_test_config(original) end)
    :ok
  end

  defp admin_bearer(conn) do
    {user, session} = user_and_session()
    {:ok, _} = Accounts.update_admin_flags(user, %{is_admin: true})
    put_bearer(conn, session.id)
  end

  describe "the admin scope is metered" do
    test "an admin write is refused once the subject's budget is spent", %{conn: conn} do
      conn = admin_bearer(conn)

      # Pre-state: the door is open before the budget is spent. Without
      # this the 429 below could just as well mean the route is broken.
      assert conn |> post("/admin/db_latency/reset") |> Map.fetch!(:status) == 204

      statuses =
        for _ <- 1..(@capacity + 2) do
          conn |> post("/admin/db_latency/reset") |> Map.fetch!(:status)
        end

      assert 429 in statuses,
             "the operator console spent no budget: got #{inspect(statuses)}"

      assert Enum.all?(statuses, &(&1 in [204, 429])),
             "expected only 204/429, got #{inspect(statuses)} — another control answered"
    end

    test "an admin READ is not metered, matching every other scope" do
      # The budget meters writes only, and the console must not be the one
      # scope where that stops being true — a metered GET would make the
      # operator's own dashboard poll a flood.
      conn = admin_bearer(Phoenix.ConnTest.build_conn())

      statuses =
        for _ <- 1..(@capacity + 3) do
          conn |> get("/admin/db_latency") |> Map.fetch!(:status)
        end

      assert Enum.all?(statuses, &(&1 == 200)), "got #{inspect(statuses)}"
    end
  end
end
