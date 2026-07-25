defmodule Grappa.ReadCursor do
  @moduledoc """
  Server-owned per-(subject, network, channel) read cursor.

  ## Semantics

  The cursor is "the newest row the operator has read". cic POSTs
  `set/4` on every settle event — focus-leave, browser-blur,
  scroll-settle, scroll-to-bottom tap. The write is **monotonic
  (advance-only)**: a POST carrying an id at or below the stored cursor
  is a no-op that returns the existing (higher) cursor unchanged. A
  lower id is never a deliberate backward move — it is a stale POST
  racing a slow message-page load (see #233 / DESIGN_NOTES 2026-07-14),
  and writing it backward would fan a `read_cursor_set` broadcast that
  snaps every device's view back to the old read marker. cic is already
  forward-only locally; the server is the single authoritative regressor,
  so the clamp lives here. Cross-device fan-out via `broadcast_set/4`
  keeps every open device aligned on the same position.

  **Deliberate mark-as-unread** (the one legitimate backward move) has
  no caller today — no cic surface, no REST verb. It is intentionally
  NOT supported through `set/4`: when the feature ships it gets its OWN
  explicit path that bypasses the monotonic guard, added THEN with its
  caller (YAGNI — do not relax this guard to `<` to pre-empt it).

  A cursor whose `last_read_message_id` was NULL'd by an
  `ON DELETE SET NULL` message purge (`Scrollback.delete_for_channel/3`)
  is NOT frozen by the clamp — the guard only fires for an integer
  current cursor, so the next `set/4` advances the NULL'd row and
  recovers it (the migration's designed behaviour).

  Surfaces consuming the cursor:

    * cic in-pane unread-marker: rows with `id > cursor` are unread.
    * cic sidebar/bottom-bar badge counters: same predicate.
    * Phase 6 IRCv3 listener facade: `+draft/read-marker` MARKREAD
      lines reflect the same `last_read_message_id`.

  ## Subject XOR

  Mirrors `Grappa.Scrollback.Message`'s convention. The subject
  discriminated union (`{:user, uuid}` | `{:visitor, uuid}`) is the
  same tagged-tuple shape Scrollback's `fetch/6` accepts. Same predicate
  helpers (`subject_filter/1`, `subject_attrs/1`) keep the per-subject
  iso boundary uniform across contexts.

  ## Boundary

  Standalone context. Its only deps are:

    * `Grappa.Repo` — persistence.
    * `Grappa.Accounts` — `User` association (FK reference only).
    * `Grappa.Networks` — `Network` association (FK reference only) +
      `Network.slug/1` for the `bulk_for_subject/1` envelope grouping.
    * `Grappa.Visitors` — `Visitor` association (FK reference only).
    * `Grappa.Scrollback` — `Message` association (FK reference only)
      + `Message.t()` typespec; existence validation queries the
      `messages` table by id.
    * `Grappa.PubSub` — `Topic.channel/3` for the `read_cursor_set`
      cross-device broadcast.

  The `Cursor` schema module is internal; callers receive `%Cursor{}`
  structs by type but MUST NOT alias or import the schema module
  directly.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.IRC, Grappa.PubSub, Grappa.Repo, Grappa.Scrollback],
    # `Networks.Network` is referenced ONLY as a schema — the
    # `belongs_to :network` FK association + the `join: n in Network`
    # slug lookup in `bulk_for_subject/1` (field access, no Networks
    # context call). Demoted from a real dep to a struct-only dirty xref
    # (#373) so `Session → ReadCursor → Networks → Session` doesn't close
    # once Session depends on ReadCursor for `rename_dm_peer/4`; mirrors
    # `Grappa.Scrollback` / `Grappa.QueryWindows`. `Visitors.Visitor` is
    # the `belongs_to :visitor` FK, same rationale.
    dirty_xrefs: [Grappa.Networks.Network, Grappa.Visitors.Visitor],
    exports: [Cursor, Wire]

  import Ecto.Query

  alias Grappa.IRC.Identifier
  alias Grappa.Networks.Network
  alias Grappa.PubSub.Topic
  alias Grappa.ReadCursor.{Cursor, Wire}
  alias Grappa.Repo
  alias Grappa.Scrollback.Message

  # Identifier.nick_fold/1 is a query macro (rfc1459 fold fragment) used by
  # rename_dm_peer/4 to match a DM cursor by the fold of the peer nick.
  require Identifier

  # ---------------------------------------------------------------------------
  # Types
  # ---------------------------------------------------------------------------

  @typedoc """
  Subject discriminator — mirrors `t:Grappa.Scrollback.subject/0`. Same
  tagged-tuple shape across both contexts so callers don't need to
  re-encode the principal at every boundary.
  """
  @type subject :: {:user, Ecto.UUID.t()} | {:visitor, Ecto.UUID.t()}

  @typedoc """
  Bulk envelope shape: nested `%{network_slug => %{channel => message_id}}`.

  Nested matches the Phoenix per-channel topic shape
  (network grouping is the natural axis of the wire) and the size is
  bounded by network count. Loaded once at subject login by `MeController`
  / equivalent envelope assembler.
  """
  @type bulk_envelope :: %{String.t() => %{String.t() => integer()}}

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @doc """
  Returns the cursor row for `(subject, network_id, channel)`, or `nil`
  if no cursor exists yet. Single index hit via the partial unique index
  on the matching subject branch.
  """
  @spec get(subject(), integer(), String.t()) :: Cursor.t() | nil
  def get(subject, network_id, channel)
      when is_integer(network_id) and is_binary(channel) and channel != "" do
    # UX-4 bucket A — canonicalise channel at the read boundary so a
    # cic-side `#Chan` lookup hits the canonical `#chan` cursor row.
    # Sigil-aware; nick-shape DM windows pass through unchanged.
    channel = Identifier.canonical_channel(channel)

    Cursor
    |> subject_filter(subject)
    |> where([c], c.network_id == ^network_id and c.channel == ^channel)
    |> Repo.one()
  end

  @doc """
  Sets the cursor for `(subject, network_id, channel)` to `message_id`.

  **Monotonic (advance-only).** The cursor represents "the newest row
  the operator has read"; cic POSTs on every settle (focus-leave,
  browser-blur, scroll-settle, scroll-to-bottom tap). A POST whose
  `message_id` is at or below the current cursor is a no-op and returns
  the existing (higher) cursor unchanged — never a backward write. A
  lower id is a stale POST racing a slow message-page load (#233), not
  a deliberate move; writing it backward regressed the cursor and the
  `broadcast_set/4` fan-out snapped every device's view to the old read
  marker. Deliberate mark-as-unread has no caller today and, when built,
  gets its own explicit backward path (see moduledoc).

  Validation:

    * `message_id` MUST exist in `messages` AND belong to the same
      `(subject, network_id, channel)` triple — otherwise returns
      `{:error, :invalid_message}`.
    * Subject XOR enforced by changeset.

  Returns `{:ok, %Cursor{}}` on insert / advance / clamped no-op; the
  returned struct always reflects the post-call state (on a stale lower
  POST that is the current, higher cursor). `{:error, _}` on validation
  failure (`:invalid_message` for FK / iso violation,
  `Ecto.Changeset.t()` for changeset-level errors).

  No broadcast is performed here — `broadcast_set/4` is a separate
  step the caller invokes after a successful set, so tests + bulk
  paths can decide whether a fan-out is appropriate.
  """
  @spec set(subject(), integer(), String.t(), integer()) ::
          {:ok, Cursor.t()} | {:error, :invalid_message | Ecto.Changeset.t()}
  def set(subject, network_id, channel, message_id)
      when is_integer(network_id) and is_binary(channel) and channel != "" and
             is_integer(message_id) and message_id > 0 do
    # UX-4 bucket A — canonicalise once at the entry boundary so every
    # downstream call (`message_belongs?/4` validator + `do_set/4`
    # → `get/3` + `Cursor.changeset/2`) observes the canonical key.
    channel = Identifier.canonical_channel(channel)

    if message_belongs?(subject, network_id, channel, message_id) do
      do_set(subject, network_id, channel, message_id)
    else
      {:error, :invalid_message}
    end
  end

  @doc """
  Returns every cursor for `subject`, grouped by network slug then
  channel.

  Shape: `%{network_slug => %{channel => last_read_message_id}}` —
  nested envelope.

  Used at `/me` envelope assembly time. Single LEFT JOIN to `networks`
  for slug resolution; one row per cursor; bounded by ~600 rows in the
  worst case (~20 networks * ~30 channels).
  """
  @spec bulk_for_subject(subject()) :: bulk_envelope()
  def bulk_for_subject(subject) do
    base =
      from(c in Cursor,
        join: n in Network,
        on: n.id == c.network_id,
        select: {n.slug, c.channel, c.last_read_message_id}
      )

    base
    |> subject_filter(subject)
    |> Repo.all()
    |> Enum.reduce(%{}, fn {slug, channel, id}, acc ->
      Map.update(acc, slug, %{channel => id}, &Map.put(&1, channel, id))
    end)
  end

  @typedoc """
  Bulk unread-split envelope (#396): nested
  `%{network_slug => %{channel => %{messages: n, events: n}}}`. Same nesting
  as `bulk_envelope/0`; the value is the content-vs-presence split
  `Scrollback.count_after_split/5` returns per window.
  """
  @type bulk_split_envelope ::
          %{String.t() => %{String.t() => %{messages: non_neg_integer(), events: non_neg_integer()}}}

  @doc """
  #396 — the ENTIRE subject's per-window unread `%{messages, events}` split
  in ONE query, driven by the read cursors (replaces the cold-load's
  N × `Scrollback.count_after_split/5` fan-out — ~2 queries per window at
  logon).

  Drives `FROM read_cursors` LEFT JOIN `messages` on the SINGLE unified
  window predicate #393 made sargable: `nick_fold(COALESCE(m.dm_with,
  m.channel)) == nick_fold(rc.channel)`. That one equality covers BOTH
  window shapes — a channel cursor (`dm_with IS NULL` → COALESCE yields the
  canonical `channel`) and a DM cursor (the cursor's `channel` IS the peer
  nick → COALESCE yields `dm_with` for inbound, `channel` for outbound) —
  and is served by the `messages_{subject}_id_network_id_dm_coalesce_fold_id_kind_index`
  already live on prod. BOTH sides fold: channels are stored canonical
  (#364) and nicks raw (#372), so the fold is required on each side for a
  differently-cased DM peer to resolve to one window.

  Semantics vs `count_after_split/5`: IDENTICAL for channel + DM-peer
  windows. The own-nick SELF window (cursor channel == own nick) differs by
  design (#396): the single predicate folds `COALESCE` and so counts self
  rows the old `channel == own AND dm_with == own` narrowing missed —
  legacy `(channel = own, dm_with IS NULL)` rows AND mixed-case self rows
  (the old narrowing compared `dm_with` RAW). This is a deliberate,
  user-visible count change — see DESIGN_NOTES 2026-07-25.

  * The LEFT JOIN keeps a window with ZERO unread (yields `%{messages: 0,
    events: 0}`), matching the per-window call's zero snapshot.
  * `WHERE rc.last_read_message_id IS NOT NULL` drops nil-cursor windows —
    exactly what the cold-load `is_integer(cursor)` guard skipped; a slug
    whose channels ALL had nil cursors produces no rows and is absent from
    the envelope (`refute Map.has_key?`).
  * One statement covers ALL of the subject's networks (`rc` carries
    `network_id`); the `Network` join resolves the slug.
  """
  @spec bulk_unread_split(subject()) :: bulk_split_envelope()
  def bulk_unread_split(subject) do
    content = Message.content_kinds()
    {sub_field, sub_id} = subject_pair(subject)

    query =
      from(rc in Cursor,
        join: n in Network,
        on: n.id == rc.network_id,
        left_join: m in Message,
        on:
          m.network_id == rc.network_id and
            field(m, ^sub_field) == ^sub_id and
            Identifier.nick_fold(fragment("COALESCE(?, ?)", m.dm_with, m.channel)) ==
              Identifier.nick_fold(rc.channel) and
            m.id > rc.last_read_message_id,
        where: not is_nil(rc.last_read_message_id),
        group_by: [n.slug, rc.channel, fragment("CASE WHEN ? THEN 1 ELSE 0 END", m.kind in ^content)],
        select: {
          n.slug,
          rc.channel,
          fragment("CASE WHEN ? THEN 1 ELSE 0 END", m.kind in ^content),
          count(m.id)
        }
      )

    query
    |> subject_filter(subject)
    |> Repo.all()
    |> Enum.reduce(%{}, fn {slug, channel, bucket, n}, acc ->
      key = if bucket == 1, do: :messages, else: :events
      inner = Map.get(acc, slug, %{})
      entry = Map.get(inner, channel, %{messages: 0, events: 0})
      Map.put(acc, slug, Map.put(inner, channel, %{entry | key => n}))
    end)
  end

  @typedoc """
  Bulk content-tail envelope (#396): nested
  `%{network_slug => %{channel => [%{sender: String.t(), body: String.t() | nil}]}}`
  — up to `cap` oldest unread CONTENT rows per window, for the in-Elixir
  mention fold (`Grappa.Mentions.mentioned?/3` is not expressible in SQL).
  """
  @type bulk_tail_envelope ::
          %{String.t() => %{String.t() => [%{sender: String.t(), body: String.t() | nil}]}}

  @doc """
  #396 — up to `cap` oldest unread CONTENT rows per window for the WHOLE
  subject in ONE query (replaces the cold-load's N ×
  `Scrollback.unread_content_tail/6` fan-out). Returns only `sender` + `body`
  — the two fields `WindowCounts` folds through `Mentions.mentioned?/3`.

  Same unified `nick_fold(COALESCE(...))` window predicate as
  `bulk_unread_split/1`, restricted to content kinds. An INNER JOIN (a
  window with no unread content contributes no rows → zero mentions,
  supplied by the caller's default). The per-window `cap` is enforced with a
  `ROW_NUMBER() OVER (PARTITION BY window ORDER BY id)` window function
  filtered in the outer query — so one huge window can't starve the others
  and the in-memory regex fold stays bounded, exactly as the per-window
  `unread_content_tail/6` cap did.
  """
  @spec bulk_unread_content_tails(subject(), pos_integer()) :: bulk_tail_envelope()
  def bulk_unread_content_tails(subject, cap) when is_integer(cap) and cap > 0 do
    content = Message.content_kinds()
    {sub_field, sub_id} = subject_pair(subject)

    ranked =
      from(rc in Cursor,
        join: n in Network,
        on: n.id == rc.network_id,
        join: m in Message,
        on:
          m.network_id == rc.network_id and
            field(m, ^sub_field) == ^sub_id and
            Identifier.nick_fold(fragment("COALESCE(?, ?)", m.dm_with, m.channel)) ==
              Identifier.nick_fold(rc.channel) and
            m.id > rc.last_read_message_id,
        where: not is_nil(rc.last_read_message_id) and m.kind in ^content,
        select: %{
          slug: n.slug,
          channel: rc.channel,
          sender: m.sender,
          body: m.body,
          rn: over(row_number(), :w)
        },
        windows: [w: [partition_by: [n.slug, rc.channel], order_by: m.id]]
      )

    # Scope the DRIVING `read_cursors` to the subject via the shared
    # `subject_filter/2` (binding 0 == `rc`), identical to
    # `bulk_unread_split/1` + `bulk_for_subject/1` — one way to express
    # "these cursors are mine". `subject_pair/1` is still needed for the
    # `on:`-clause match on `messages` (a join-side filter belongs in `on:`,
    # not `where`, so the JOIN keeps its driving row).
    scoped = subject_filter(ranked, subject)

    capped =
      from(r in subquery(scoped),
        where: r.rn <= ^cap,
        select: {r.slug, r.channel, r.sender, r.body}
      )

    capped
    |> Repo.all()
    |> Enum.reduce(%{}, fn {slug, channel, sender, body}, acc ->
      row = %{sender: sender, body: body}
      inner = Map.get(acc, slug, %{})
      tail = Map.get(inner, channel, [])
      Map.put(acc, slug, Map.put(inner, channel, [row | tail]))
    end)
    |> reverse_tails()
  end

  # ROW_NUMBER orders oldest-first; the reduce prepends, so reverse each
  # per-window list back to oldest-first (order is not load-bearing for the
  # count, but a stable oldest-first list keeps tests deterministic).
  defp reverse_tails(env) do
    Map.new(env, fn {slug, channels} ->
      {slug, Map.new(channels, fn {channel, rows} -> {channel, Enum.reverse(rows)} end)}
    end)
  end

  # Subject → {message-column-atom, uuid} for a join-side `field/2` match
  # (the LEFT/INNER JOIN keeps the driving `read_cursors` row, so the
  # subject match on `messages` must live in the `on:` clause, not `where`).
  @spec subject_pair(subject()) :: {:user_id | :visitor_id, Ecto.UUID.t()}
  defp subject_pair({:user, user_id}) when is_binary(user_id), do: {:user_id, user_id}
  defp subject_pair({:visitor, visitor_id}) when is_binary(visitor_id), do: {:visitor_id, visitor_id}

  @doc """
  Broadcasts a typed `read_cursor_set` event on the per-channel topic
  for `(user_name, network_slug, channel)`.

  Payload shape:

      %{kind: "read_cursor_set", last_read_message_id: <integer>,
        badge_count: <integer>}

  Cross-device sync: every live cic instance subscribed to the
  per-channel topic receives the event and updates its cursor signal
  map. Emit on every `set/4`, no batching, no throttle.

  `badge_count` (PWA icon badge door #3, 2026-06-21) is the
  notify-worthy unread total AFTER this advance — the caller computes it
  (it holds the subject; `ReadCursor` deliberately does NOT depend on
  `Grappa.Push.BadgeCount`, which sits a layer above) and passes it in so
  every listening client refreshes its icon badge / `document.title`
  without a `/me` round-trip.

  The caller is responsible for resolving `user_name` + `network_slug`
  from the subject — the broadcast topic is user-rooted (per CLAUDE.md
  "PubSub topic naming") and ReadCursor's API is subject-rooted
  (`{:user, uuid}` / `{:visitor, uuid}`), so the translation happens at
  the call site where both are already in scope. Visitor callers pass
  `"visitor:" <> visitor.id` as the user-name segment — same shape
  `UserSocket` uses for the visitor's user-rooted topic tree (V4
  visitor-parity, 2026-05-15).
  """
  @spec broadcast_set(String.t(), String.t(), String.t(), integer(), non_neg_integer()) ::
          :ok | {:error, term()}
  def broadcast_set(user_name, network_slug, channel, last_read_message_id, badge_count)
      when is_binary(user_name) and is_binary(network_slug) and is_binary(channel) and
             is_integer(last_read_message_id) and is_integer(badge_count) do
    topic = Topic.channel(user_name, network_slug, channel)

    Grappa.PubSub.broadcast_event(
      topic,
      Wire.read_cursor_set(last_read_message_id, badge_count)
    )
  end

  @doc """
  Test-support: drains every read-cursor row for `user_id` in a single
  DELETE. Intended for `Grappa.TestSupport.SubjectReset` only — production
  cursor lifecycle is per-channel via `set/4`.
  """
  @spec clear_all_for_user(Ecto.UUID.t()) :: :ok
  def clear_all_for_user(user_id) when is_binary(user_id) do
    query = from(c in Cursor, where: c.user_id == ^user_id)
    Repo.delete_all(query)
    :ok
  end

  @doc """
  Test-support: force the cursor for `(subject, network_id, channel)` to
  `message_id`, **bypassing the monotonic advance-only clamp** of `set/4`.

  Intended for `GrappaWeb.TestReadCursorController` (compile-gated to
  dev/test) ONLY. The e2e cursor/divider specs must plant a BACKWARD
  (mid-page) cursor to stage an unread-divider scenario, which `set/4`
  correctly refuses after #233 made the write advance-only. Before #233
  those specs seeded via the last-write-wins `POST /read-cursor`; the
  hardening dropped that capability, so this restores it for tests
  WITHOUT relaxing the production endpoint (which still routes through
  `set/4`). Mirrors the `clear_all_for_user/1` test-support precedent:
  the function ships in the prod release but has no production caller.

  This is NOT the production "deliberate mark-as-unread" path — that
  still gets its OWN explicit surface when a real caller ships (see the
  moduledoc). Do not wire this into any production controller.

  Still validates `message_belongs?` — a forced cursor must reference a
  real row in the target `(subject, network_id, channel)` window, so a
  typo'd seed is a loud `{:error, :invalid_message}`, not a dangling
  cursor. No broadcast here — the caller fans out via `broadcast_set/5`
  exactly as `set/4`'s controller does, so cic adopts the backward move
  through its authoritative `read_cursor_set` WS path.
  """
  @spec force_set(subject(), integer(), String.t(), integer()) ::
          {:ok, Cursor.t()} | {:error, :invalid_message | Ecto.Changeset.t()}
  def force_set(subject, network_id, channel, message_id)
      when is_integer(network_id) and is_binary(channel) and channel != "" and
             is_integer(message_id) and message_id > 0 do
    channel = Identifier.canonical_channel(channel)

    if message_belongs?(subject, network_id, channel, message_id) do
      force_write(subject, network_id, channel, message_id)
    else
      {:error, :invalid_message}
    end
  end

  @doc """
  #373 — migrates the DM read cursor for `old_nick` to `new_nick` in
  `(subject, network_id)`, so a query window that followed a peer's NICK
  keeps its read state. Without this the migrated history reads as fully
  UNREAD: the `new` window has no cursor row (the old row is stranded at
  `old`), so `WindowCounts` derives the count from `cursor || 0`.

  Case-insensitive on both nicks (rfc1459 fold, #121). The cursor
  `channel` is stored case-preserved (`canonical_channel/1` is a no-op for
  a bare nick) and matched fold-wise here, mirroring
  `Scrollback.rename_dm_peer/4`. `fold(old) == fold(new)` (a case-only
  change) is a noop — the fold already resolves. A nick-collision (a
  cursor already folds to `new`, i.e. a merge into an existing DM) keeps
  the `new` cursor and drops the `old` one (mirrors `QueryWindows.rename/4`
  keep-new merge; a rare imperfection if `old` was read further, self-heals
  on the next settle). The `Ecto.ConstraintError` rescue covers the (rare)
  race where a concurrent `set/4` from the channel process lands a `new`
  cursor between the exists-check and the update — the unique index would
  otherwise reject the rename and crash the caller.

  Returns `:ok`. Sole caller: `Grappa.Session.Server.apply_effects/2` on
  `{:peer_nick_renamed, old, new}`, alongside `Scrollback.rename_dm_peer/4`
  and after `QueryWindows.rename/4` reports `:renamed`.
  """
  @spec rename_dm_peer(subject(), integer(), String.t(), String.t()) :: :ok
  def rename_dm_peer(subject, network_id, old_nick, new_nick)
      when is_integer(network_id) and is_binary(old_nick) and is_binary(new_nick) do
    folded_old = Identifier.canonical_nick(old_nick)
    folded_new = Identifier.canonical_nick(new_nick)

    if folded_old == folded_new do
      :ok
    else
      old_query =
        Cursor
        |> subject_filter(subject)
        |> where(
          [c],
          c.network_id == ^network_id and Identifier.nick_fold(c.channel) == ^folded_old
        )

      cond do
        not Repo.exists?(old_query) ->
          :ok

        cursor_folds_to?(subject, network_id, folded_new) ->
          Repo.delete_all(old_query)
          :ok

        true ->
          try do
            Repo.update_all(old_query, set: [channel: new_nick])
          rescue
            Ecto.ConstraintError ->
              # A concurrent set/4 (channel process, NOT the serialized
              # Session.Server) raced a `new` cursor in between the check
              # and the update → the unique index rejects the rename.
              # Degrade to the merge path: keep the new, drop the old.
              Repo.delete_all(old_query)
          end

          :ok
      end
    end
  end

  @spec cursor_folds_to?(subject(), integer(), String.t()) :: boolean()
  defp cursor_folds_to?(subject, network_id, folded) do
    Cursor
    |> subject_filter(subject)
    |> where([c], c.network_id == ^network_id and Identifier.nick_fold(c.channel) == ^folded)
    |> Repo.exists?()
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  @spec do_set(subject(), integer(), String.t(), integer()) ::
          {:ok, Cursor.t()} | {:error, Ecto.Changeset.t()}
  defp do_set(subject, network_id, channel, message_id) do
    case get(subject, network_id, channel) do
      # Monotonic clamp (#233): `set/4` is advance-only. Any id at or
      # below the stored cursor is a no-op that returns the EXISTING
      # (higher-or-equal) cursor unchanged — this subsumes the old
      # equal-id no-op (equal is just the `<=` boundary) AND rejects the
      # stale/lower POST that used to regress the cursor. A stale lower
      # id arrives when cic taps scroll-to-bottom during a ~1.5s
      # message-page load and the currently-loaded bottom (near the old
      # read marker) POSTs before the newest page lands; last-write-wins
      # wrote it backward and the `read_cursor_set` broadcast snapped
      # every view back ~2s later (see moduledoc "Monotonic advance").
      # Deliberate mark-as-unread has no caller today; when built it gets
      # its OWN explicit backward path — do NOT relax this to `<`.
      #
      # `is_integer(current)` is load-bearing, NOT decoration:
      # `last_read_message_id` is `ON DELETE SET NULL`, so an archive
      # purge (`Scrollback.delete_for_channel/3`) can leave the row alive
      # with `current == nil`. In Elixir term order a number sorts BEFORE
      # any atom, so `message_id <= nil` is `true` for EVERY id — without
      # the `is_integer` guard a NULL'd cursor would clamp every future
      # POST and freeze at NULL forever (and hand the controller a nil id
      # that crashes `broadcast_set/5`). Guarding on `is_integer` lets a
      # NULL cursor fall through to the update clause and recover — the
      # migration's designed behaviour.
      %Cursor{last_read_message_id: current} = cursor
      when is_integer(current) and message_id <= current ->
        {:ok, cursor}

      existing ->
        upsert_cursor(existing, subject, network_id, channel, message_id)
    end
  end

  # Test-support unconditional write for `force_set/4` — insert-or-update
  # with NO monotonic clamp (that clamp is `do_set/4`'s production
  # correctness contract, #233). Delegates to the shared `upsert_cursor/5`.
  @spec force_write(subject(), integer(), String.t(), integer()) ::
          {:ok, Cursor.t()} | {:error, Ecto.Changeset.t()}
  defp force_write(subject, network_id, channel, message_id) do
    upsert_cursor(get(subject, network_id, channel), subject, network_id, channel, message_id)
  end

  # Raw insert-or-update of the cursor row — NO monotonic clamp. `existing`
  # is the pre-fetched `Cursor` row (or `nil`). Shared by `do_set/4` (which
  # applies its advance-only clamp FIRST, then falls through here) and the
  # test-only `force_set/4` (which skips the clamp). The clamp is the ONLY
  # difference between the two write paths, so the write itself lives here
  # once (CLAUDE.md "implement once, reuse everywhere").
  @spec upsert_cursor(Cursor.t() | nil, subject(), integer(), String.t(), integer()) ::
          {:ok, Cursor.t()} | {:error, Ecto.Changeset.t()}
  defp upsert_cursor(%Cursor{} = cursor, _, _, _, message_id) do
    cursor
    |> Cursor.changeset(%{last_read_message_id: message_id})
    |> Repo.update()
  end

  defp upsert_cursor(nil, subject, network_id, channel, message_id) do
    attrs =
      Map.merge(subject_attrs(subject), %{
        network_id: network_id,
        channel: channel,
        last_read_message_id: message_id
      })

    %Cursor{}
    |> Cursor.changeset(attrs)
    |> Repo.insert()
  end

  @spec message_belongs?(subject(), integer(), String.t(), pos_integer()) :: boolean()
  defp message_belongs?(subject, network_id, channel, message_id) do
    # UX-6 bucket K (2026-05-21) — share `Scrollback.channel_or_dm_where/3`
    # with the read path so cursor validation and scrollback fetch agree
    # on the "what counts as a row in this window" predicate. Pre-K this
    # function used a literal `m.channel == ^channel` filter; inbound
    # DMs (`channel = own_nick, dm_with = peer`) failed validation when
    # cic POSTed the cursor for the peer's query window, so the in-pane
    # unread-marker never cleared on focus. Outbound DMs (`channel = peer`)
    # passed, which is why "sending a message to the peer cleared the
    # marker." Single shared predicate closes the divergence class.
    #
    # `own_nick: nil` — cic's `POST /networks/:slug/channels/:chan/read-cursor`
    # doesn't carry own_nick (it would be redundant since the row
    # existence check is symmetric for either direction). For an own-nick
    # query window, the OR-shape over-matches every peer DM whose
    # `dm_with == own_nick`, but `Repo.exists?` only needs ONE matching
    # row from the same subject to validate the cursor — the precise
    # narrowing is a read-time concern (scrollback display), not a
    # write-time concern (cursor validity).
    Message
    |> subject_filter(subject)
    |> where([m], m.id == ^message_id and m.network_id == ^network_id)
    |> Grappa.Scrollback.channel_or_dm_where(channel, nil)
    |> Repo.exists?()
  end

  # Mirrors `Grappa.Scrollback.subject_where/2` — same tagged-tuple
  # discriminator, same `m.user_id` / `m.visitor_id` partition. Reused
  # across `Cursor` queries (binding name `c`) and `Message` existence
  # queries (binding name `m`); Ecto's binding-by-position lookup
  # works on both since each query has a single from-binding.
  @spec subject_filter(Ecto.Queryable.t(), subject()) :: Ecto.Query.t()
  defp subject_filter(queryable, {:user, user_id}) when is_binary(user_id) do
    where(queryable, [row], row.user_id == ^user_id)
  end

  defp subject_filter(queryable, {:visitor, visitor_id}) when is_binary(visitor_id) do
    where(queryable, [row], row.visitor_id == ^visitor_id)
  end

  @spec subject_attrs(subject()) :: %{atom() => Ecto.UUID.t()}
  defp subject_attrs({:user, user_id}), do: %{user_id: user_id}
  defp subject_attrs({:visitor, visitor_id}), do: %{visitor_id: visitor_id}
end
