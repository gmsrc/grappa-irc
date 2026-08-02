defmodule GrappaWeb.Plugs.RequestBudget do
  @moduledoc """
  GH #630 — the REST door of the coarse per-subject inbound request
  budget. Mounted downstream of `:authn` (needs `current_subject` +
  `current_session_id`) on every authenticated resource scope; it meters
  only WRITE methods (`POST`/`PUT`/`PATCH`/`DELETE`) — GET reads (scrollback
  pagination, snapshots) are legitimate high-volume traffic and are not the
  flood vector, so they pass through untouched.

  It calls `GrappaWeb.RequestBudget.guard/3` — the SAME decision + sever
  code path the WS `handle_in` guard uses (one feature, one code path, both
  doors). Over budget → HTTP `429` with the snake_case `rate_limited`
  envelope + a `Retry-After` header and a `retry_after_ms` body hint. The
  sever crossing already closed the socket + revoked the bearer inside
  `guard/3`; the offending REST response is still a `429` (this request WAS
  over budget), and the now-revoked bearer 401s every subsequent request.

  #340's per-(subject, network) send bucket stays ON TOP for `POST
  /messages` — a send consumes a coarse budget token here AND a send token
  there; this outer gate is what stops a flood of the CHEAP write doors
  (nick, read-cursor, notify, window CRUD) #340 never saw.
  """

  @behaviour Plug

  import Plug.Conn
  import Phoenix.Controller, only: [json: 2]

  alias Grappa.RateLimit.RequestBudget
  alias GrappaWeb.Subject

  @write_methods ~w(POST PUT PATCH DELETE)

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(%Plug.Conn{method: method} = conn, _) when method in @write_methods do
    case conn.assigns do
      %{current_subject: current_subject, current_session_id: session_id}
      when is_binary(session_id) ->
        subject = Subject.to_session(current_subject)
        user_name = Subject.topic_label(current_subject)

        case GrappaWeb.RequestBudget.guard(subject, session_id, user_name) do
          :ok -> conn
          # Both :rate_limited and :severed refuse THIS request with 429;
          # the sever side-effects (close + revoke) already fired in guard/3.
          {:error, _} -> refuse(conn)
        end

      _ ->
        # Unauthenticated (plug mounted after :authn, so this is defensive):
        # :authn has already halted, nothing to meter.
        conn
    end
  end

  # Read methods (GET/HEAD/OPTIONS) are not metered.
  def call(conn, _), do: conn

  @spec refuse(Plug.Conn.t()) :: Plug.Conn.t()
  defp refuse(conn) do
    retry_ms = RequestBudget.retry_after_ms()

    conn
    |> put_resp_header("retry-after", Integer.to_string(ceil(retry_ms / 1000)))
    |> put_status(:too_many_requests)
    |> json(%{error: "rate_limited", retry_after_ms: retry_ms})
    |> halt()
  end
end
