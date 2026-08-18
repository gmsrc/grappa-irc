defmodule GrappaWeb.Admin.DbLatencyControllerTest do
  @moduledoc """
  `GET /admin/db_latency` + `POST /admin/db_latency/reset` (#357) —
  read-path for the SQLite write-latency / repo query-latency
  diagnostics. Behind `:admin_authn`: visitor + non-admin collapse to
  403 upstream of the action.

  `async: false` — reads/mutates `Grappa.DbLatency`, an app-wide
  singleton (config `max_cases: 1`); concurrent tests would collide on
  its counters.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.DbLatency

  @handler_id "grappa-db-latency"

  setup do
    :ok = DbLatency.reset()
    :ok
  end

  describe "GET /admin/db_latency — auth gate" do
    test "no bearer returns 401", %{conn: conn} do
      assert conn |> get("/admin/db_latency") |> json_response(401) ==
               %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()

      assert conn |> put_bearer(session.id) |> get("/admin/db_latency") |> json_response(403) ==
               %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()

      assert conn |> put_bearer(session.id) |> get("/admin/db_latency") |> json_response(403) ==
               %{"error" => "forbidden"}
    end
  end

  describe "GET /admin/db_latency — admin snapshot" do
    test "200 exposes the empty aggregate shape when nothing is recorded", %{conn: conn} do
      session = admin_session()
      body = conn |> put_bearer(session.id) |> get("/admin/db_latency") |> json_response(200)

      assert %{
               "queries" => [],
               "send_privmsg" => %{"n" => 0},
               "persist" => %{"n" => 0},
               "contention" => %{"n" => 0}
             } = body
    end

    test "200 reflects a consumed [:grappa, :repo, :query] event", %{conn: conn} do
      # Mint the admin subject BEFORE attaching, so the fixture's own
      # inserts don't land in the aggregate. The auth-plug lookup on the
      # GET below IS captured — that's honest (the endpoint aggregates
      # real query traffic too), so assert the synthetic row by find,
      # not by exact list length.
      session = admin_session()

      :ok =
        :telemetry.attach_many(
          @handler_id,
          [[:grappa, :repo, :query]],
          &DbLatency.handle_telemetry/4,
          nil
        )

      on_exit(fn -> :telemetry.detach(@handler_id) end)

      :telemetry.execute(
        [:grappa, :repo, :query],
        %{total_time: System.convert_time_unit(12, :millisecond, :native)},
        %{source: "messages", query: ~s|SELECT m0."id" FROM "messages" AS m0|}
      )

      # Drain the cast before reading the HTTP snapshot.
      _ = DbLatency.snapshot()

      body = conn |> put_bearer(session.id) |> get("/admin/db_latency") |> json_response(200)

      row = Enum.find(body["queries"], &(&1["source"] == "messages" and &1["op"] == "select"))
      assert row["n"] == 1
    end
  end

  describe "POST /admin/db_latency/reset" do
    test "204 zeroes the counters", %{conn: conn} do
      session = admin_session()

      :ok =
        :telemetry.attach_many(
          @handler_id,
          [[:grappa, :repo, :query]],
          &DbLatency.handle_telemetry/4,
          nil
        )

      on_exit(fn -> :telemetry.detach(@handler_id) end)

      :telemetry.execute(
        [:grappa, :repo, :query],
        %{total_time: System.convert_time_unit(9, :millisecond, :native)},
        %{source: "messages", query: "SELECT 1"}
      )

      # Snapshot proves something WAS recorded before the reset.
      refute DbLatency.snapshot().queries == []

      assert conn |> put_bearer(session.id) |> post("/admin/db_latency/reset") |> response(204)

      # Detach so the assertion GET's own auth-lookup query isn't captured
      # after the reset — then the empty snapshot is unambiguous.
      :telemetry.detach(@handler_id)

      body = conn |> put_bearer(session.id) |> get("/admin/db_latency") |> json_response(200)
      assert body["queries"] == []
    end

    test "reset requires admin (visitor 403)", %{conn: conn} do
      {_, session} = visitor_and_session()

      assert conn |> put_bearer(session.id) |> post("/admin/db_latency/reset") |> json_response(403) ==
               %{"error" => "forbidden"}
    end
  end
end
