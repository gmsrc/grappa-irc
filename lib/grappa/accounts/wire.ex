defmodule Grappa.Accounts.Wire do
  @moduledoc """
  Single source of truth for the public JSON wire shape of
  `Grappa.Accounts.User` rows.

  ## Why this module exists (read before adding fields)

  `User` carries an Argon2 `password_hash` and a virtual `password`
  field. `redact: true` on the virtual field protects `inspect/1`
  and Logger metadata, BUT does NOT protect `Jason.encode!/1` (which
  walks struct fields directly). Without an explicit allowlist
  serializer, any controller that does `json(conn, user)` leaks the
  password hash to the world. (The hash is salted + Argon2id, so a
  leak is far less catastrophic than the upstream IRC password
  exposure that `Grappa.Networks.Wire` defends against — but it is
  still credential material that must never appear on the wire.)

  The same hazard, sharper, on `Grappa.Accounts.Session`: that schema's
  `:id` is not a hash of the credential, it IS the credential. #1196's
  `client_token_to_json/1` is the allowlist that keeps it off the wire.

  Three output shapes today:

    * `user_to_json/1` — full profile shape `{id, name, is_admin,
      inserted_at}`. Used by `GrappaWeb.MeJSON.show/1` for `GET /me`
      AND by `GrappaWeb.Admin.MeController.index/2` for `GET /admin/me`
      (M-cluster M-2). The `is_admin` bit lands on every user-shape
      response so cic can gate admin-drawer rendering off the `me`
      envelope without a second round-trip.
    * `user_to_credential_json/1` — minimal credential-exchange shape
      `{id, name}`. Used by `GrappaWeb.AuthJSON.login/1` for the
      `POST /auth/login` response, where `inserted_at` would be
      gratuitous (login is a credential-exchange surface, not a
      profile lookup; clients call `GET /me` after login when they
      need the full profile).
    * `client_token_to_json/1` — the #1196 device-list shape
      `{handle, label, created_at, last_seen_at, ip, user_agent}` for
      `GET /me/client-tokens`. Deliberately id-less.

  Adding a field to either wire shape = one edit here. Removing a
  field = a breaking change visible at this single site.

  See `Grappa.Networks.Wire` and `Grappa.Scrollback.Wire` for the
  same pattern on credential and scrollback rows respectively.
  """

  alias Grappa.Accounts.{Session, User}

  @type user_json :: %{
          id: Ecto.UUID.t(),
          name: String.t(),
          is_admin: boolean(),
          inserted_at: DateTime.t()
        }

  @type credential_json :: %{
          id: Ecto.UUID.t(),
          name: String.t()
        }

  @typedoc """
  A per-client token as the account's own device list sees it (#1196).
  Carries no `id`: the id is the secret.
  """
  @type client_token_json :: %{
          handle: String.t(),
          label: String.t(),
          created_at: DateTime.t(),
          last_seen_at: DateTime.t(),
          ip: String.t() | nil,
          user_agent: String.t() | nil
        }

  @doc """
  Renders a `User` row to its full public JSON shape —
  `{id, name, is_admin, inserted_at}`. Excludes `:password_hash` and
  the virtual `:password`; both must NEVER appear on the wire.
  """
  @spec user_to_json(User.t()) :: user_json()
  def user_to_json(%User{} = user) do
    %{id: user.id, name: user.name, is_admin: user.is_admin, inserted_at: user.inserted_at}
  end

  @doc """
  Renders a `User` row to the minimal credential-exchange shape —
  `{id, name}`. Used for the `POST /auth/login` response body. See
  the moduledoc for why this is a separate shape from the full
  profile.
  """
  @spec user_to_credential_json(User.t()) :: credential_json()
  def user_to_credential_json(%User{} = user) do
    %{id: user.id, name: user.name}
  end

  @doc """
  Renders a per-client token (`Grappa.Accounts.Session` of kind
  `:client`, GH #1196) to its public JSON shape.

  The omission IS the feature. A session row's `:id` is the bearer
  token, so this shape publishes `Session.handle/1` — the one-way
  digest — and never the id. That is what makes "shown once at
  creation, never retrievable again" true of every read path at once,
  rather than a property each new controller has to remember: the
  minting response is the one place that renders the secret, and it
  does so explicitly and separately.

  `last_seen_at` and `ip` are the two fields that make an unexpected
  token visible to its owner, which is the point of the list.
  """
  @spec client_token_to_json(Session.t()) :: client_token_json()
  def client_token_to_json(%Session{kind: :client} = session) do
    %{
      handle: Session.handle(session),
      label: session.label,
      created_at: session.created_at,
      last_seen_at: session.last_seen_at,
      ip: session.ip,
      user_agent: session.user_agent
    }
  end
end
