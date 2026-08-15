defmodule Mix.Tasks.Grappa.Migrate do
  @shortdoc "Run pending Ecto migrations, refusing a duplicated version first"

  @moduledoc """
  The cold-deploy migrate door for the substrates that keep Mix around —
  Docker (`scripts/deploy.sh`), native Linux (`infra/linux/deploy.sh` and
  its first install) — replacing a bare `mix ecto.migrate` (#1348).

  ## Why a task instead of `ecto.migrate`

  `ecto.migrate` cannot carry the duplicate-version audit, and the audit is
  not optional: a version claimed by two files that is already applied
  leaves the pending set EMPTY, so the migrator reports success having run
  neither file, forever. See `Grappa.Deploy.MigrationAudit`.

  ## Why it starts nothing

  Deliberately NOT `Mix.Tasks.Grappa.Boot.start_app_silent/0`, which the
  other `grappa.*` tasks use. That helper exists to keep a task that needs
  the APP from opening upstream IRC connections or binding port 4000
  against a live host; a migrate needs neither the app nor those
  suppressions, and `mix ecto.migrate` has run bare against a live host on
  these substrates since they existed. Starting nothing satisfies that
  rule's reason more strictly than starting everything with two children
  suppressed — and it keeps an app boot off the cold path of the substrate
  whose documented pathology is a boot that kills the BEAM
  (`docs/OPERATIONS.md` § "Migrations run a mix task, never the release's
  `eval`").

  `mix app.config` is still needed, and for the reason
  `Mix.Tasks.Grappa.Boot` records: a bare `Ecto.Migrator` call does not
  evaluate `config/runtime.exs` on its own, and under `MIX_ENV=prod` the
  database path exists only there.

  Both the audit and the migrator run through `Grappa.Release.migrate/0`,
  so this substrate and the jail share one implementation rather than two
  that can drift — the same posture `Grappa.Release.seed_themes/0` takes
  with `mix grappa.seed_themes`.

  ## Usage

      scripts/mix.sh grappa.migrate
  """

  use Boundary, top_level?: true, deps: [Grappa.Release]

  use Mix.Task

  @impl Mix.Task
  def run(_) do
    Mix.Task.run("app.config")
    Grappa.Release.migrate()
  end
end
