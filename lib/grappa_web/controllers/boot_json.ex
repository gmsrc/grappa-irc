defmodule GrappaWeb.BootJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.BootController` (#1679).

  Deliberately a COMPOSITION of the three views it replaces rather than a
  fourth serializer: `networks` delegates to `GrappaWeb.NetworksJSON.index/1`,
  each channel list to `Grappa.Networks.Wire.channel_to_json/3` (what
  `ChannelsJSON` does), each message to `Grappa.Scrollback.Wire.to_json/1`
  (what `MessagesJSON` does).

  That is the point of the endpoint: a boot that answered a DIFFERENT shape
  from the per-request endpoints would make cic carry two decoders for one
  concept, and any drift between them would surface as a boot that renders
  subtly unlike a refetch. The equality is asserted, not just intended —
  `GrappaWeb.BootCostTest` compares `/boot`'s per-network channel list
  against the live `GET /networks/:slug/channels` response.
  """
  alias Grappa.Networks
  alias Grappa.Networks.Wire, as: NetworksWire
  alias Grappa.Scrollback
  alias Grappa.Scrollback.Wire, as: ScrollbackWire
  alias GrappaWeb.NetworksJSON

  @typedoc """
  Per-network channel trees: `%{network_slug => [channel_json]}`, each list
  byte-identical to that network's `GET /networks/:slug/channels`.

  Slug-keyed, like every other nested envelope cic consumes (`read_cursors`,
  `unread_counts`) — the integer network id stays REST-internal.
  """
  @type channel_tree :: %{String.t() => [NetworksWire.channel_json()]}

  @typedoc """
  Per-channel head pages: `%{network_slug => %{channel => [message]}}`, the
  newest page of each channel so the pane renders on selection without a
  second round trip. Same row shape `GET .../messages` returns.

  A channel with no history is ABSENT rather than mapped to `[]` — the same
  convention `read_cursors` uses, and the one that keeps the envelope from
  growing a key per empty window.
  """
  @type heads :: %{String.t() => %{String.t() => [ScrollbackWire.t()]}}

  @typedoc """
  The `GET /boot` envelope (#1679). Three keys, all required, all flat in
  account size.

  Declared as a NAMED type rather than left inline on `index/1`'s `@spec`
  because the codegen (`Mix.Tasks.Grappa.GenWireTypes`) reads `@type`
  declarations via `Code.Typespec.fetch_types/1` and never looks at a
  `@spec`. Measured: with only the inline spec, adding this module to the
  codegen's `@extra_modules` emitted NOTHING but a changed `Source:` header
  comment — and that header alone moved the `wire_pin` digest, i.e. a RED
  gate and a version bump earned by a comment rather than by a shape. A
  web-layer envelope has to name its type or it is in the digest without
  being in the contract.
  """
  @type boot_json :: %{
          networks: [
            NetworksWire.network_with_nick_json() | NetworksWire.visitor_network_with_nick_json()
          ],
          channels: channel_tree(),
          heads: heads()
        }

  @doc "Renders the `:index` action — the whole boot envelope."
  @spec index(%{
          networks: {:user, [Networks.network_row()]} | {:visitor, [Networks.network_row()]},
          channels: %{String.t() => [Networks.channel_entry()]},
          heads: %{String.t() => %{String.t() => [Scrollback.Message.t()]}}
        }) :: boot_json()
  def index(%{networks: networks, channels: channels, heads: heads}) do
    %{
      networks: NetworksJSON.index(%{networks: networks}),
      channels: Map.new(channels, fn {slug, entries} -> {slug, channel_list(entries)} end),
      heads:
        Map.new(heads, fn {slug, by_channel} ->
          {slug,
           Map.new(by_channel, fn {channel, messages} ->
             {channel, Enum.map(messages, &ScrollbackWire.to_json/1)}
           end)}
        end)
    }
  end

  @spec channel_list([Networks.channel_entry()]) :: [NetworksWire.channel_json()]
  defp channel_list(entries) do
    Enum.map(entries, fn %{name: name, joined: joined, source: source} ->
      NetworksWire.channel_to_json(name, joined, source)
    end)
  end
end
