defmodule GrappaWeb.Admin.DbLatencyController do
  @moduledoc """
  Admin read-path for the #357 SQLite write-latency / repo query-latency
  diagnostics. Behind the `:admin_authn` pipeline; visitor + non-admin
  user subjects collapse to 403 upstream.

  ## GET /admin/db_latency

  Returns `200 OK` with the cumulative aggregate since boot (or the last
  reset) — the same table `Grappa.DbLatency.snapshot/0` feeds the
  `bin/grappa db-latency` CLI door (one feature, one code path, every
  door):

      %{
        "queries" => [%{"source" => "messages", "op" => "select",
                        "n" => 24, "total_ms" => 9809.0, "queue_ms" => …,
                        "mean_ms" => 408.7}, …],   # desc by total_ms
        "send_privmsg" => %{"n" => …, "mean_ms" => …, "outcomes" => …},
        "persist"      => %{"n" => …, "mean_ms" => …, "outcomes" => …},
        "contention"   => %{"n" => …, "queue_timeout" => …,
                            "busy_locked" => …, "dropped" => …}
      }

  ## POST /admin/db_latency/reset

  Zeroes every counter and returns `204 No Content` — call it, wait the
  sample window (e.g. 25s under load), then GET the snapshot.
  """
  use GrappaWeb, :controller

  alias Grappa.DbLatency

  @doc "Render the cumulative DB-latency aggregate (`GET /admin/db_latency`)."
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _), do: json(conn, DbLatency.snapshot())

  @doc "Zero the counters (`POST /admin/db_latency/reset`) → `204`."
  @spec reset(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def reset(conn, _) do
    :ok = DbLatency.reset()
    send_resp(conn, :no_content, "")
  end
end
