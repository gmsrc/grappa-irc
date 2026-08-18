defmodule GrappaWeb.Admin.OverviewControllerTest do
  @moduledoc """
  `GET /admin/overview` (#1075) — the scalar projection behind the admin
  top bar. Behind `:admin_authn`: visitor + non-admin user subjects
  collapse to 403 upstream of the action.

  `async: false` — the snapshot counts the singleton
  `Grappa.SessionRegistry` (`max_cases: 1` keeps the suite serial).
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.AdmissionStateHelpers

  setup do
    AdmissionStateHelpers.reset_all()
    :ok
  end

  describe "GET /admin/overview — auth gate" do
    test "no bearer returns 401", %{conn: conn} do
      assert conn |> get("/admin/overview") |> json_response(401) ==
               %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()

      assert conn |> put_bearer(session.id) |> get("/admin/overview") |> json_response(403) ==
               %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()

      assert conn |> put_bearer(session.id) |> get("/admin/overview") |> json_response(403) ==
               %{"error" => "forbidden"}
    end
  end

  describe "GET /admin/overview — the snapshot" do
    test "200 carries all five stats the bar renders", %{conn: conn} do
      session = admin_session()

      body = conn |> put_bearer(session.id) |> get("/admin/overview") |> json_response(200)

      assert %{
               "sessions" => sessions,
               "visitors" => %{"total" => total, "live" => live},
               "hostname" => hostname,
               "loadavg" => loadavg,
               "version" => version
             } = body

      assert is_integer(sessions) and sessions >= 0
      assert is_integer(total) and total >= 0
      assert is_integer(live) and live >= 0
      assert is_binary(hostname) and hostname != ""
      assert is_float(loadavg)
      assert version == Grappa.Version.current()
    end

    test "200 reflects a visitor row the registry has no pid for", %{conn: conn} do
      # The DB/live pair on the wire: the bar shows `live/total`, so an
      # operator reads "1 visitor exists, none is connected" without
      # opening the tab. Derived-from-each-other counts could never say
      # this.
      session = admin_session()
      _ = visitor_fixture()

      body = conn |> put_bearer(session.id) |> get("/admin/overview") |> json_response(200)

      assert %{"visitors" => %{"total" => 1, "live" => 0}} = body
    end
  end
end
