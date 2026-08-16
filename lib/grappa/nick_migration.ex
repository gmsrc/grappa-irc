defmodule Grappa.NickMigration do
  @moduledoc """
  Single home of the nick-rename migration set (#1374 P-S2).

  A NICK change is an identity MIGRATION, not a fold: every store keyed on
  the old nick moves old -> new. The set is:

    * `Grappa.QueryWindows.rename/4` — the window row (#373).
    * `Grappa.Scrollback.rename_dm_peer/4` — the DM history (#373).
    * `Grappa.ReadCursor.rename_dm_peer/4` — the DM read cursor, else the
      migrated history reads as fully unread (#373).
    * `Grappa.UserSettings.rename_muted_target!/4` — the per-conversation
      mute, nick-keyed since #1038 (#1340).

  and, when the nick that moved is OUR OWN, `Scrollback.rename_own_nick/4`
  (the inbound-DM own-nick TAG, #514) plus `rename_self_window/4` and the
  three above behind its row-count gate (#948).

  ## Why the set has a module and not just a paragraph

  Until #1374 the set existed as prose in CLAUDE.md ("A NEW nick-keyed store
  MUST be added to this migration set") over a chain inlined in
  `Grappa.Session.Server`. A new nick-keyed store was added by hoping
  somebody read the paragraph. Here the invariant is executable: the set is
  this module's two public verbs, and a store left out of them is visible as
  a store this module never calls.

  ## Why the transaction lives HERE

  The chain spans four contexts. None of them can host the transaction
  without owning the other three's tables — an abstraction that leaks by
  construction. `Grappa.Session.Server`, the only caller, cannot host it
  either: the `Grappa.Session` boundary deliberately has no `Grappa.Repo`
  dep, and opening one to reach `immediate_transaction/1` is exactly the
  dependency its moduledoc denies. So this is a TOP-LEVEL boundary that deps
  the four contexts and `Repo`, called from Session — the
  `Grappa.SpawnOrchestrator` shape (a cross-context verb, not a supervised
  child).

  ## Composition: retry OUTSIDE, transaction INSIDE, broadcast NEITHER

  `Repo.BusyRetry.run(fn -> Repo.immediate_transaction(fn -> … end) end)`:

    * **Transaction inside** — a crash or busy between two steps used to
      strand the history under the new nick with a cursor keyed to the old
      one (the "reads as fully unread" failure the cursor move exists to
      prevent). All four stores move together or none does.
    * **Retry outside** — the whole transaction is the retryable unit. Each
      step is idempotent in the only sense that matters here: a rolled-back
      attempt left nothing behind, so a replay starts from the same
      pre-state. Callees reached from here are the non-retrying `!`
      variants where the family offers one; a nested retry would sleep
      holding the open transaction's connection.
    * **Broadcast in NEITHER** — `query_windows_list` is the truthful
      "rename fully applied" barrier and stays in `Session.Server`, after
      this returns `{:ok, _}` (#373 rename-order fix). Inside the retry a
      re-attempt could broadcast twice; inside the transaction it could
      announce a rename that then rolled back.

  **And NEITHER is entered when there is nothing to migrate (#1378).**
  `peer_renamed/5` probes `QueryWindows.exists?/3` first: with no window the
  mute is the only store that can move, and this four-store transaction is
  skipped (the mute setter keeps one of its own — see
  `windowless_peer_renamed/4`). That is not an optimisation — an unconditional
  `BEGIN IMMEDIATE` took SQLite's single write lock once per session per peer
  rename to do nothing, and under channel fan-out the sessions raced each
  other into `busy_locked`. See `windowless_peer_renamed/4` for the race
  argument and for why `own_renamed/5` keeps its unconditional transaction.

  Terminal on budget exhaustion is `{:error, :db_unavailable}`, which the
  session logs and DROPs (#590 background posture) — a rename is not worth
  disconnecting a user over, and the old-nick state it leaves behind is
  self-consistent. Before #1374 the same busy RAISED through strict
  `{:ok, _} =` binds and took the session down mid-migration.

  ## The transaction earns its place PROSPECTIVELY — do not remove it

  Today no test can kill a mutant that deletes `immediate_transaction/1`
  from `migrate/1`, and that is a property of the CURRENT step list, not a
  licence. Every step here is total on real data: the two scrollback
  renames are `update_all`, `ReadCursor.rename_dm_peer/4` handles a
  fold-collision by dropping the stale cursor, `QueryWindows.rename/4`
  merges on collision and even rescues the unique-index race, and the
  mute's changeset validates only `data` presence and the subject XOR,
  neither of which a rename of an existing row can violate. The one
  failure the chain admits — the enclosing retry's budget running out —
  fires before the first step by construction. Nothing can fail in the
  middle, so nothing can be observed rolling back.

  That changes the moment the set grows, and CLAUDE.md says it WILL: "A
  NEW nick-keyed store MUST be added to this migration set or a rename
  silently strands its old-nick rows." A new store is under no obligation
  to be total — the next one may carry a validation, a unique constraint,
  or a genuine `{:error, _}` arm. On that day a half-applied identity
  becomes reachable and this transaction is the only thing standing
  between a rename and a window pointing at history that moved without
  it. It is here for the step that has not been written yet, and the
  test that will finally be able to buy it is the one that adds a
  fallible step.
  """

  use Boundary,
    top_level?: true,
    deps: [
      Grappa.QueryWindows,
      Grappa.ReadCursor,
      Grappa.Repo,
      Grappa.Scrollback,
      Grappa.Subject,
      Grappa.UserSettings
    ]

  alias Grappa.{QueryWindows, ReadCursor, Repo, Scrollback, Subject, UserSettings}
  alias Grappa.Repo.BusyRetry

  @typedoc """
  Outcome of a peer rename. `window` is `:noop` when the peer had no query
  window (the common case — a peer we never queried costs one indexed
  lookup and no writes), in which case `rows` is 0. `mute` is independent
  of both: a mute outlives the window it silenced.
  """
  @type peer_result :: %{
          window: :renamed | :noop,
          rows: non_neg_integer(),
          mute: :renamed | :noop
        }

  @typedoc """
  Outcome of an own-nick rename. `tag_rows` counts the inbound-DM own-nick
  TAGs re-keyed (#514) — independent of the self window. `rows` counts the
  SELF window's scrollback rows, and is the gate: at 0 the window, cursor
  and mute are deliberately untouched (see `own_renamed/5`).
  """
  @type own_result :: %{
          tag_rows: non_neg_integer(),
          rows: non_neg_integer(),
          window: :renamed | :noop,
          mute: :renamed | :noop
        }

  @doc """
  Migrates every store keyed on a PEER's old nick, atomically.

  The window row is the gate for the history + cursor: a peer we never
  queried has nothing to move. The mute is migrated UNCONDITIONALLY and
  deliberately outside that gate — a mute outlives the window that was
  muted (closing a tab does not unmute it), so gating it on the window row
  would strand exactly the mute nobody can see to fix (#1340 K-S2).

  Returns `{:error, :db_unavailable}` when the retry budget is exhausted
  (nothing applied), or `{:error, changeset}` when the mute's settings row
  will not validate — also nothing applied, because the transaction rolls
  back on it rather than half-migrating an identity.
  """
  @spec peer_renamed(Subject.t(), integer(), String.t(), String.t(), String.t()) ::
          {:ok, peer_result()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  def peer_renamed({_, _} = subject, network_id, network_slug, old_nick, new_nick)
      when is_integer(network_id) and is_binary(network_slug) and is_binary(old_nick) and
             is_binary(new_nick) do
    if QueryWindows.exists?(subject, network_id, old_nick) do
      migrate(fn ->
        mute = UserSettings.rename_muted_target!(subject, network_slug, old_nick, new_nick)

        case QueryWindows.rename(subject, network_id, old_nick, new_nick) do
          {:ok, :renamed} ->
            {:ok, rows} = Scrollback.rename_dm_peer(subject, network_id, old_nick, new_nick)
            :ok = ReadCursor.rename_dm_peer(subject, network_id, old_nick, new_nick)
            %{window: :renamed, rows: rows, mute: mute}

          {:ok, :noop} ->
            %{window: :noop, rows: 0, mute: mute}
        end
      end)
    else
      windowless_peer_renamed(subject, network_slug, old_nick, new_nick)
    end
  end

  # #1378 — a peer we never queried is the OVERWHELMING case: IRC delivers a
  # NICK for every channel-sharing peer, so one rename fans out to every
  # session in the channel, and almost none of them hold a window for it.
  # Without the gate above each of those opened `BEGIN IMMEDIATE`, taking the
  # RESERVED lock on SQLite's single writer to migrate nothing — measured on
  # the #458 e2e as four sessions racing per rename, `busy_locked` for the
  # full 1500ms budget, a dropped scrollback row and a session stalled ~33s
  # behind its inbound stream.
  #
  # With no window, the mute is the ONLY store that can move, so this path
  # takes the caller-facing `rename_muted_target/4` and skips the four-store
  # transaction. It does NOT skip a transaction altogether, and saying so
  # would be the log-honesty failure CLAUDE.md names: #1375 put a
  # `BEGIN IMMEDIATE` inside that setter, because one `Repo.update` of the
  # `data` blob is a read-modify-write pair that silently drops a concurrent
  # writer's key. So what this gate removes is the transaction spanning
  # `QueryWindows.rename/4` plus two `update_all`s — a much shorter hold of
  # the RESERVED lock, not no hold. Whether the residue still reproduces the
  # #458 profile is NOT established by the measurement quoted above, which
  # was taken before #1375 landed. The migration path proper is untouched —
  # same transaction, same retry, same order.
  #
  # The probe is a READ taken outside any transaction, and that is safe in
  # the only direction that matters. If it sees a window that is gone by the
  # time the transaction runs, we opened one transaction too many — the cost
  # we used to pay unconditionally. It cannot skip a migration that was
  # needed: a window CREATED after the probe is equally invisible to a
  # `rename/4` running inside the transaction, whose own `SELECT` would have
  # missed it just the same, so the stranded-window window is not widened by
  # a microsecond. The transaction buys atomicity across the four stores, not
  # mutual exclusion against a window opened later.
  #
  # `own_renamed/5` deliberately keeps its unconditional transaction: its
  # first step (`Scrollback.rename_own_nick/4`) is an `update_all` whose
  # row count cannot be known without running it, so a probe there would
  # cost what it saves — and our own nick moves once per `/nick`, not once
  # per peer per session.
  @spec windowless_peer_renamed(Subject.t(), String.t(), String.t(), String.t()) ::
          {:ok, peer_result()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  defp windowless_peer_renamed(subject, network_slug, old_nick, new_nick) do
    case UserSettings.rename_muted_target(subject, network_slug, old_nick, new_nick) do
      {:ok, mute} -> {:ok, %{window: :noop, rows: 0, mute: mute}}
      {:error, _} = err -> err
    end
  end

  @doc """
  Migrates every store keyed on OUR OWN old nick, atomically.

  Two independent migrations share the transaction. The inbound-DM own-nick
  TAG (`tag_rows`) always moves: `Push.Triggers.dm?/2` reads it back against
  the LIVE nick, so a stale tag silently loses a DM's badge (#514).

  The SELF window (`/msg <ownnick>`, #948) moves behind its scrollback row
  count, the inverse of the peer arm's window gate: a window standing at our
  old nick is EITHER our self window or a leftover query with a peer who
  bore that nick before us, and the fold-unique index makes those ONE row.
  Only the scrollback's `sender` tells them apart, so a zero count means "no
  self conversation here" and the window, cursor and mute stay put — the
  cheaper of two wrongs against filing a peer's identity under our new nick.
  """
  @spec own_renamed(Subject.t(), integer(), String.t(), String.t(), String.t()) ::
          {:ok, own_result()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  def own_renamed({_, _} = subject, network_id, network_slug, old_nick, new_nick)
      when is_integer(network_id) and is_binary(network_slug) and is_binary(old_nick) and
             is_binary(new_nick) do
    migrate(fn ->
      {:ok, tag_rows} = Scrollback.rename_own_nick(subject, network_id, old_nick, new_nick)
      {:ok, rows} = Scrollback.rename_self_window(subject, network_id, old_nick, new_nick)

      if rows > 0 do
        :ok = ReadCursor.rename_dm_peer(subject, network_id, old_nick, new_nick)
        {:ok, window} = QueryWindows.rename(subject, network_id, old_nick, new_nick)
        mute = UserSettings.rename_muted_target!(subject, network_slug, old_nick, new_nick)

        %{tag_rows: tag_rows, rows: rows, window: window, mute: mute}
      else
        %{tag_rows: tag_rows, rows: 0, window: :noop, mute: :noop}
      end
    end)
  end

  @spec migrate((-> result)) :: {:ok, result} | {:error, Ecto.Changeset.t() | :db_unavailable}
        when result: peer_result() | own_result()
  defp migrate(fun) do
    BusyRetry.run(fn -> Repo.immediate_transaction(fun) end)
  end
end
