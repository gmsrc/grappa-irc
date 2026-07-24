defmodule GrappaWeb.MeThemeControllerTest do
  @moduledoc """
  Active-theme surface (#75 fork-1, #358 day/night pair) — server-persisted
  per-subject `{light, dark}` pointer pair.

    * `GET /me/theme` — resolved `%{"light" => wire|null, "dark" => wire|null}`.
    * `PUT /me/theme` — set the pair: `{light: id}` (single) or
      `{light: id, dark: id}` (day/night). 404 on an unknown id.

  Backward-compat: a single `{light: id}` PUT stores `dark: null` (the pair
  resolves to the same theme in both modes) — the #75 one-theme behaviour.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Themes
  alias Grappa.Themes.TokenModel

  defp valid_payload do
    %{
      "colors" => Map.new(TokenModel.color_keys(), fn k -> {k, "#123456"} end),
      "font_family" => "mono-default",
      "background" => %{"image_id" => nil, "builtin" => nil, "size" => "cover", "opacity" => 0.3}
    }
  end

  defp make_theme(user, name) do
    {:ok, theme} = Themes.create_theme({:user, user}, %{name: name, payload: valid_payload()})
    theme
  end

  setup %{conn: conn} do
    {user, session} = user_and_session()
    {:ok, conn: put_bearer(conn, session.id), user: user}
  end

  test "401 without a bearer", %{} do
    assert json_response(get(build_conn(), "/me/theme"), 401) == %{"error" => "unauthorized"}
  end

  test "GET returns a null pair when no active theme is set", %{conn: conn} do
    assert json_response(get(conn, "/me/theme"), 200) == %{"light" => nil, "dark" => nil}
  end

  test "PUT with only light sets a single (backward-compat) pick", %{conn: conn, user: user} do
    theme = make_theme(user, "Mine")

    put_body = json_response(put(conn, "/me/theme", %{"light" => theme.id}), 200)
    assert put_body["light"]["id"] == theme.id
    assert put_body["dark"] == nil

    get_body = json_response(get(conn, "/me/theme"), 200)
    assert get_body["light"]["id"] == theme.id
    assert get_body["light"]["payload"] == valid_payload()
    assert get_body["dark"] == nil
  end

  test "PUT with distinct light + dark persists both slots", %{conn: conn, user: user} do
    day = make_theme(user, "Day")
    night = make_theme(user, "Night")

    put_body = json_response(put(conn, "/me/theme", %{"light" => day.id, "dark" => night.id}), 200)
    assert put_body["light"]["id"] == day.id
    assert put_body["dark"]["id"] == night.id

    get_body = json_response(get(conn, "/me/theme"), 200)
    assert get_body["light"]["id"] == day.id
    assert get_body["dark"]["id"] == night.id
  end

  test "PUT with dark == light collapses to a single pick (dark null)", %{conn: conn, user: user} do
    theme = make_theme(user, "Same")

    put_body =
      json_response(put(conn, "/me/theme", %{"light" => theme.id, "dark" => theme.id}), 200)

    assert put_body["light"]["id"] == theme.id
    assert put_body["dark"] == nil
  end

  test "PUT with light then a light-only re-PUT clears a previously-set dark", %{
    conn: conn,
    user: user
  } do
    day = make_theme(user, "Day")
    night = make_theme(user, "Night")

    _ = put(conn, "/me/theme", %{"light" => day.id, "dark" => night.id})
    reset = json_response(put(conn, "/me/theme", %{"light" => day.id}), 200)
    assert reset["dark"] == nil

    assert json_response(get(conn, "/me/theme"), 200)["dark"] == nil
  end

  test "PUT with an unknown light id → 404 (nothing persisted)", %{conn: conn} do
    assert json_response(put(conn, "/me/theme", %{"light" => 9_999_999}), 404) ==
             %{"error" => "not_found"}

    assert json_response(get(conn, "/me/theme"), 200) == %{"light" => nil, "dark" => nil}
  end

  test "PUT with a valid light but unknown dark → 404 (light NOT persisted, atomic)", %{
    conn: conn,
    user: user
  } do
    day = make_theme(user, "Day")

    assert json_response(put(conn, "/me/theme", %{"light" => day.id, "dark" => 9_999_999}), 404) ==
             %{"error" => "not_found"}

    # Atomic: a bad dark rolls back the whole pair — light must NOT have stuck.
    assert json_response(get(conn, "/me/theme"), 200) == %{"light" => nil, "dark" => nil}
  end

  test "PUT with no light → 400 bad_request", %{conn: conn} do
    assert json_response(put(conn, "/me/theme", %{"dark" => 1}), 400) ==
             %{"error" => "bad_request"}
  end
end
