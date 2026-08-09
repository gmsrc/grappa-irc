defmodule GrappaWeb.Admin.OverviewController do
  @moduledoc """
  Admin read-path for the operator top bar (#1075). Behind the
  `:admin_authn` pipeline; visitor + non-admin user subjects collapse to
  403 upstream.

  ## GET /admin/overview

  Returns `200 OK` with the scalar projection `Grappa.AdminOverview.snapshot/0`
  builds — the SAME payload `GrappaWeb.AdminChannel` pushes as `"overview"`
  on join and on each tick (one feature, one code path, every door). This
  door exists so a client can populate the bar without a socket, and so
  `curl` remains an operator tool.

      %{
        "sessions" => 3,
        "visitors" => %{"total" => 5, "live" => 2},
        "hostname" => "m42",
        "loadavg"  => 0.42,     # or null when the sampler is unavailable
        "version"  => "0.13.0-abc1234"
      }

  ## No proxy change is required for this route

  Admin routes in this app used to need a matching entry in an nginx
  allowlist, and several sibling routes still carry comments saying so
  (`/db_latency`, and #269's deliberate nesting under `/admin/sessions/`).
  That constraint is gone: #485 collapsed every nginx substrate to a dumb
  reverse proxy — `infra/snippets/locations-api.conf` forwards `location /`
  to the BEAM unfiltered and states the allowlist "is GONE". The gate for
  this route is `:admin_authn` alone, which is why it can sit at the top
  level of the admin scope instead of being nested under an existing
  prefix.
  """
  use GrappaWeb, :controller

  alias Grappa.AdminOverview

  @doc "Render the admin-bar projection (`GET /admin/overview`)."
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _), do: json(conn, AdminOverview.snapshot())
end
