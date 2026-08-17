defmodule GrappaWeb.MeThemeController do
  @moduledoc """
  The subject's ACTIVE theme pair — a server-persisted, per-subject
  `{light, dark}` pointer pair (#75 fork-1, cross-device; #358 day/night).
  Behind `[:api, :authn]`.

      GET /me/theme   resolved `%{"light" => wire|null, "dark" => wire|null}`   :show
      PUT /me/theme   set the pair: `{light: id}` or `{light: id, dark: id}`    :update

  `GET` returns fully-resolved theme wires (not scalar ids) so the client
  applies them directly. `light` is the day (light-mode) slot; `dark` is the
  optional night (dark-mode) slot — `null` dark means the light theme applies
  in both modes (the #75 single pick). cic resolves which slot to paint from
  the OS `prefers-color-scheme` signal (#358), never the server. A dangling
  pointer (theme deleted) resolves to `null` and cic falls back to its default.

  `PUT` takes the full desired pair: `light` (required) + optional `dark`
  (omit or `null` for a single pick). BOTH ids are validated before either
  persists — a bad dark 404s without half-applying. Distinct from
  `GrappaWeb.ThemesController` because active-theme selection is a
  `UserSettings`-backed pointer, not a theme resource CRUD op.
  """

  use GrappaWeb, :controller

  alias Grappa.{Subject, Themes}
  alias Grappa.Themes.Wire

  @doc false
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show(conn, _) do
    viewer = conn.assigns.current_subject
    subject = Subject.from_assigns(conn.assigns)

    json(conn, pair_wire(Themes.get_active_theme_pair(subject), viewer))
  end

  @doc false
  @spec update(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :not_found | Ecto.Changeset.t() | :db_unavailable}
  def update(conn, %{"light" => light} = params) do
    viewer = conn.assigns.current_subject
    subject = Subject.from_assigns(conn.assigns)

    with {:ok, light_id} <- parse_id(light),
         {:ok, dark_id} <- parse_optional_id(Map.get(params, "dark")),
         {:ok, pair} <- Themes.set_active_theme_pair(subject, light_id, dark_id) do
      json(conn, pair_wire(pair, viewer))
    end
  end

  def update(_, _), do: {:error, :bad_request}

  # A resolved pair → its wire envelope, each slot a full theme wire or null.
  defp pair_wire(%{light: light, dark: dark}, viewer),
    do: Wire.active_pair(slot_wire(light, viewer), slot_wire(dark, viewer))

  defp slot_wire(nil, _), do: nil
  defp slot_wire(theme, viewer), do: Wire.to_wire(theme, viewer, Themes.count_theme_usage(theme.id))

  defp parse_optional_id(nil), do: {:ok, nil}
  defp parse_optional_id(id), do: parse_id(id)

  defp parse_id(id) when is_integer(id), do: {:ok, id}

  defp parse_id(id) when is_binary(id) do
    case Integer.parse(id) do
      {n, ""} -> {:ok, n}
      _ -> {:error, :not_found}
    end
  end

  defp parse_id(_), do: {:error, :not_found}
end
