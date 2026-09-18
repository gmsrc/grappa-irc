defmodule GrappaWeb.BootController do
  @moduledoc """
  `GET /boot` — the whole boot picture in ONE round trip (#1679).

  ## Why this exists

  Cic's cold boot used to fan out `GET /me`, `GET /networks`, then one
  `GET /networks/:slug/channels` PER NETWORK, then one `/messages` fetch PER
  CHANNEL. The burst therefore scaled with the SIZE OF THE ACCOUNT rather
  than with anything the operator did, and on prod it tripped the reverse
  proxy's `limit_req` zone: 31 × `503`, with zero `Sent 503` in the
  application log — nginx rejected them, grappa never saw them. Grappa's own
  inbound budget cannot see this either; `#630`'s `RequestBudget` meters only
  write methods, and a boot is pure GET.

  Throttling the client was considered and REJECTED (#1679 Decision): an
  in-flight cap staggers the same work and makes boot feel slower. The
  request COUNT is what had to stop scaling.

  ## What it answers

    * `networks` — byte-identical to `GET /networks`, via the shared
      `Networks.subject_network_rows/1`.
    * `channels` — `%{slug => [channel_entry]}`, each list byte-identical to
      that network's `GET /networks/:slug/channels`, via the shared
      `Networks.merge_channel_sources/2`.
    * `heads` — `%{slug => %{channel => [message]}}`, the newest
      `#{50}` rows per channel, so the pane renders on selection without a
      second round.

  `GET /me` is deliberately NOT folded in. It is already an aggregate
  envelope (`read_cursors`, `unread_counts`, `badge_count`, `home_data`),
  already CONSTANT in account size (measured: seven queries at one network
  and at four), and it has consumers that are not boot (`refetchUser` after a
  connect, the BootErrorBoundary retry). Duplicating that envelope here to
  save one request of a two-request boot would buy a second copy to keep in
  sync — the exact drift this controller exists to remove elsewhere. Boot is
  `/me` + `/boot`: two requests, flat in networks and channels.

  ## The N+1 that would undo the whole thing

  Answering in one round trip while issuing one query per network — or worse,
  per channel — moves the thundering herd from the operator's proxy to
  SQLite and buys nothing. So every read here is either constant or bulk:

    * the credential set is ONE query with `:network` preloaded;
    * the per-network live facts (nick, connection info, channel list) are
      `Registry` / GenServer reads, never queries;
    * the per-channel heads are `Scrollback.bulk_heads/4` — a single
      `ROW_NUMBER() OVER (PARTITION BY …)` statement, the shape #396 already
      proved on the prod indexes;
    * the presence-filter decision is the BULK
      `PresenceFilter.Resolver.hidden_channels/3`, the same one `/me` uses.

  `GrappaWeb.BootCostTest` pins that as an INVARIANT under both axes: the
  query count at one network must equal the count at seven, and the count at
  two channels must equal the count at twenty. A regression there is the
  whole fix undone, so it is measured rather than asserted in prose.
  """
  use GrappaWeb, :controller

  alias Grappa.{Networks, Scrollback}
  alias Grappa.PresenceFilter.Resolver
  alias GrappaWeb.Subject

  # One page, matching `MessagesController`'s `@default_limit`. The head is
  # what the pane renders on selection; deeper history is still the
  # per-channel endpoint's job, which #1679 explicitly leaves unchanged.
  @head_limit 50

  @doc """
  `GET /boot` — networks + channel trees + per-channel heads for the caller.

  Both subject kinds, no params. Never 404s on an empty account: a subject
  with no credentials gets empty collections, which is the honest answer and
  the one cic's boot chain already handles.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    subject = Subject.to_session(conn.assigns.current_subject)
    {kind, rows} = Networks.subject_network_rows(subject)

    channels = Map.new(rows, &{elem(&1, 0).slug, channel_tree(subject, kind, &1)})

    render(conn, :index,
      networks: {kind, rows},
      channels: channels,
      heads: heads(subject, rows, channels)
    )
  end

  # ONE STUCK SESSION MUST NOT COST THE WHOLE ENVELOPE (issue 2239, vjt's
  # ruling): this endpoint degrades PER NETWORK ROW, it does not fail the
  # request.
  #
  # A session that is registered but too busy to reply inside the 5s budget
  # answers `{:error, :timeout}`. Before 2239 nothing had an arm for it and
  # `Networks.session_channels/2` raised, and because the comprehension above
  # assembles every row BEFORE anything renders, the `CaseClauseError` took the
  # healthy networks down with the sick one: a 500 for the whole account on
  # account of one link. Propagating instead would keep exactly that blast
  # radius and merely retype it — 504 for N networks because of 1 — which is the
  # wrong altitude for the endpoint whose entire reason to exist (#1679) is
  # batching those N.
  #
  # `Networks.session_channels_degrading/3` is the shared policy (its doc
  # carries the full rationale, including why this is NOT what the archive door
  # does). Here it means the AUTOJOIN-ONLY tree: the half held without asking
  # anybody, from a credential column that was never in doubt — the same posture
  # as `LiveIntrospection`'s degraded `joined_channels`, never a fabrication.
  @spec channel_tree(Grappa.Session.subject(), :user | :visitor, Networks.network_row()) ::
          [Networks.channel_entry()]
  defp channel_tree(subject, kind, {network, _, cred, _}) do
    Networks.merge_channel_sources(
      Networks.autojoin_channels(kind, cred),
      Networks.session_channels_degrading(subject, network, "GET /boot")
    )
  end

  # `%{slug => %{channel => [Message.t()]}}` for every channel in the tree.
  #
  # `bulk_heads/4` is keyed by `{network_id, channel}` because that is what
  # the rows carry; the wire is keyed by SLUG, like every other nested
  # envelope cic consumes (`read_cursors`, `unread_counts`). The two maps
  # below translate once rather than at each lookup.
  @spec heads(
          Grappa.Session.subject(),
          [Networks.network_row()],
          %{String.t() => [Networks.channel_entry()]}
        ) :: %{String.t() => %{String.t() => [Scrollback.Message.t()]}}
  defp heads(_, [], _), do: %{}

  defp heads(subject, rows, channels) do
    id_by_slug = Map.new(rows, fn {network, _, _, _} -> {network.slug, network.id} end)

    targets =
      for {slug, entries} <- channels,
          entry <- entries,
          do: {Map.fetch!(id_by_slug, slug), entry.name}

    subject
    |> Scrollback.bulk_heads(targets, @head_limit, hidden_pairs(subject, rows, channels, id_by_slug))
    |> Enum.group_by(fn {{network_id, _}, _} -> network_id end)
    |> Map.new(fn {network_id, entries} ->
      {slug_for(id_by_slug, network_id), Map.new(entries, fn {{_, channel}, messages} -> {channel, messages} end)}
    end)
  end

  # The `(network_id, channel)` pairs whose presence noise this subject
  # suppresses (#458). `hidden_channels/3` is the BULK resolver `/me` already
  # uses — it takes the window universe as a parameter precisely so a caller
  # that knows its channel set pays one prefs read instead of one per channel.
  # Re-keyed from its slug shape to the id shape `bulk_heads/4` partitions on.
  @spec hidden_pairs(
          Grappa.Session.subject(),
          [Networks.network_row()],
          %{String.t() => [Networks.channel_entry()]},
          %{String.t() => integer()}
        ) :: MapSet.t({integer(), String.t()})
  defp hidden_pairs(subject, rows, channels, id_by_slug) do
    own_nicks = Map.new(rows, fn {network, nick, _, _} -> {network.slug, {network.id, nick}} end)
    windows = Map.new(channels, fn {slug, entries} -> {slug, Map.new(entries, &{&1.name, nil})} end)

    subject
    |> Resolver.hidden_channels(own_nicks, windows)
    |> Enum.flat_map(fn {slug, set} ->
      Enum.map(set, fn channel -> {Map.fetch!(id_by_slug, slug), channel} end)
    end)
    |> MapSet.new()
  end

  @spec slug_for(%{String.t() => integer()}, integer()) :: String.t()
  defp slug_for(id_by_slug, network_id) do
    Enum.find_value(id_by_slug, fn {slug, id} -> if id == network_id, do: slug end)
  end
end
