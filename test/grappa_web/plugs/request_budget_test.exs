defmodule GrappaWeb.Plugs.RequestBudgetTest do
  @moduledoc """
  GH #630 — the REST door of the coarse inbound request budget. The plug
  meters WRITE methods only and calls the SAME `GrappaWeb.RequestBudget`
  guard the WS door uses: over budget → halt 429 (+ `Retry-After`), and
  the sever crossing revokes the bearer. Deterministic against
  config/test.exs (capacity 5, sever_after 3).
  """
  use Grappa.DataCase, async: false

  import Plug.Test
  import Plug.Conn, only: [assign: 3, get_resp_header: 2]
  import Grappa.AuthFixtures

  alias Grappa.Accounts
  alias GrappaWeb.Plugs.RequestBudget

  defp write_conn(subject_struct, session_id) do
    :post
    |> conn("/x")
    |> assign(:current_subject, subject_struct)
    |> assign(:current_session_id, session_id)
  end

  test "write methods: a full burst passes, then the plug halts 429 with a retry hint" do
    subject = {:user, user_fixture()}
    sid = Ecto.UUID.generate()

    # capacity 5 → first 5 writes pass untouched.
    for _ <- 1..5 do
      conn = RequestBudget.call(write_conn(subject, sid), [])
      refute conn.halted
      assert is_nil(conn.status)
    end

    # 6th over budget → halted 429 with the snake_case envelope + Retry-After.
    conn = RequestBudget.call(write_conn(subject, sid), [])
    assert conn.halted
    assert conn.status == 429
    assert conn.resp_body =~ "rate_limited"
    assert [retry] = get_resp_header(conn, "retry-after")
    assert String.to_integer(retry) >= 1
  end

  test "GET reads are never metered" do
    subject = {:user, user_fixture()}
    sid = Ecto.UUID.generate()

    for _ <- 1..20 do
      conn =
        :get
        |> conn("/x")
        |> assign(:current_subject, subject)
        |> assign(:current_session_id, sid)
        |> RequestBudget.call([])

      refute conn.halted
    end
  end

  test "sever crossing halts 429 AND revokes the auth bearer (reconnect refused until re-auth)" do
    user = user_fixture()
    {:ok, session} = Accounts.create_session({:user, user.id}, nil, nil, [])
    subject = {:user, user}

    # Burn capacity (5) + the first 2 over-budget events (sever_after 3) —
    # 7 writes, no sever yet.
    for _ <- 1..7, do: RequestBudget.call(write_conn(subject, session.id), [])
    assert {:ok, _} = Accounts.authenticate(session.id)

    # 8th write = 3rd over-budget = the sever crossing.
    conn = RequestBudget.call(write_conn(subject, session.id), [])
    assert conn.halted and conn.status == 429
    assert {:error, :revoked} = Accounts.authenticate(session.id)
  end
end
