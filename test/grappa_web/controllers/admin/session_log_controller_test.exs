defmodule GrappaWeb.Admin.SessionLogControllerTest do
  @moduledoc """
  `GET /admin/session_log` (#215) — the disk-backed session-lifecycle log
  tail. Behind `:admin_authn`: visitor + non-admin user collapse to 403
  upstream of the action; admin user reaches the tail read.

  `async: true` — the action is a plain `Grappa.SessionLog.list/1` Repo
  read on the test's own sandbox connection; no singleton touched (the
  sink is not involved in the read path).
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Repo
  alias Grappa.SessionLog.Event

  defp insert_event(attrs) do
    defaults = %{
      session_id: "user:seed:7",
      event: :connected,
      subject_kind: :user,
      network_id: 7,
      network_slug: "az",
      nick: "vjt",
      at: DateTime.utc_now()
    }

    Repo.insert!(Event.changeset(%Event{}, Map.merge(defaults, attrs)))
  end

  describe "GET /admin/session_log — auth gate" do
    test "no bearer returns 401", %{conn: conn} do
      assert conn |> get("/admin/session_log") |> json_response(401) ==
               %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()

      assert conn |> put_bearer(session.id) |> get("/admin/session_log") |> json_response(403) ==
               %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()

      assert conn |> put_bearer(session.id) |> get("/admin/session_log") |> json_response(403) ==
               %{"error" => "forbidden"}
    end
  end

  describe "GET /admin/session_log — admin user" do
    test "200 returns newest-first entries with structured fields", %{conn: conn} do
      insert_event(%{session_id: "user:a:7", event: :connected})

      insert_event(%{
        session_id: "user:b:7",
        event: :disconnected,
        reason: ":tcp_closed",
        clean: false,
        duration_ms: 5
      })

      session = admin_session()
      body = conn |> put_bearer(session.id) |> get("/admin/session_log") |> json_response(200)

      assert %{"session_log" => [first, second]} = body
      # Newest-first: the disconnected row was inserted last.
      assert first["session_id"] == "user:b:7"
      assert first["event"] == "disconnected"
      assert first["reason"] == ":tcp_closed"
      assert first["clean"] == false
      assert first["duration_ms"] == 5
      assert second["session_id"] == "user:a:7"
    end

    test "?limit caps the number of entries", %{conn: conn} do
      for n <- 1..5, do: insert_event(%{session_id: "user:u#{n}:7"})

      session = admin_session()

      body =
        conn |> put_bearer(session.id) |> get("/admin/session_log?limit=2") |> json_response(200)

      assert length(body["session_log"]) == 2
    end

    test "empty log returns an empty list", %{conn: conn} do
      session = admin_session()
      body = conn |> put_bearer(session.id) |> get("/admin/session_log") |> json_response(200)
      assert body == %{"session_log" => []}
    end
  end

  describe "GET /admin/session_log/sessions (#1158 item 4)" do
    test "no bearer returns 401", %{conn: conn} do
      assert conn |> get("/admin/session_log/sessions") |> json_response(401) ==
               %{"error" => "unauthorized"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()

      assert conn
             |> put_bearer(session.id)
             |> get("/admin/session_log/sessions")
             |> json_response(403) == %{"error" => "forbidden"}
    end

    test "200 returns the newest event of each session, one row per session", %{conn: conn} do
      insert_event(%{session_id: "visitor:v1:7", subject_kind: :visitor, event: :connected})
      insert_event(%{session_id: "user:a:7", event: :connected})

      insert_event(%{
        session_id: "visitor:v1:7",
        subject_kind: :visitor,
        event: :disconnected,
        reason: ":quit",
        clean: true,
        duration_ms: 900
      })

      session = admin_session()

      body =
        conn
        |> put_bearer(session.id)
        |> get("/admin/session_log/sessions")
        |> json_response(200)

      assert %{"session_log_sessions" => [first, second]} = body
      assert first["session_id"] == "visitor:v1:7"
      assert first["event"] == "disconnected"
      assert first["reason"] == ":quit"
      assert first["duration_ms"] == 900
      assert second["session_id"] == "user:a:7"
      assert second["event"] == "connected"
    end

    test "?limit caps the number of sessions", %{conn: conn} do
      for n <- 1..5, do: insert_event(%{session_id: "user:u#{n}:7"})

      session = admin_session()

      body =
        conn
        |> put_bearer(session.id)
        |> get("/admin/session_log/sessions?limit=2")
        |> json_response(200)

      assert length(body["session_log_sessions"]) == 2
    end

    test "empty log returns an empty list", %{conn: conn} do
      session = admin_session()

      body =
        conn
        |> put_bearer(session.id)
        |> get("/admin/session_log/sessions")
        |> json_response(200)

      assert body == %{"session_log_sessions" => []}
    end
  end
end
