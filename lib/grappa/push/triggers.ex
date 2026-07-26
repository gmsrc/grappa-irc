defmodule Grappa.Push.Triggers do
  @moduledoc """
  Push notifications cluster B4 (2026-05-14) — trigger evaluation +
  fan-out from the inbound PRIVMSG hot path. Subject-aware as of
  visitor-parity V3 (2026-05-15).

  ## Where this fits

  Two independent entry points, both fire-and-forget (unlinked `Task`,
  so the hot path stays sub-millisecond and Sender failures don't bleed
  into the mailbox):

    * `evaluate_and_dispatch/2` — MESSAGE push. Called by
      `Grappa.Session.Persistor.maybe_dispatch_push/2` immediately
      after a successful `Scrollback.persist_event/1` for a `:privmsg`
      or `:action` row. (It moved out of `Session.Server`'s
      `apply_effects/2` `:persist` arm with the #369 A3 extraction —
      `Persistor` owns post-persist obligations.)
    * `dispatch_presence/4` — PRESENCE push (#378). Called by
      `Session.Server`'s `apply_effects/2` `{:presence_changed, ...}`
      arm, next to the wire broadcast. NOT routed through `Persistor`:
      a presence transition persists nothing, so there is no
      post-persist obligation for `Persistor` to guard.

  ## Decision logic — `should_notify?/4`

  Returns `true` for one of three reasons:

    1. **DM** (`message.channel == own_nick`):
       `prefs.private_messages_all` OR
       `Identifier.canonical_nick(message.sender) in prefs.private_messages_only`.

    2. **Channel message** (everything else): any of
       `prefs.channel_messages_all` OR
       `Identifier.canonical_channel(message.channel) in prefs.channel_messages_only` OR
       (`prefs.channel_mentions` AND
       `Mentions.mentioned?(body, own_nick, highlight_patterns)`).

    3. Otherwise — no notify.

  Only the kinds in `Grappa.Scrollback.Message.notify_kinds/0` —
  `:privmsg` and `:action` (CTCP /me) — trigger. `:action` is
  semantically a `PRIVMSG` with content saying "<sender> did X" and
  carries the same notification meaning. `:notice` is intentionally
  excluded — services chatter (NickServ, ChanServ, BotNet status) is
  the dominant inbound NOTICE shape; pushing those would be spam.
  All other SCROLLBACK kinds (`:join`, `:part`, `:quit`,
  `:nick_change`, `:mode`, `:topic`, `:kick`, `:server_event`) are
  presence / control plane and never push.

  That is separate from `/notify` watch-list presence (#378), which
  does NOT arrive as a scrollback row: genuine `:transition` reports
  push via `dispatch_presence/4`, gated by the `presence_online` /
  `presence_offline` prefs (both default off). Baseline `:initial`
  reports never push.

  #395 — the kind gate reads `Message.notify_kinds/0` (a subset of
  `Message.content_kinds/0`, derived from ONE projection declaration) via
  the `@notify_kinds` compile-time attribute, NOT a local `[:privmsg,
  :action]` literal. That literal used to be a second, independently
  maintained kind list: the unread-window count derived from
  `content_kinds/0` (which includes `:notice`), while this path hard-coded
  its own copy. The two happened to agree — badge-worthy ⊆ unread — but
  by accident, not by construction. Reading the shared SSOT makes that
  subset structural: the notify set can never drift from, or exceed, the
  unread-content set.

  ## own_nick — per-network, NOT account name

  The caller (Session.Server) holds the per-(subject, network) IRC nick
  in `state.nick`, reconciled at 001 RPL_WELCOME and updated on
  self-NICK rename. Triggers takes it as an explicit argument
  rather than re-deriving from the subject's display name, dodging
  the CP15 H3 account-name-vs-IRC-nick hazard cic-side.

  ## No silent drops

  `evaluate_and_dispatch/2` always returns `:ok`. Any failure inside
  the spawned Task surfaces as a SASL crash log + `:telemetry`
  events from `Push.Sender`. NO `try/rescue` swallowing per
  `feedback_no_silent_drops_*`.
  """

  alias Grappa.IRC.Identifier
  alias Grappa.{Mentions, Push, Subject, UserSettings, WSPresence}
  alias Grappa.Push.Payload
  alias Grappa.Scrollback.Message

  # #395 — the notify-worthy kind gate. Reads the shared SSOT subset
  # (`Message.notify_kinds/0` ⊆ `Message.content_kinds/0`) instead of a
  # local `[:privmsg, :action]` literal, so badge/push kinds can never
  # drift from — or exceed — the unread-content set. A module attribute
  # (inlined at compile time) so it is usable in the `when kind in
  # @notify_kinds` guards below (a function call is not allowed in a guard).
  @notify_kinds Message.notify_kinds()

  @typedoc """
  Caller context for `evaluate_and_dispatch/2`. Session.Server
  assembles this map from `state` at the call site so Triggers
  doesn't reach back into the GenServer state shape.

  `subject_label` is the WSPresence presence key (`user.name` for
  users, `"visitor:" <> visitor.id` for visitors — identical to
  `Session.Server.state.subject_label`); the foreground-suppression
  gate reads `WSPresence.any_visible?/1` with it (#182).
  """
  @type ctx :: %{
          required(:subject) => Subject.t(),
          required(:subject_label) => String.t(),
          required(:network_slug) => String.t(),
          required(:own_nick) => String.t()
        }

  @typedoc """
  `t:Grappa.UserSettings.notification_prefs/0` is a `map()` typed
  alias; re-exported here for clarity at the call site.
  """
  @type prefs :: UserSettings.notification_prefs()

  @typedoc """
  Baseline-vs-genuine-flip classification for a `/notify` presence
  report (#378).

  Structurally identical to `Grappa.Session.Presence.change_kind/0`,
  and deliberately NOT an alias of it: `Presence` is not exported from
  the `Grappa.Session` boundary, and `Grappa.Push` cannot dep
  `Grappa.Session` because `Grappa.Session` already deps `Grappa.Push`
  — the reverse edge is a cycle. Two atoms are cheaper than either
  fix. (Contrast `prefs()` above, which CAN re-export because
  `Grappa.UserSettings` IS a `Grappa.Push` dep.)
  """
  @type presence_kind :: :initial | :transition

  # ---------------------------------------------------------------------------
  # Public — call from Session.Server
  # ---------------------------------------------------------------------------

  @doc """
  Evaluates trigger logic for `message` against the subject's
  notification preferences and, on a match, fires the Web Push
  fan-out via `Push.Sender.send_to_subject/2`.

  Fire-and-forget — spawns an unlinked `Task` and returns `:ok`
  immediately. Per-message work (prefs lookup, mention regex,
  Sender fan-out) happens out-of-band so the Session.Server hot
  path never blocks on it.

  Only `Message.notify_kinds/0` (`:privmsg`, `:action`) proceed past the
  kind gate; every other kind short-circuits to `:ok` without spawning the
  Task — avoids polluting the BEAM scheduler with no-op spawns
  on the high-volume presence-event paths.
  """
  @spec evaluate_and_dispatch(Message.t(), ctx()) :: :ok
  def evaluate_and_dispatch(%Message{kind: kind} = message, ctx)
      when kind in @notify_kinds and is_map(ctx) do
    %{
      subject: subject,
      subject_label: subject_label,
      network_slug: network_slug,
      own_nick: own_nick
    } = ctx

    {:ok, _} =
      Task.start(fn ->
        prefs = UserSettings.get_notification_prefs(subject)
        patterns = UserSettings.get_highlight_patterns(subject)

        # #182 — foreground-suppression gate. `should_notify?/4` stays a
        # PURE predicate (no IO); the visibility check reads WSPresence
        # GenServer state, so it is a SEPARATE explicit step here. If ANY
        # of the subject's devices reports the PWA is on-screen, skip the
        # ENTIRE fan-out to ALL of that subject's subscriptions. This is
        # PER-USER (cross-device) suppression, NOT the old SW gate's
        # per-device parity — the server has no push-endpoint→socket-pid
        # mapping, so it can't suppress selectively. Moved server-side
        # because the SW's `clients.matchAll` is unreliable on iOS
        # (root cause of #182). Read RAW (no debounce) so a mention landing
        # right after you background still delivers. Deliver-leaning: an
        # unreported/backgrounded device reads `:hidden`, so this never
        # suppresses to a device that hasn't claimed the foreground.
        if should_notify?(message, own_nick, prefs, patterns) and
             not WSPresence.any_visible?(subject_label) do
          payload = build_payload(message, network_slug, own_nick, subject)
          Push.Sender.send_to_subject(subject, payload)
        end
      end)

    :ok
  end

  def evaluate_and_dispatch(%Message{}, _), do: :ok

  @doc """
  Fires Web Push for one `/notify` watch-list presence transition
  (#378) and, on a match, fans out via `Push.Sender.send_to_subject/2`.

  Same fire-and-forget shape as `evaluate_and_dispatch/2`: unlinked
  `Task`, always returns `:ok`, no `try/rescue`.

  `:initial` gates in the FUNCTION HEAD, before the Task spawn — a
  MONITOR/WATCH baseline burst (connect-time arm, `/notify add` bulk,
  the 421 fallback re-arm, or a post-reconnect re-seed) is many reports
  at once and must not spawn a Task each just to decide "no". Same
  rationale as `evaluate_and_dispatch/2`'s kind gate.

  Deliberately NO catch-all clause: the caller's `change_kind()` is a
  closed pair, so a third kind should crash `Session.Server` loudly
  rather than be silently dropped.
  """
  @spec dispatch_presence(String.t(), :online | :offline, presence_kind(), ctx()) :: :ok
  def dispatch_presence(nick, presence, :transition, ctx)
      when is_binary(nick) and presence in [:online, :offline] and is_map(ctx) do
    %{subject: subject, subject_label: subject_label, network_slug: network_slug} = ctx

    {:ok, _} =
      Task.start(fn ->
        prefs = UserSettings.get_notification_prefs(subject)

        # #182 foreground suppression, identical to the message path: pure
        # predicate first, then the WSPresence read as a separate step.
        if should_notify_presence?(presence, prefs) and
             not WSPresence.any_visible?(subject_label) do
          Push.Sender.send_to_subject(
            subject,
            Payload.build_presence(nick, presence, network_slug),
            :presence
          )
        end
      end)

    :ok
  end

  def dispatch_presence(_, _, :initial, _), do: :ok

  # ---------------------------------------------------------------------------
  # Public — pure predicate (testable in isolation)
  # ---------------------------------------------------------------------------

  @doc """
  Returns `true` when a presence transition to `presence` should push,
  given `prefs` (#378).

  `Map.fetch!/2`, NOT `Map.get(prefs, key, false)`: every caller routes
  through `UserSettings.get_notification_prefs/1`, which runs
  `merge_with_defaults/1` and therefore guarantees both keys are
  present. A `false` fallback here would be a SECOND declaration of the
  default, free to drift from `default_notification_prefs/0` — the
  exact smell at `dm_match?/2` and `channel_match?/4` below, which this
  does not copy.
  """
  @spec should_notify_presence?(:online | :offline, prefs()) :: boolean()
  def should_notify_presence?(:online, prefs) when is_map(prefs),
    do: Map.fetch!(prefs, :presence_online)

  def should_notify_presence?(:offline, prefs) when is_map(prefs),
    do: Map.fetch!(prefs, :presence_offline)

  @doc """
  Returns `true` when `message` should produce a push notification
  for an operator whose IRC nick is `own_nick`, given `prefs`.

  `highlight_patterns` is the per-user watchlist (from
  `UserSettings.get_highlight_patterns/1`); used only when the
  channel-mentions branch fires.

  Pure function — no DB, no IO. The full decision tree lives in
  the moduledoc; the body is a literal transcription.
  """
  @spec should_notify?(
          Message.t(),
          own_nick :: String.t(),
          prefs(),
          highlight_patterns :: [String.t()]
        ) :: boolean()
  def should_notify?(%Message{kind: kind}, _, _, _)
      when kind not in @notify_kinds,
      do: false

  def should_notify?(%Message{} = message, own_nick, prefs, patterns)
      when is_binary(own_nick) and is_map(prefs) and is_list(patterns) do
    if dm?(message, own_nick) do
      dm_match?(message, prefs)
    else
      channel_match?(message, prefs, own_nick, patterns)
    end
  end

  # ---------------------------------------------------------------------------
  # Private
  # ---------------------------------------------------------------------------

  # Door #1: build the push payload, stamping the current badge count when
  # the `BadgeSource` seam is configured. The triggering message is already
  # persisted (this runs inside the post-`persist_event` Task), so the
  # count includes it. `nil` — the transient hot-deploy window before the
  # `:badge_source` config is live — OMITS the badge field rather than
  # crashing the Task or stamping a wrong `0` that would clear the icon;
  # the push still fires, the SW just leaves the badge untouched.
  @spec build_payload(Message.t(), String.t(), String.t(), Subject.t()) :: Payload.t()
  defp build_payload(message, network_slug, own_nick, subject) do
    payload = Payload.build(message, network_slug, own_nick)

    case Push.BadgeSource.count(subject) do
      count when is_integer(count) -> Payload.put_badge(payload, count)
      nil -> payload
    end
  end

  # Canonical DM rule across the codebase: inbound row's `channel`
  # field equals own_nick. Mirrors `Grappa.Scrollback.dm_peer/4`'s
  # inbound branch + cic's dm-listener channelKey rule.
  defp dm?(%Message{channel: channel}, own_nick), do: channel == own_nick

  defp dm_match?(%Message{} = message, prefs) do
    Map.get(prefs, :private_messages_all, false) or
      sender_in_whitelist?(message, prefs)
  end

  defp sender_in_whitelist?(%Message{sender: sender}, prefs) when is_binary(sender) do
    # Fold the sender through the rfc1459 nick SSOT (#121) — never a bare
    # String.downcase, which leaves `[ ] \ ~` unfolded and misses a
    # whitelisted foo[bar] when the inbound nick is foo{bar}. The stored
    # list is canonicalized to the same fold by UserSettings.normalize_list.
    Identifier.canonical_nick(sender) in Map.get(prefs, :private_messages_only, [])
  end

  defp sender_in_whitelist?(_, _), do: false

  defp channel_match?(%Message{} = message, prefs, own_nick, patterns) do
    Map.get(prefs, :channel_messages_all, false) or
      channel_in_whitelist?(message, prefs) or
      mention_match?(message, prefs, own_nick, patterns)
  end

  defp channel_in_whitelist?(%Message{channel: channel}, prefs) when is_binary(channel) do
    # Fold via the channel SSOT (sigil-gated downcase) to match the store
    # path; keeps the nick vs channel fold distinction explicit rather than
    # a bare downcase that happens to coincide today.
    Identifier.canonical_channel(channel) in Map.get(prefs, :channel_messages_only, [])
  end

  defp channel_in_whitelist?(_, _), do: false

  defp mention_match?(%Message{body: body}, prefs, own_nick, patterns) do
    Map.get(prefs, :channel_mentions, false) and
      Mentions.mentioned?(body, own_nick, patterns)
  end
end
