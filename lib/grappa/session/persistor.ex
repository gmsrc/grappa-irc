defmodule Grappa.Session.Persistor do
  @moduledoc """
  Shared persist → broadcast → (optional push) core for
  `Grappa.Session.Server`.

  Three sites in the Server hand-rolled the same delivery shape — the
  inbound `:persist` effect, the outbound `persist_and_send_fragments`
  loop, and the `:join_failed` effect — each persisting a `Scrollback`
  row and broadcasting `Scrollback.Wire.message_payload/1` on the row's
  per-channel topic. But only the inbound arm carried the #267
  `WindowCounts.PushSource.push` obligation. The 2026-04-27 A20 deferral
  predicted this drift; the 2026-07-20 architecture review (#369 A3)
  confirmed it as a *live correctness channel* — a new post-persist
  obligation lands on one path and silently skips the others. This module
  is the landed extraction: one place that persists, broadcasts, and —
  gated by `push: true` — fires the post-persist push obligations.

  ## Reuse the verbs, not the nouns

  The shared thing is the persist → broadcast → push *execution*, not the
  attrs *shape*. The three callers build genuinely different attrs
  (inbound: `EventRouter`-prebuilt; outbound: own-nick privmsg/action with
  a snapshotted sender-prefix; join_failed: a `:notice` carrying the
  numeric in `meta`), so attrs construction stays with each caller — only
  the execution core lives here. The `push:` opt is the single knob for
  the inbound-only obligation, so a future post-persist hook can never
  again land on one path and skip the others.

  ## Failure ownership

  This module never logs and never crashes the caller on a persist error:
  it returns `{:error, term()}` so each caller owns its failure-mode
  message + metadata (the outbound path surfaces it as the HTTP reply; the
  effect arms log via `log_persist_failure/2` and continue). The `:ok =`
  match on the broadcast/push is deliberate — those are in-node operations
  that do not fail on the documented path, and a surprise there is a bug
  we want loud (CLAUDE.md "no silent-swallow at boundaries").
  """

  alias Grappa.IRC.Identifier
  alias Grappa.PubSub.Topic
  alias Grappa.Push.Triggers, as: PushTriggers
  alias Grappa.{Scrollback, WindowCounts}
  alias Grappa.Scrollback.Wire

  @typedoc """
  The Session.Server state slice this module reads, passed as the full
  `state` map by callers. The open map type (`optional(any()) => any()`)
  accepts the 60-key Server struct while pinning the five keys the
  delivery needs, so a drifted state shape fails at the boundary rather
  than silently skipping the push. `nick` is the reconciled per-network
  nick — the `own_nick` the push obligations key on.
  """
  @type session_ctx :: %{
          :subject => Grappa.Subject.t(),
          :subject_label => String.t(),
          :network_slug => String.t(),
          :network_id => integer(),
          :nick => String.t(),
          optional(any()) => any()
        }

  @doc """
  Persists `attrs`, broadcasts the wire event on the row's per-channel
  topic, and — when `push: true` — fires the post-persist push
  obligations (OS-notification dispatch + #267 window-counts snapshot).

  `attrs` MUST carry `:channel` and `:kind`; the broadcast topic is
  derived from `attrs.channel`, the exact value all three call sites
  broadcast on today. Returns the persisted `Message.t()` (the outbound
  caller hands it back as the HTTP reply); `{:error, term()}` propagates
  a persist failure for the caller to log or surface.
  """
  @spec persist_and_broadcast(map(), session_ctx(), keyword()) ::
          {:ok, Scrollback.Message.t()} | {:error, term()}
  def persist_and_broadcast(attrs, ctx, opts) do
    case Scrollback.persist_event(attrs) do
      {:ok, message} ->
        :ok =
          Grappa.PubSub.broadcast_event(
            Topic.channel(ctx.subject_label, ctx.network_slug, attrs.channel),
            Wire.message_payload(message)
          )

        if Keyword.get(opts, :push, false), do: dispatch_push(message, ctx)

        {:ok, message}

      {:error, _} = err ->
        err
    end
  end

  # Post-persist push obligations, fired only for inbound rows
  # (`push: true`). Two independent obligations that MUST move together so
  # neither can drift onto one persist path and skip another:
  #   1. OS-notification dispatch (self-echo-skipped, kind-gated inside
  #      `Push.Triggers`) — the operator's own rows never notify.
  #   2. #267 window-counts snapshot for the row's window so a connected
  #      cic renders the new count without deriving it. Fires for every
  #      kind; the impl gates on live WS presence and does its DB work in
  #      its own Task, so this is sub-microsecond on the hot path.
  @spec dispatch_push(Scrollback.Message.t(), session_ctx()) :: :ok
  defp dispatch_push(message, ctx) do
    :ok = maybe_dispatch_push(message, ctx)

    :ok =
      WindowCounts.PushSource.push(%{
        subject: ctx.subject,
        network_id: ctx.network_id,
        network_slug: ctx.network_slug,
        subject_label: ctx.subject_label,
        channel: message.channel,
        own_nick: ctx.nick
      })
  end

  # Self-echoes never push. rfc1459 fold (#121) rather than an exact
  # match: if `echo-message` is ever enabled, an upstream-cased echo of
  # the own nick (`MyNick` vs `mynick`) must still suppress. Otherwise
  # delegate to `Push.Triggers`, which spawns its own unlinked Task for
  # prefs lookup + Sender fan-out (the kind-gate lives there — one
  # canonical predicate).
  @spec maybe_dispatch_push(Scrollback.Message.t(), session_ctx()) :: :ok
  defp maybe_dispatch_push(%Scrollback.Message{sender: sender} = message, ctx) do
    if Identifier.canonical_nick(sender) == Identifier.canonical_nick(ctx.nick) do
      :ok
    else
      PushTriggers.evaluate_and_dispatch(message, %{
        subject: ctx.subject,
        subject_label: ctx.subject_label,
        network_slug: ctx.network_slug,
        own_nick: ctx.nick
      })
    end
  end
end
