defmodule Grappa.Session.Broadcaster do
  @moduledoc """
  Server-side broadcast transport for `Grappa.Session.Server` — the twin
  of the channel's per-socket `push/3`.

  #414 Round 1 pulled the ~26 hand-rolled
  `Grappa.PubSub.broadcast_event(Topic.<user|channel>(...), payload)`
  compositions out of `apply_effects/2` and the session's broadcast
  helpers into this one module, so `Session.Server` no longer knows the
  PubSub primitive or the `Grappa.PubSub.Topic` routing. The server says
  WHAT changed (state) and hands the wire payload to a carrier that says
  WHERE it goes (topic) and sends it.

  ## Transport only — the payload SSOT stays put (divergence from #414's text)

  The issue asked to absorb the `Grappa.Session.Wire` payload
  construction into this module too. It does NOT, deliberately:
  `Grappa.Session.Wire` is the SINGLE payload builder shared by BOTH
  transports — this broadcast fan-out AND the channel's cold-reconnect
  per-socket `push(socket, "event", SessionWire.x(...))`
  (`grappa_channel.ex`). Folding the verb construction in here would fork
  that SSOT across two modules and half-hide a builder the channel calls
  directly. This matches the already-landed `Persistor` precedent, which
  keeps `attrs` construction per-caller and extracts only the execution
  core ("reuse the verbs, not the nouns"). So callers keep building
  `SessionWire.x(...)` / `Scrollback.Wire.*` payloads and hand them to
  `to_user/2` or `to_channel/3`.

  ## Failure semantics live at the call site

  `to_user/2` and `to_channel/3` return the raw
  `Grappa.PubSub.broadcast_event/2` result (`:ok | {:error, term()}`)
  rather than asserting internally, so each caller keeps the exact
  failure mode it had before the extraction: the `apply_effects` arms and
  window-state helpers bind `:ok = ...` (a surprise error is a loud bug,
  per CLAUDE.md "no silent-swallow at boundaries"), while the
  connection-progress badge stays fire-and-forget (`_ = ...`) — a dropped
  presentational broadcast telemeters via `broadcast_event/2` and must
  never crash the connect path.
  """

  alias Grappa.PubSub.Topic

  @typedoc """
  The `Session.Server` state slice the transport reads. Open map
  (`optional(any()) => any()`) so the full ~70-key Server state is
  accepted while pinning the routing keys — a drifted shape fails at this
  boundary rather than silently misrouting. `subject_label` roots every
  topic; `network_slug` additionally scopes the per-channel topic.
  """
  @type ctx :: %{
          :subject_label => String.t(),
          optional(:network_slug) => String.t(),
          optional(any()) => any()
        }

  @doc """
  Broadcasts `payload` on the user-level topic
  (`grappa:user:{subject_label}`) — the carrier for every network-scoped
  session event (own-nick, umodes, presence, ephemeral bundles, the
  window-state terminal events, connection progress). Returns the
  `broadcast_event/2` result so the caller owns the `:ok =` / `_ =`
  assertion.
  """
  @spec to_user(ctx(), map()) :: :ok | {:error, term()}
  def to_user(ctx, payload) do
    Grappa.PubSub.broadcast_event(Topic.user(ctx.subject_label), payload)
  end

  @doc """
  Broadcasts `payload` on the per-channel topic
  (`grappa:user:{subject_label}/network:{network_slug}/channel:{channel}`)
  — the carrier for post-join-handshake events (messages, topic, modes,
  members). Returns the `broadcast_event/2` result so the caller owns the
  assertion.
  """
  @spec to_channel(ctx(), String.t(), map()) :: :ok | {:error, term()}
  def to_channel(ctx, channel, payload) do
    Grappa.PubSub.broadcast_event(
      Topic.channel(ctx.subject_label, ctx.network_slug, channel),
      payload
    )
  end
end
