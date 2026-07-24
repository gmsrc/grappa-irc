defmodule Grappa.Version do
  @moduledoc """
  Single source of truth for the running grappa version.

  ## Base version — live from `mix.exs`

  The `X.Y.Z` base is read from `@version` in `mix.exs` on every call so
  a version bump lands on the next read without a full `mix compile`.
  The cluster `code-reload` hot-reload path (CP23) re-evaluates `lib/*.ex`
  but never `mix.exs` — `Application.spec(:grappa, :vsn)` reads from the
  pre-load `.app` resource, which stays at the cold-deploy version across
  `POST /admin/reload` cycles. Reading the file directly bypasses that
  staleness while keeping the `@version` attribute as the canonical
  declaration site.

  ## Suffix — git tag ≡ CTCP VERSION (#391)

  A build that is HEAD on a **clean release tag matching the mix version**
  is a *released* build and reports the bare `X.Y.Z`. Anything else is
  *unreleased* and reports a `X.Y.Z-<shortsha>` suffix (or `X.Y.Z-dev`
  when git state is unavailable) so an operator reading `CTCP VERSION`
  tells released-vs-unreleased at a glance, and a cut tag `vX.Y.Z`
  corresponds exactly to the reported `X.Y.Z`.

  The git state is a **build-time** snapshot (`@git_facts`), captured once
  at compile via the `git` binary:

    * the running release has no live git checkout in the FreeBSD jail, so
      querying git per reply is impossible there anyway;
    * shelling out on every `CTCP VERSION` reply would be absurd.

  `@external_resource` re-triggers compilation when `HEAD`/refs change so a
  dev *incremental* build stays honest; a cold deploy recompiles from
  scratch and re-snapshots regardless. When the `git` binary or the `.git`
  directory is absent at build time, the snapshot degrades to
  `%{exact_tag: nil, short_sha: nil, dirty?: false}` and the version falls
  back to the `-dev` suffix.

  ## Boundary

  Standalone boundary so both the top-level `Grappa` namespace anchor AND
  `Grappa.Session.EventRouter` (CTCP VERSION reply composer) can call this
  without crossing a forbidden boundary edge — `Session` isn't allowed to
  dep on `Grappa` proper.
  """

  use Boundary, top_level?: true, deps: [], exports: []

  @typedoc """
  Build-time snapshot of the git state, folded into the reported version
  by `derive/2`.

    * `:exact_tag` — the tag `HEAD` points at exactly (`git describe
      --tags --exact-match`), or `nil` when `HEAD` is not on a tag.
    * `:short_sha` — the abbreviated `HEAD` commit, or `nil` when git is
      unavailable.
    * `:dirty?` — whether the working tree had uncommitted changes at
      build time.
  """
  @type git_facts :: %{
          exact_tag: String.t() | nil,
          short_sha: String.t() | nil,
          dirty?: boolean()
        }

  # Anchored at compile time on this file's directory so `mix.exs` is found
  # regardless of `File.cwd!/0` at call time. The bind-mount model
  # (`./:/app`) keeps `mix.exs` on disk; the `File.read!/1` happens per call
  # but `mix.exs` is small and page-cached.
  @mix_exs_path Path.expand("../../mix.exs", __DIR__)
  @version_re ~r/@version\s+"([^"]+)"/

  @repo_root Path.expand("../..", __DIR__)
  @git_dir Path.join(@repo_root, ".git")

  # Re-run compilation when HEAD or the ref db changes so an incremental
  # dev build re-snapshots. Cold builds recompile from scratch regardless.
  for ref <- ["HEAD", "packed-refs"] do
    path = Path.join(@git_dir, ref)
    if File.exists?(path), do: @external_resource(path)
  end

  @git_facts (
               run = fn args ->
                 try do
                   # env: [] — git introspection needs none of grappa's
                   # secrets (SECRET_KEY_BASE, CLOAK_KEY, …); a cleared env
                   # keeps them out of the subprocess (Credo UnsafeExec) and
                   # git's plain describe/rev-parse/status don't need HOME.
                   case System.cmd("git", args, cd: @repo_root, env: [], stderr_to_stdout: true) do
                     {out, 0} -> String.trim(out)
                     {_, _} -> nil
                   end
                 rescue
                   _ -> nil
                 catch
                   _, _ -> nil
                 end
               end

               tag = run.(["describe", "--tags", "--exact-match"])
               sha = run.(["rev-parse", "--short", "HEAD"])
               status = run.(["status", "--porcelain"])

               %{
                 exact_tag: if(tag in [nil, ""], do: nil, else: tag),
                 short_sha: if(sha in [nil, ""], do: nil, else: sha),
                 dirty?: is_binary(status) and status != ""
               }
             )

  @doc """
  Returns the honest running grappa version: bare `X.Y.Z` for a released
  build, `X.Y.Z-<shortsha>` / `X.Y.Z-dev` for an unreleased one.
  """
  @spec current() :: String.t()
  def current, do: derive(base(), @git_facts)

  @doc """
  Returns the canonical base version, read live from `@version` in
  `mix.exs`.
  """
  @spec base() :: String.t()
  def base do
    @mix_exs_path
    |> File.read!()
    |> then(&Regex.run(@version_re, &1))
    |> List.last()
  end

  @doc """
  Folds the base version and a build-time git snapshot into the honest
  version string.

  A build is *released* — reporting the bare `base` — only when `HEAD` is
  on a clean tag named exactly `v<base>`. Every other state (untagged,
  tag mismatched with the mix version, or a dirty working tree) is
  *unreleased* and gets a `-<shortsha>` suffix, degrading to `-dev` when
  git left no short sha behind.
  """
  @spec derive(String.t(), git_facts()) :: String.t()
  def derive(base, %{exact_tag: exact_tag, short_sha: short_sha, dirty?: dirty?}) do
    cond do
      exact_tag == "v#{base}" and not dirty? -> base
      is_binary(short_sha) -> "#{base}-#{short_sha}"
      true -> "#{base}-dev"
    end
  end
end
