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
  Broadcasts `payload` to the ONE connection that asked for it (#1088),
  falling back to the per-user fan-out when no requester is known.

  `reply_to` is the `socket_ref` `UserSocket.connect/3` minted for the
  WebSocket that issued the command, carried through the session's
  `*_pending` accumulator and lifted back out by the drain. An informational
  reply (`/who`, `/whois`, `/motd`, …) is the answer to a question one
  client asked; on `to_user/2` it opened a modal on every other device of
  the same subject.

  `nil` — the safe default, mirroring #606's absent-`source` rule — routes
  to `to_user/2`, i.e. exactly the pre-#1088 behaviour. Reached by a reply
  with no requester at all (bahamut's connect-welcome auto-emit) and by an
  accumulator primed before a hot deploy. Losing a reply is worse than
  showing it too widely, so the degradation direction is deliberate.

  A dead requester (the tab closed, reloaded, or lost its socket before
  the ircd answered) leaves the topic with no subscriber and the reply is
  dropped. That is the intended semantics, not a gap: the question died
  with the connection that asked it, and a modal has no meaning on a page
  that never issued the command.
  """
  @spec to_requester(ctx(), String.t() | nil, map()) :: :ok | {:error, term()}
  def to_requester(ctx, nil, payload), do: to_user(ctx, payload)

  def to_requester(ctx, reply_to, payload) when is_binary(reply_to) do
    Grappa.PubSub.broadcast_event(Topic.socket(ctx.subject_label, reply_to), payload)
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
