defmodule Grappa.Repo do
  @moduledoc """
  Ecto repository backed by sqlite via `ecto_sqlite3`.

  This is the SINGLE shared Repo for the bouncer — there is no per-user
  dynamic Repo, no `put_dynamic_repo` plumbing. The alternative was
  considered and rejected on coherence + plumbing-tax grounds; see
  `docs/DESIGN_NOTES.md` (2026-04-25 single-sqlite sub-decision) for
  the full reasoning. Resist the urge to introduce dynamic Repos.
  """

  use Boundary, top_level?: true, deps: []

  use Ecto.Repo,
    otp_app: :grappa,
    adapter: Ecto.Adapters.SQLite3

  @doc """
  Runs `fun` inside a SQLite `BEGIN IMMEDIATE` transaction — the
  write-transaction variant of `transaction/2`.

  Ecto/ecto_sqlite3's default transaction is `DEFERRED`: it opens as a
  reader and upgrades to a writer on the first write statement. Under WAL
  with `pool_size > 1`, if another connection already holds the file-level
  write lock, that read→write upgrade fails with an IMMEDIATE `SQLITE_BUSY`
  that `busy_timeout` does NOT cover — the caller does not wait it out, it
  raises at once (GH #524). `BEGIN IMMEDIATE` takes the write lock up front,
  so `busy_timeout` governs the wait and the transaction blocks-then-
  proceeds instead of failing.

  Use this for every WRITE transaction. Keep `transaction/2` (deferred) for
  read-only transactions so WAL read concurrency is preserved — a global
  `default_transaction_mode: :immediate` would serialize reads too. This is
  the documented `ecto_sqlite3` pattern for mixed read/write workloads.

  The contract is fun-only today — every write-transaction caller passes a
  `fn -> … end`. `Ecto.Multi` support is additive: widen the input to
  `fun() | Ecto.Multi.t()` AND add `Ecto.Multi.failure()` back to the return
  together when a caller first needs it. Advertising the `Multi` failure
  4-tuple now (with no caller that can produce it) forces every caller's
  `@spec` to carry an impossible return — Dialyzer flags exactly that.
  """
  @spec immediate_transaction(fun()) :: {:ok, any()} | {:error, any()}
  def immediate_transaction(fun) do
    transaction(fun, mode: :immediate)
  end
end
