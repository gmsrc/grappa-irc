defmodule Grappa.WindowCounts.Pusher do
  @moduledoc """
  Default `Grappa.WindowCounts.PushSource` implementation (#267) — the
  concrete per-message `window_counts` push.

  ## Own boundary ABOVE the caller (BadgeCount pattern)

  Lives in its OWN `top_level?: true` boundary because it deps
  `ReadCursor` (→ `Networks` → `Session`); folding it into any boundary
  `Session` deps would close a cycle. `Session` reaches it ONLY through
  the `PushSource` config seam, so nothing below statically references
  this module — the same inversion `Grappa.Push.BadgeCount` uses.

  ## What it does

  `push/1` gates on live WS presence (`WSPresence.ws_count/1` > 0): if
  no socket is connected for the subject, it skips — the next
  `join_reply` / `/me` re-seeds the absolute snapshot on reconnect, so a
  disconnected subject costs nothing. When connected, it hands the window
  to `Coalescer` (#1768), which folds a burst of rows in the same window
  into ONE flush and runs it under `Grappa.TaskSupervisor` (like
  `Push.Triggers`) so the Session hot path never blocks on the snapshot's
  DB work. `emit/1` then computes the fresh `WindowCounts.snapshot/7`
  (cursor from `ReadCursor`, highlight patterns from `UserSettings`) and
  broadcasts the `window_counts` event on the per-channel topic. cic
  replaces its stored snapshot verbatim.

  `emit/1` reads the DB at FLUSH time, which is what makes the coalescing
  lossless: the one snapshot that survives a burst has seen every row of
  it. That property is load-bearing — see `Coalescer`'s moduledoc — so a
  future change that pre-computes any part of the snapshot at `push/1`
  time breaks the coalescer without touching it.
  """

  @behaviour Grappa.WindowCounts.PushSource

  use Boundary,
    top_level?: true,
    deps: [
      Grappa.PresenceFilter.Resolver,
      Grappa.PubSub,
      Grappa.ReadCursor,
      Grappa.Subject,
      Grappa.UserSettings,
      Grappa.WindowCounts,
      Grappa.WSPresence
    ],
    # #1768 — the coalescer is a supervised singleton, so `Grappa.Application`
    # has to name it in the child list. Nothing else outside this boundary
    # may: `push/1` is still the only door in.
    exports: [Coalescer]

  alias Grappa.PresenceFilter.Resolver
  alias Grappa.PubSub.Topic
  alias Grappa.{ReadCursor, UserSettings, WindowCounts, WSPresence}
  alias Grappa.WindowCounts.Pusher.Coalescer
  alias Grappa.WindowCounts.{PushSource, Wire}

  @impl PushSource
  @spec push(PushSource.ctx()) :: :ok
  def push(%{subject_label: subject_label} = ctx) do
    # `_ =` — the `if` is evaluated for its side effect (arming the
    # coalescer's flush); its value is intentionally discarded (dialyzer
    # `:unmatched_returns`).
    _ =
      if WSPresence.ws_count(subject_label) > 0 do
        # #1768 — through the coalescer, NOT straight to a Task. One row
        # used to be one task and one snapshot; a burst in one window is
        # now one snapshot, so in-flight snapshot work is bounded by the
        # windows touched instead of by the rows persisted. See
        # `Coalescer`'s moduledoc for the measurement and for why dropping
        # the intermediate emits is lossless.
        #
        # The presence gate stays HERE, ahead of the cast, so a subject
        # with no socket still costs nothing at all — not even a message
        # into the coalescer's mailbox.
        Coalescer.touch(ctx)
      end

    :ok
  end

  @doc """
  Computes the fresh snapshot and broadcasts the `window_counts` event.
  Public (not private) so it is unit-testable synchronously without the
  `Task` + WS-presence gate `push/1` wraps it in.
  """
  @spec emit(PushSource.ctx()) :: :ok
  def emit(%{
        subject: subject,
        network_id: network_id,
        network_slug: network_slug,
        subject_label: subject_label,
        channel: channel,
        own_nick: own_nick
      }) do
    patterns = UserSettings.get_highlight_patterns(subject)

    cursor =
      case ReadCursor.get(subject, network_id, channel) do
        %ReadCursor.Cursor{last_read_message_id: id} -> id
        _ -> nil
      end

    # #505 — same presence decision the seed doors use, so a live push can
    # never contradict the `join_reply` / `/me` snapshot it replaces
    # verbatim in cic's store. Safe from here: `push/1` runs `emit/1` in a
    # spawned Task, so the `Session.list_members/3` call inside the resolver
    # is a call INTO the Session from another process, not a self-call.
    hide_presence = Resolver.hidden?(subject, network_slug, network_id, channel)

    counts =
      WindowCounts.snapshot(
        subject,
        network_id,
        channel,
        cursor,
        own_nick,
        patterns,
        hide_presence
      )

    _ =
      Grappa.PubSub.broadcast_event(
        Topic.channel(subject_label, network_slug, channel),
        Wire.window_counts_payload(channel, counts)
      )

    :ok
  end
end
