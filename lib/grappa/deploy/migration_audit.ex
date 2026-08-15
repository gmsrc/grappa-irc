defmodule Grappa.Deploy.MigrationAudit do
  @moduledoc """
  Refuses to migrate past a version claimed by two files (#1348).

  ## The regime this exists for

  A duplicated migration version has three regimes, measured in Ecto's own
  source. On a fresh database it raises `Ecto.MigrationError` — loud, fine.
  On the hot preflight it dies on a `[path] = Path.wildcard(…)` match. And
  on a database that has **already applied** that version, both files drop
  out of the pending set, `ensure_no_duplication!([])` answers `:ok`, the
  run reports SUCCESS, and neither migration ever runs — permanently, since
  the version is already in `schema_migrations`.

  The third is the one production hits, and no count can see it: a pending
  count of zero is exactly what it produces, and exactly what a healthy
  deploy produces. So this compares version SETS, and the passing arm
  reports the counts it OBSERVED rather than announcing an absence of work.

  ## Why it does not live in `Grappa.Deploy.Preflight`

  Every substrate invokes the classifier with `mix run --no-start`, so
  `Preflight.cli/1` has no application started and no Repo — it cannot read
  `schema_migrations` at all. The gate therefore hangs off the doors that
  migrate, where a pool is live by construction: `check/1` for a caller that
  reports a refusal (the hot handler), `check!/1` for one whose refusal is a
  non-zero exit (`Grappa.Release.migrate/0`, `mix grappa.migrate`).

  ## What it deliberately does not report

  A version in `schema_migrations` with no file on disk is real, but
  separating it out means recognising the literal `"** FILE NOT FOUND **"`
  that `Ecto.Migrator.collect_migrations/2` writes into the name field. A
  gate coupled to another project's internal string goes silently to zero
  the day that string changes, and a gate that lies by omission is worse
  than an absent one. See DESIGN_NOTES 2026-08-16.
  """

  use Boundary, top_level?: true

  require Logger

  @typedoc "One row of `Ecto.Migrator.migrations/1`: status, version, name."
  @type status :: {:up | :down, non_neg_integer(), String.t()}

  @typedoc """
  One version claimed by more than one file. `applied` distinguishes the
  silent regime (true — neither file will ever run) from the loud one
  (false — the migrator would raise on the next run).
  """
  @type duplicate :: %{
          version: non_neg_integer(),
          files: [String.t()],
          applied: boolean()
        }

  @typedoc "What the passing arm OBSERVED, for an honest log line."
  @type summary :: %{applied: non_neg_integer(), pending: non_neg_integer()}

  @doc """
  The rule, over a merged `Ecto.Migrator.migrations/1` table.

  `{:ok, summary}` when no version is claimed twice, `{:error, duplicates}`
  otherwise — oldest version first, and each duplicate's files sorted, so
  the refusal reads the same regardless of the order Ecto handed the rows
  over (it reverses the applied ones).
  """
  @spec audit([status()]) :: {:ok, summary()} | {:error, [duplicate()]}
  def audit(statuses) when is_list(statuses) do
    case duplicates(statuses) do
      [] -> {:ok, summarise(statuses)}
      duplicates -> {:error, duplicates}
    end
  end

  @doc """
  Audit `repo`'s migration set, logging what it observed either way.

  Returns `:ok` or `{:error, duplicates}` for a caller that turns a refusal
  into a response rather than an exit.
  """
  @spec check(module()) :: :ok | {:error, [duplicate()]}
  def check(repo) when is_atom(repo) do
    case repo |> Ecto.Migrator.migrations() |> audit() do
      {:ok, summary} ->
        Logger.info(
          "migration audit: #{summary.applied} versions applied, #{summary.pending} pending, " <>
            "no version claimed by two files"
        )

        :ok

      {:error, duplicates} ->
        Logger.error("migration audit refused the migrate — #{describe(duplicates)}")
        {:error, duplicates}
    end
  end

  @doc """
  `check/1` for a caller whose refusal is a non-zero exit: raises naming the
  version, both files and the directory they sit in.
  """
  @spec check!(module()) :: :ok
  def check!(repo) when is_atom(repo) do
    case check(repo) do
      :ok ->
        :ok

      {:error, duplicates} ->
        raise "refusing to migrate — #{describe(duplicates)} " <>
                "(migrations directory: #{Ecto.Migrator.migrations_path(repo)})"
    end
  end

  @doc """
  The refusal in words: every duplicate names its version, ALL its files,
  and which of the two regimes it is in.
  """
  @spec describe([duplicate()]) :: String.t()
  def describe(duplicates) when is_list(duplicates) do
    Enum.map_join(duplicates, " ", &describe_one/1)
  end

  defp describe_one(%{version: version, files: files, applied: applied}) do
    "migration version #{version} is claimed by #{length(files)} files " <>
      "(#{Enum.join(files, ", ")})" <> regime(applied)
  end

  # The whole point of the distinction: one of these is fixed by fixing the
  # repo, the other is ALSO fixed by fixing the repo but looks like success
  # until someone goes looking for a table that was never created.
  defp regime(true) do
    ", and that version is already applied, so NEITHER file will ever run: " <>
      "both leave the pending set and the migrator reports success having run nothing"
  end

  defp regime(false) do
    ", and that version is not yet applied, so the migrator would raise on the next run"
  end

  defp duplicates(statuses) do
    statuses
    |> Enum.group_by(fn {_, version, _} -> version end)
    |> Enum.filter(fn {_, claims} -> length(claims) > 1 end)
    |> Enum.sort_by(fn {version, _} -> version end)
    |> Enum.map(&duplicate/1)
  end

  defp duplicate({version, claims}) do
    %{
      version: version,
      applied: Enum.any?(claims, &match?({:up, _, _}, &1)),
      files: claims |> Enum.map(&basename/1) |> Enum.sort()
    }
  end

  # `Ecto.Migrator.migrations/1` drops the path and keeps the name, so this
  # inverts the basename parse Ecto itself did (`extract_migration_info/1`
  # reads `Path.basename` and nothing else). The directory is named
  # separately, by `check!/1`.
  defp basename({_, version, name}), do: "#{version}_#{name}.exs"

  defp summarise(statuses) do
    %{
      applied: Enum.count(statuses, &match?({:up, _, _}, &1)),
      pending: Enum.count(statuses, &match?({:down, _, _}, &1))
    }
  end
end
