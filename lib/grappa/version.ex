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
  at compile via the `git` binary (`Grappa.Version.GitProbe.facts/1`) —
  shelling out per reply would be absurd, and a running release has no live
  checkout anyway. `@external_resource` re-triggers compilation when the
  build's git ref moves so an incremental build re-snapshots and stays
  honest — but WHICH files to watch is the subtle part: a `git pull
  --ff-only` of an already-checked-out branch leaves `HEAD` and
  `packed-refs` untouched and rewrites only the LOOSE ref
  `refs/heads/<branch>`. Watching only `HEAD`/`packed-refs` (as this module
  once did) therefore let the sha go stale across every incremental deploy
  — and EVERY production deploy is incremental (`git pull → mix compile →
  mix release --overwrite`; the jail does NOT wipe `_build`, so the old
  "cold deploy recompiles from scratch" belief was false). The corrected
  watch set — the loose branch ref, plus `HEAD` and `packed-refs` — is
  resolved by `Grappa.Version.GitProbe.resource_paths/1` (#533 / #542).

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

  alias Grappa.Version.GitProbe

  @app :grappa

  @repo_root Path.expand("../..", __DIR__)

  # Re-run compilation whenever the build's git ref moves so an incremental
  # build re-snapshots the sha. The watch set is the corrected #533/#542 one
  # (the LOOSE branch ref a same-branch fast-forward rewrites, plus HEAD and
  # packed-refs) — see `GitProbe.resource_paths/1`. Registering each existing
  # path as an `@external_resource` is what dirties this module on the next
  # `mix compile`.
  for path <- GitProbe.resource_paths(@repo_root) do
    @external_resource path
  end

  # Build-time snapshot of the git state, or `nil` when there is no `.git` at
  # build (a release tarball / package) — `derive/2` reports the bare base.
  @git_facts GitProbe.facts(@repo_root)

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
  @spec derive(String.t(), GitProbe.git_facts() | nil) :: String.t()
  def derive(base, nil), do: base

  def derive(base, %{exact_tag: exact_tag, short_sha: short_sha, dirty?: dirty?}) do
    cond do
      exact_tag == "v#{base}" and not dirty? -> base
      is_binary(short_sha) -> "#{base}-#{short_sha}"
      true -> "#{base}-dev"
    end
  end

  @typedoc """
  The deploy-time build-sha guard verdict (#542):

    * `:ok` — a source build whose compiled sha equals the current `HEAD`;
    * `{:skip, :no_git}` — no `.git` at build (a package/tarball): the artifact
      honestly reports the bare `base`, there is no `HEAD` to compare, so the
      caller LOGS the observation and proceeds (the ONLY non-error outcome
      without a comparison, and a positively-identified package — not an
      anomalous fall-through);
    * `{:error, reason}` — refuse to ship (the release step raises), one of:
      * `{:stale, compiled, head}` — the compiled sha ≠ `HEAD`, the #542 drift:
        `Grappa.Version` was not recompiled, so the beam carries a previous
        build's sha;
      * `:sha_snapshot_degraded` — git WAS present at build but no sha was
        snapshotted (the build reports `-dev`), a trusted-but-unverifiable
        version;
      * `:head_unresolved` — a source build whose `HEAD` cannot be resolved at
        deploy time, so the match cannot be proven.
  """
  @type build_sha_verdict ::
          :ok
          | {:skip, :no_git}
          | {:error, {:stale, String.t(), String.t()} | :sha_snapshot_degraded | :head_unresolved}

  @doc """
  Deploy-time drift guard (#542): compares the git short-sha COMPILED into this
  module (`@git_facts.short_sha`) against the caller-supplied current `HEAD`
  short-sha, so a `mix release` step can REFUSE to assemble an artifact whose
  reported version has gone stale.

  `derive/2` (the runtime CTCP-VERSION path) degrades a broken snapshot to
  `-dev` so a running node never crashes its reply; this guard is the opposite
  posture — at build time it fails loudly rather than ship a version an operator
  would trust: *a version string that can be stale is worse than no version
  string, because it is trusted.* See `t:build_sha_verdict/0` for every outcome.
  """
  @spec verify_build_sha(String.t() | nil) :: build_sha_verdict()
  def verify_build_sha(head_sha), do: verify_build_sha(@git_facts, head_sha)

  @doc """
  Pure kernel of the #542 guard: folds the build-time git snapshot and the
  current `HEAD` short-sha into a verdict. Split from `verify_build_sha/1` (which
  reads `@git_facts`) so the full matrix is unit-testable with explicit inputs —
  the compile-time git state of the build itself is unstable.

  `nil` facts (no git at build) skips; a facts map with a `nil` `short_sha` (git
  present, snapshot failed) is the #542 failure itself and is an error, NOT a
  silent skip — the two `nil`-carrying states are deliberately kept distinct.
  """
  @spec verify_build_sha(GitProbe.git_facts() | nil, String.t() | nil) :: build_sha_verdict()
  def verify_build_sha(nil, _), do: {:skip, :no_git}
  def verify_build_sha(%{short_sha: nil}, _), do: {:error, :sha_snapshot_degraded}
  def verify_build_sha(%{short_sha: _}, nil), do: {:error, :head_unresolved}
  def verify_build_sha(%{short_sha: sha}, sha), do: :ok
  def verify_build_sha(%{short_sha: sha}, head_sha), do: {:error, {:stale, sha, head_sha}}
end
