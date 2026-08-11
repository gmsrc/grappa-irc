defmodule GrappaWeb.Admin.SessionLogController do
  @moduledoc """
  Admin read surface over the persisted IRC session-lifecycle log (#215).
  Behind `:admin_authn` — visitor + non-admin user collapse to 403
  upstream of the action.

  ## GET /admin/session_log

  Newest-first tail of `session_log_events`, bounded by `?limit` (default
  #{200}, max #{1000}). Wire shape (single-sourced by
  `Grappa.SessionLog.Wire`):

      %{session_log: [%{id, session_id, event, subject_kind, network_id,
                        network_slug, nick, reason, clean, duration_ms,
                        delay_ms, attempt, at}, ...]}

  The snapshot door (cic fetches on tab mount); live updates arrive via
  the admin Channel's `session_log_event` push. One feature, three doors —
  context (`Grappa.SessionLog`) → controller (here) → channel.

  ## GET /admin/session_log/sessions

  The same entries collapsed to one per `session_id` — each session's
  NEWEST event — newest-first, bounded by `?limit` in SESSIONS. Wire
  shape `%{session_log_sessions: [...]}` (`Grappa.SessionLog.Wire`).

  This is what lets the admin Sessions view list a session whose subject
  row is gone (#1158 item 4): `session_id` is `(subject, network)`-grained
  — the very key the session rows are built on — and the log carries no
  FK to the subject, so it outlives the visitor purge. Best-effort by
  construction: a session missing from this list is not evidence it never
  existed.
  """
  use GrappaWeb, :controller

  alias Grappa.SessionLog
  alias Grappa.SessionLog.Wire

  @default_limit 200
  @max_limit 1000

  @doc false
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, params) do
    entries = SessionLog.list(parse_limit(params))
    json(conn, Wire.list_payload(entries))
  end

  @doc false
  @spec sessions(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def sessions(conn, params) do
    entries = SessionLog.list_latest_per_session(parse_limit(params))
    json(conn, Wire.sessions_payload(entries))
  end

  # `?limit` is a defensive clamp — a malformed / out-of-range value falls
  # back to the default rather than erroring (a read endpoint shouldn't 400
  # on a bad query param).
  @spec parse_limit(map()) :: pos_integer()
  defp parse_limit(%{"limit" => raw}) when is_binary(raw) do
    case Integer.parse(raw) do
      {n, ""} when n > 0 -> min(n, @max_limit)
      _ -> @default_limit
    end
  end

  defp parse_limit(_), do: @default_limit
end
