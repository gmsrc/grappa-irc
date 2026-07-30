defmodule GrappaWeb.Admin.SettingsController do
  @moduledoc """
  Admin verbs over `Grappa.ServerSettings`. Behind `:admin_authn` —
  visitor + non-admin user collapse to 403 upstream.

  ## GET /admin/settings

  Returns the admin settings view — the `upload` subtree of
  `public_view/0` plus the admin-only `addressing` subtree (#543, read
  straight from the `Grappa.ServerSettings` accessors, NOT part of
  `public_view/0`). It deliberately OMITS the #324 `http_host_aliases`
  that the authenticated `/api/server-settings` carries: those are
  deployment config (env-derived), not an admin-editable DB setting.
  Wire shape:

      %{
        settings: %{
          upload: %{
            active_host: "embedded" | "litterbox",
            image_per_file_cap_bytes: pos_integer(),
            video_per_file_cap_bytes: pos_integer(),
            document_per_file_cap_bytes: pos_integer(),
            global_cap_bytes: pos_integer()
          },
          addressing: %{
            mode: "pool_with_reservations" | "static_mapping_with_reservations",
            static_mapping_prefix: String.t() | nil
          }
        }
      }

  ## PUT /admin/settings

  Body shape:

      %{
        "upload" => %{
          "active_host" => "embedded" | "litterbox",
          "image_per_file_cap_bytes" => pos_integer(),
          "video_per_file_cap_bytes" => pos_integer(),
          "document_per_file_cap_bytes" => pos_integer(),
          "global_cap_bytes" => pos_integer()
        },
        "addressing" => %{
          "mode" => "pool_with_reservations" | "static_mapping_with_reservations",
          "static_mapping_prefix" => String.t()
        }
      }

  Both `upload` and `addressing` are independently optional subtrees, and
  every key within each is optional — the controller upserts only the keys
  present in the body. Any invalid value (out-of-set host/mode string,
  non-positive integer cap, non-16-bit-group prefix length) collapses to
  422 `invalid_setting` with the offending dotted key in `field`.

  On success: 200 with the new full settings view AND fan-out of a
  `server_settings_changed` push on every live `Topic.user(name)`
  for cic reactive update without a poll. Same precedent +
  iterator as `AdminController.cic_bundle_changed/2` (CP23 S4 B5
  cic-bundle fan-out): one broadcast per operator with a live WS.
  Wire-shape lives at `Grappa.ServerSettings.Wire`.

  The intermediate `Grappa.ServerSettings.topic/0` broadcast that
  `put_*/1` emits stays as an in-process signal for tests + any
  future internal subscriber; the cic fan-out path lives HERE
  (single explicit door, parity with `cic_bundle_changed`).
  """

  use GrappaWeb, :controller

  alias Grappa.{PubSub, ServerSettings, WSPresence}
  alias Grappa.PubSub.Topic
  alias Grappa.ServerSettings.Wire, as: SettingsWire

  require Logger

  @doc false
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    json(conn, %{settings: render_view(ServerSettings.public_view())})
  end

  @doc false
  @spec update(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom() | Ecto.Changeset.t()}
  def update(conn, params) do
    with :ok <- apply_updates(params) do
      view = ServerSettings.public_view()
      :ok = fanout_changed(view)
      json(conn, %{settings: render_view(view)})
    end
  end

  # UX-6-B2 (2026-05-21): fan out the new view on every live
  # `Topic.user(name)`. Mirrors `AdminController.cic_bundle_changed/2`'s
  # `WSPresence.list_user_names/0` iterator + per-target
  # `broadcast_event/2` — same delivery contract (Phoenix Channel
  # fastlane → one WS frame per connected socket on the topic).
  # Telemetry attempted/succeeded/failed lets a downstream PromEx
  # alarm fire on per-target broadcast failure (HIGH-17 lesson:
  # never silently discard per-target return).
  defp fanout_changed(view) do
    payload = SettingsWire.server_settings_changed(view)
    user_names = WSPresence.list_user_names()
    attempted = length(user_names)

    succeeded =
      Enum.count(user_names, fn name ->
        PubSub.broadcast_event(Topic.user(name), payload) == :ok
      end)

    :telemetry.execute(
      [:grappa, :admin, :server_settings_fanout],
      %{attempted: attempted, succeeded: succeeded, failed: attempted - succeeded},
      %{}
    )

    :ok
  end

  # ---- Internal ----------------------------------------------------

  defp apply_updates(params) when is_map(params) do
    with :ok <- apply_subtree(params, "upload", &apply_upload_key/2) do
      apply_subtree(params, "addressing", &apply_addressing_key/2)
    end
  end

  defp apply_updates(_), do: {:error, :bad_request}

  # Fold a present subtree through its per-key applier. Absent subtree → :ok
  # (each is independently optional — an empty body updates nothing); a
  # non-map subtree → bad_request (no silent swallow of a malformed shape).
  defp apply_subtree(params, key, fun) do
    case Map.get(params, key) do
      nil ->
        :ok

      subtree when is_map(subtree) ->
        Enum.reduce_while(subtree, :ok, fn {k, v}, _ -> halt_or_cont(fun.(k, v)) end)

      _ ->
        {:error, :bad_request}
    end
  end

  # Per-key dispatch so the surrounding fold stays a 2-line lambda
  # and Credo's cyclomatic-complexity check on `apply_updates/1`
  # stays below the 9 ceiling.
  defp apply_upload_key("active_host", "embedded"), do: ServerSettings.put_upload_active_host(:embedded)
  defp apply_upload_key("active_host", "litterbox"), do: ServerSettings.put_upload_active_host(:litterbox)
  defp apply_upload_key("active_host", _), do: {:error, {:invalid_setting, "upload.active_host"}}

  defp apply_upload_key("image_per_file_cap_bytes", n) when is_integer(n) and n > 0,
    do: ServerSettings.put_upload_per_file_cap_bytes(:image, n)

  defp apply_upload_key("image_per_file_cap_bytes", _),
    do: {:error, {:invalid_setting, "upload.image_per_file_cap_bytes"}}

  defp apply_upload_key("video_per_file_cap_bytes", n) when is_integer(n) and n > 0,
    do: ServerSettings.put_upload_per_file_cap_bytes(:video, n)

  defp apply_upload_key("video_per_file_cap_bytes", _),
    do: {:error, {:invalid_setting, "upload.video_per_file_cap_bytes"}}

  defp apply_upload_key("document_per_file_cap_bytes", n) when is_integer(n) and n > 0,
    do: ServerSettings.put_upload_per_file_cap_bytes(:document, n)

  defp apply_upload_key("document_per_file_cap_bytes", _),
    do: {:error, {:invalid_setting, "upload.document_per_file_cap_bytes"}}

  defp apply_upload_key("audio_per_file_cap_bytes", n) when is_integer(n) and n > 0,
    do: ServerSettings.put_upload_per_file_cap_bytes(:audio, n)

  defp apply_upload_key("audio_per_file_cap_bytes", _),
    do: {:error, {:invalid_setting, "upload.audio_per_file_cap_bytes"}}

  defp apply_upload_key("global_cap_bytes", n) when is_integer(n) and n > 0,
    do: ServerSettings.put_upload_global_cap_bytes(n)

  defp apply_upload_key("global_cap_bytes", _),
    do: {:error, {:invalid_setting, "upload.global_cap_bytes"}}

  # Unknown key — ignore but log at warning level. Tolerant of
  # forward-compat shapes cic might send when an admin opens an
  # older deploy, while still discoverable when an admin typos
  # `globalcap_bytes` and wonders why nothing changed
  # (per `feedback_no_silent_drops_closed` — silent acceptance
  # absorbs the next class of bug).
  defp apply_upload_key(k, _) do
    Logger.warning("admin PUT /settings: unknown upload key", setting_key: k)
    :ok
  end

  # ---- addressing.* dispatch (#543) --------------------------------

  defp apply_addressing_key("mode", "pool_with_reservations"),
    do: ServerSettings.put_addressing_mode(:pool_with_reservations)

  defp apply_addressing_key("mode", "static_mapping_with_reservations"),
    do: ServerSettings.put_addressing_mode(:static_mapping_with_reservations)

  defp apply_addressing_key("mode", _),
    do: {:error, {:invalid_setting, "addressing.mode"}}

  defp apply_addressing_key("static_mapping_prefix", value) when is_binary(value) do
    case ServerSettings.put_static_mapping_prefix(value) do
      :ok -> :ok
      {:error, :invalid_prefix} -> {:error, {:invalid_setting, "addressing.static_mapping_prefix"}}
    end
  end

  defp apply_addressing_key("static_mapping_prefix", _),
    do: {:error, {:invalid_setting, "addressing.static_mapping_prefix"}}

  defp apply_addressing_key(k, _) do
    Logger.warning("admin PUT /settings: unknown addressing key", setting_key: k)
    :ok
  end

  # Translate per-key return to Enum.reduce_while continuation. `:ok`
  # → continue; `{:error, _}` → halt with the error preserved.
  defp halt_or_cont(:ok), do: {:cont, :ok}
  defp halt_or_cont({:error, _} = err), do: {:halt, err}

  # Admin settings view. The `upload` subtree comes from public_view/0 via
  # the shared Wire projection; the `addressing` subtree (#543) is admin-only
  # so it is read straight from the accessors — deliberately NOT part of
  # public_view/0, which broadcasts to every cic client.
  defp render_view(%{upload: upload}) do
    %{
      upload: SettingsWire.upload_view(upload),
      addressing: %{
        mode: ServerSettings.addressing_mode(),
        static_mapping_prefix: ServerSettings.static_mapping_prefix()
      }
    }
  end
end
