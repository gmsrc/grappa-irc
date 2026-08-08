defmodule Grappa.Release do
  @moduledoc """
  Release-time tasks for FreeBSD `mix release` deploys.

  ## Why this exists

  The Docker deploy path (`scripts/deploy.sh`) runs `mix ecto.migrate`
  with the full project on disk + Mix available. The release path
  (FreeBSD bastille jail, `_build/prod/rel/grappa/bin/grappa`) ships
  only compiled BEAM + the release boot scripts — no Mix, no project
  source. `bin/grappa eval 'Grappa.Release.migrate()'` is the
  release-aware bridge to the same Ecto.Migrator the deploy script
  invokes elsewhere.

  Invoke from `infra/freebsd/deploy.sh` BEFORE swapping the rc.d
  service, so a schema change is applied against the old code and
  the new release boots into a consistent DB. Same ordering
  discipline as the Docker cold path documented in CLAUDE.md
  "Migrations".

  ## Usage

      _build/prod/rel/grappa/bin/grappa eval 'Grappa.Release.migrate()'
      _build/prod/rel/grappa/bin/grappa eval 'Grappa.Release.seed_themes()'
      _build/prod/rel/grappa/bin/grappa eval 'Grappa.Release.rollback(Grappa.Repo, 20260501000000)'

  Each entry point loads `@app` (the release boot script does NOT
  start the application — it only loads the .app file so config is
  available) and starts the Cloak vault the Repo needs at schema-load
  time (encrypted columns route through `Grappa.EncryptedBinary`) —
  see `start_vault!/0`.

  The deploy scripts name these functions as STRINGS inside `eval`, so
  nothing at compile time links the two. `Grappa.ReleaseTest` closes
  that gap by parsing the deploy scripts and asserting every
  `Grappa.Release.*` they invoke is actually exported here.
  """

  use Boundary, top_level?: true, deps: [Grappa.Repo, Grappa.Themes, Grappa.Vault]

  alias Grappa.Themes

  @app :grappa

  @doc """
  Runs all pending migrations against the configured repos.

  Stops the BEAM cleanly on success or any error. Caller should
  treat non-zero exit as a deploy failure and refuse to restart
  the service.
  """
  @spec migrate() :: :ok
  def migrate do
    load_app()
    start_vault!()

    for repo <- repos() do
      case Ecto.Migrator.with_repo(repo, &Ecto.Migrator.run(&1, :up, all: true)) do
        {:ok, _, _} -> :ok
        {:error, reason} -> raise "migration failed: #{inspect(reason)}"
      end
    end

    :ok
  end

  @doc """
  Rolls a single repo back to the named version. Operator-only —
  the deploy script never calls this.
  """
  @spec rollback(module(), non_neg_integer()) :: :ok
  def rollback(repo, version) when is_atom(repo) and is_integer(version) do
    load_app()

    case Ecto.Migrator.with_repo(repo, &Ecto.Migrator.run(&1, :down, to: version)) do
      {:ok, _, _} -> :ok
      {:error, reason} -> raise "rollback failed: #{inspect(reason)}"
    end
  end

  @doc """
  Materialises the curated built-in theme gallery as system-owned,
  published themes. Idempotent upsert, which is what lets the deploy
  scripts run it unconditionally on every deploy (#440).

  The release-path twin of `mix grappa.seed_themes`: a packaged release
  ships no Mix, so the substrates that run one — the bastille jail and
  the published Docker image — reach the seed through here instead.
  Both doors drive `Grappa.Themes.seed_builtins/0`; there is one
  implementation, not two.
  """
  @spec seed_themes() :: :ok
  def seed_themes do
    load_app()
    start_vault!()

    case Ecto.Migrator.with_repo(Grappa.Repo, fn _ -> Themes.seed_builtins() end) do
      {:ok, count, _} -> IO.puts("seeded #{count} curated built-in themes")
      {:error, reason} -> raise "theme seeding failed: #{inspect(reason)}"
    end

    :ok
  end

  defp repos do
    Application.fetch_env!(@app, :ecto_repos)
  end

  # Cloak's Ecto types call into the Vault GenServer at load/dump time, so
  # reading any schema with an encrypted column raises `:noproc` when it
  # is not running — which is why the supervision tree starts Vault BEFORE
  # Repo (see Grappa.Application). A release `eval` starts neither, so the
  # ordering has to be restated here rather than inherited.
  #
  # seed_themes/0 reads the reserved system user, whose `totp_secret_
  # encrypted` is NULL — and cloak_ecto short-circuits `load(nil)` without
  # touching the vault, so today it would survive without this. That is an
  # accident of one column being empty, not a contract; the first encrypted
  # column that holds a value would break the release path only, on two
  # substrates, at deploy time.
  #
  # `already_started` is the expected steady state whenever the app is up
  # (a test process, an operator in a live remote shell) — same shape as
  # load_app/0's `:already_loaded`.
  defp start_vault! do
    case Grappa.Vault.start_link() do
      {:ok, _} -> :ok
      {:error, {:already_started, _}} -> :ok
    end
  end

  defp load_app do
    # Application.load/1 returns `:ok | {:error, {:already_loaded, _} | term()}`.
    # `:already_loaded` is the expected steady-state inside a release boot
    # (boot script loads .app files before evaluating `eval`); treat it as
    # success. Any other error halts the migrate/rollback flow.
    case Application.load(@app) do
      :ok -> :ok
      {:error, {:already_loaded, _}} -> :ok
      {:error, reason} -> raise "Application.load(#{@app}) failed: #{inspect(reason)}"
    end
  end
end
