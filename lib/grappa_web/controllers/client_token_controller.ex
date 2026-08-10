defmodule GrappaWeb.ClientTokenController do
  @moduledoc """
  The account's own per-client tokens (GH #1196).

  A per-client token is what a headless client presents in place of the
  account password, so that arming TOTP or a passkey stops being a
  choice between a second factor and an always-on client. These three
  verbs are how one is issued, seen, and killed:

    * `POST /me/client-tokens` — mint. Returns the secret ONCE.
    * `GET /me/client-tokens` — the device list. Never returns a secret.
    * `DELETE /me/client-tokens/:handle` — revoke a single token.

  All three sit behind `GrappaWeb.Plugs.RequireFullSession`, so a client
  token cannot reach them: a token that could mint tokens would make one
  leak permanent, and a token that could list them would break the
  shown-once contract.

  Minting is additionally password-gated, the same way
  `GrappaWeb.TotpController` gates enrolment and for the same reason: a
  borrowed browser bearer alone must not be able to issue a credential
  that outlives it. Combined with the scope gate, "issued only from a
  session that has already cleared the second factor" holds by
  construction — a `:web` bearer reached its token through whatever
  factors the account has armed, and now re-proves the password on top.

  Visitors have no account, no password and no second factor, so the
  whole surface is `:forbidden` for them.
  """
  use GrappaWeb, :controller

  alias Grappa.Accounts
  alias GrappaWeb.RemoteIP

  @doc "Lists the caller's live client tokens. Secrets are not included."
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :forbidden}
  def index(%{assigns: %{current_subject: {:user, user}}} = conn, _) do
    render(conn, :index, tokens: Accounts.list_client_tokens(user))
  end

  def index(_, _), do: {:error, :forbidden}

  @doc """
  Mints a client token and returns it once.

  Requires the account password alongside the label — see the moduledoc
  for why a valid bearer is not sufficient on its own.
  """
  @spec create(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom() | Ecto.Changeset.t()}
  def create(
        %{assigns: %{current_subject: {:user, user}}} = conn,
        %{"label" => label, "password" => password}
      )
      when is_binary(label) and is_binary(password) do
    with :ok <- Accounts.verify_password(user, password),
         {:ok, session} <-
           Accounts.create_client_token(user, label, RemoteIP.format(conn), user_agent(conn),
             client_id: conn.assigns[:current_client_id]
           ) do
      conn
      |> put_status(:created)
      |> render(:create, token: session)
    end
  end

  def create(%{assigns: %{current_subject: {:user, _}}}, _), do: {:error, :bad_request}

  def create(_, _), do: {:error, :forbidden}

  @doc """
  Revokes one of the caller's client tokens by its public handle.

  Scoped to the caller's own tokens, so a handle belonging to another
  account is a 404 and not a cross-account kill switch. Unlike minting
  this is NOT password-gated: revocation is the safe direction, and a
  kill switch that is hard to reach is a kill switch nobody pulls.
  """
  @spec delete(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :forbidden | :not_found | :db_unavailable}
  def delete(%{assigns: %{current_subject: {:user, user}}} = conn, %{"handle" => handle})
      when is_binary(handle) do
    with :ok <- Accounts.revoke_client_token(user, handle) do
      send_resp(conn, :no_content, "")
    end
  end

  def delete(_, _), do: {:error, :forbidden}

  @spec user_agent(Plug.Conn.t()) :: String.t() | nil
  defp user_agent(conn) do
    case get_req_header(conn, "user-agent") do
      [ua | _] -> ua
      [] -> nil
    end
  end
end
