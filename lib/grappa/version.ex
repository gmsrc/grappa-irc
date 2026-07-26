defmodule Grappa.Version do
  @moduledoc """
  Single source of truth for the running grappa version.

  ## Base version — from the release `.app` metadata

  `base/0` returns `Application.spec(:grappa, :vsn)` — the version OTP
  compiled into the application resource from `@version` in `mix.exs` at
  build time. It is the canonical "what version is running" and needs no
  filesystem access at runtime.

  It does **not** read `mix.exs` live (an earlier #391 design did, via
  `File.read!/1`). Two reasons that read was wrong:

    * **A release has no `mix.exs`.** A distro package (`.deb`/Arch —
      self-hosting Part 2, #419) ships a self-contained `mix release` with
      no project source beside the compiled BEAM. The old `File.read!/1`
      of the absent `mix.exs` did not degrade to `-dev` — it *raised*,
      crashing the `CTCP VERSION` reply. Reading a **build-time** file at
      **runtime** was the defect, not the symptom.
    * **The staleness it guarded against cannot occur.** The live read
      existed because `POST /admin/reload` (CP23) soft-purges + reloads
      `lib/*.ex` modules but never the `.app` resource, so
      `Application.spec/2` could report a stale version after a
      hot-deployed `@version` bump. But `@version` lives only in
      `mix.exs`, and `Grappa.Deploy.Preflight` classifies any `mix.exs`
      change as **COLD** (its `mix_deps?` clause) — a version bump therefore always
      restarts the node, which reloads `.app` fresh. No hot path changes
      `@version`, so the `.app` vsn is always current.

  So `base/0` is the `.app` vsn everywhere — dev, test, and prod — and
  there is no runtime build-file read left to break in a package.

  ## Suffix — git tag ≡ CTCP VERSION (#391)

  A source build that is HEAD on a **clean release tag matching the base
  version** is a *released* build and reports the bare `X.Y.Z`. A source
  build with git history that is untagged / mismatched / dirty is
  *unreleased* and reports `X.Y.Z-<shortsha>` (or `X.Y.Z-dev` when git left
  no sha) so an operator reading `CTCP VERSION` tells released-vs-unreleased
  at a glance, and a cut tag `vX.Y.Z` corresponds exactly to the reported
  `X.Y.Z`.

  The git state is a **build-time** snapshot (`@git_facts`), captured once
  at compile via the `git` binary — shelling out per reply would be absurd,
  and a running release has no live checkout anyway. `@external_resource`
  re-triggers compilation when `HEAD`/refs change so a dev *incremental*
  build stays honest; a cold deploy recompiles from scratch and
  re-snapshots regardless.

  When there was **no `.git` at build** — a package built from a release
  tarball (Arch) — `@git_facts` is `nil` and the reported version is the
  bare `base` (the package version = the cut tag): no git suffix is applied.
  This is *derive, don't inject* — the `.app` vsn IS the package metadata,
  already baked into the artifact, so nothing hand-set can drift out of sync
  with the build (the drift #391 exists to prevent).

  ## Boundary

  Standalone boundary so both the top-level `Grappa` namespace anchor AND
  `Grappa.Session.EventRouter` (CTCP VERSION reply composer) can call this
  without crossing a forbidden boundary edge — `Session` isn't allowed to
  dep on `Grappa` proper.
  """

  use Boundary, top_level?: true, deps: [], exports: []

  @app :grappa

  @typedoc """
  Build-time snapshot of the git state, folded into the reported version by
  `derive/2`. `nil` when there was no `.git` at build time (a package built
  from a release tarball) — `derive/2` then reports the bare `base`.

    * `:exact_tag` — the tag `HEAD` points at exactly (`git describe
      --tags --exact-match`), or `nil` when `HEAD` is not on a tag.
    * `:short_sha` — the abbreviated `HEAD` commit, or `nil` when the `git`
      binary was unavailable.
    * `:dirty?` — whether the working tree had uncommitted changes at build
      time.
  """
  @type git_facts :: %{
          exact_tag: String.t() | nil,
          short_sha: String.t() | nil,
          dirty?: boolean()
        }

  @repo_root Path.expand("../..", __DIR__)
  # `.git` is a directory in a normal checkout and a FILE in a `git
  # worktree` (it points at the shared gitdir), so probe presence with
  # `File.exists?/1`, not `File.dir?/1` — both are source builds that must
  # keep the #391 suffix. Absent entirely = a release tarball / package.
  @git_dir Path.join(@repo_root, ".git")

  # Re-run compilation when HEAD or the ref db changes so an incremental
  # dev build re-snapshots. Cold builds recompile from scratch regardless.
  for ref <- ["HEAD", "packed-refs"] do
    path = Path.join(@git_dir, ref)
    if File.exists?(path), do: @external_resource(path)
  end

  # `nil` when there is no `.git` at build (a release tarball / package) —
  # `derive/2` reports the bare base for that. Otherwise a build-time
  # snapshot of the git state.
  @git_facts (if File.exists?(@git_dir) do
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
              else
                nil
              end)

  @doc """
  Returns the honest running grappa version: bare `X.Y.Z` for a released
  build (or a package), `X.Y.Z-<shortsha>` / `X.Y.Z-dev` for an unreleased
  source build.
  """
  @spec current() :: String.t()
  def current, do: derive(base(), @git_facts)

  @doc """
  The canonical base version — `Application.spec(:grappa, :vsn)`, compiled
  from `@version` in `mix.exs` into the `.app` resource at build time. No
  runtime filesystem access.
  """
  @spec base() :: String.t()
  def base, do: @app |> Application.spec(:vsn) |> to_string()

  @doc """
  Folds the base version and a build-time git snapshot into the honest
  version string.

  `nil` git facts (no `.git` at build — a release tarball / package) → the
  bare `base`, the package version. Otherwise a build is *released* —
  reporting the bare `base` — only when `HEAD` is on a clean tag named
  exactly `v<base>`; every other state (untagged, tag mismatched with the
  base, or a dirty tree) is *unreleased* and gets a `-<shortsha>` suffix,
  degrading to `-dev` when git left no short sha behind.
  """
  @spec derive(String.t(), git_facts() | nil) :: String.t()
  def derive(base, nil), do: base

  def derive(base, %{exact_tag: exact_tag, short_sha: short_sha, dirty?: dirty?}) do
    cond do
      exact_tag == "v#{base}" and not dirty? -> base
      is_binary(short_sha) -> "#{base}-#{short_sha}"
      true -> "#{base}-dev"
    end
  end
end
