defmodule GrappaWeb.ClientTokenJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.ClientTokenController` (GH #1196).

  Both shapes delegate to `Grappa.Accounts.Wire.client_token_to_json/1`,
  which is deliberately id-less — a session row's `:id` IS the bearer
  token. `create/1` is the ONE place in the codebase that puts it on the
  wire, and it does so by adding an explicit `:token` key on top of the
  id-less shape rather than by relaxing the allowlist. That is what
  keeps "shown once at creation, never retrievable again" a property of
  the serializer rather than a rule each new read path has to remember.
  """
  alias Grappa.Accounts.{Session, Wire}

  @doc "Renders the device list — `{tokens: [...]}`, no secrets."
  @spec index(%{tokens: [Session.t()]}) :: %{tokens: [Wire.client_token_json()]}
  def index(%{tokens: tokens}) when is_list(tokens) do
    %{tokens: Enum.map(tokens, &Wire.client_token_to_json/1)}
  end

  @doc """
  Renders a freshly minted token — the device-list shape PLUS `token`,
  the secret the client stores in its config. This response is the only
  time it is knowable.
  """
  @spec create(%{token: Session.t()}) :: map()
  def create(%{token: %Session{id: id} = session}) when is_binary(id) do
    session
    |> Wire.client_token_to_json()
    |> Map.put(:token, id)
  end
end
