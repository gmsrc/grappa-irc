defmodule GrappaWeb.Plugs.RequireFullSession do
  @moduledoc """
  Scope gate for the per-client token (GH #1196).

  A client token exists so that arming a second factor no longer locks a
  headless client out of the account. That is only a hardening — rather
  than a way around the second factor — if the token is strictly less
  than the account. This plug is where "strictly less" is spelled: it
  refuses, with a 403 tagged `client_token_scope`, every route it is
  mounted on when the authenticated bearer is a `:client` session.

  What it is mounted on, and why those:

    * the `:admin_authn` pipeline — the whole operator console;
    * `/me/totp*`, `/me/passkeys*` — the account's second factors. A
      credential that could disarm the factors it was issued under would
      make those factors decorative;
    * `DELETE /me` — self-service account deletion. Not named in #1196's
      list, but strictly worse than everything on it;
    * `/me/client-tokens*` — a token cannot mint, list, or revoke
      tokens. Without this, one leaked token is every future token.

  The account password lives on `PUT /admin/users/:id/password`, so the
  admin gate above already covers "cannot change the account password";
  there is no self-service password route to gate separately today. A
  future one MUST be mounted here — `GrappaWeb.RouterScopeTest` fails if
  a route whose path looks like credential management is reachable
  without this plug.

  What is deliberately NOT gated: reading and sending messages, the
  network verbs, settings, uploads, themes. Those are what a client is
  FOR, and the worst case of a leaked token is bounded to exactly them
  — bad, but revocable, and visible in the owner's own device list.

  Mount downstream of `GrappaWeb.Plugs.Authn`, which is what assigns
  `:current_session_kind`. An unauthenticated conn never reaches here;
  if a pipeline regression ever let one through, the missing assign
  falls to the refusing clause (fail-closed).
  """
  @behaviour Plug

  import Plug.Conn

  alias GrappaWeb.FallbackController

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(%Plug.Conn{assigns: %{current_session_kind: :web}} = conn, _), do: conn

  def call(conn, _) do
    conn
    |> FallbackController.call({:error, :client_token_scope})
    |> halt()
  end
end
