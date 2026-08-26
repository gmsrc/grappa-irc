defmodule Grappa.Version do
  @moduledoc """
  Single source of truth for the running grappa version.

  ## Base version — the compiled `VERSION`-file constant (#652)

  `base/0` returns `@base_version`, a module attribute baked at **compile**
  time from the repo-root `VERSION` file (`File.read!/1` inside the build
  tree, registered as an `@external_resource` so an edit forces a
  recompile). It is the canonical "what version is running" and needs no
  filesystem access at runtime.

  It deliberately does **not** return `Application.spec(:grappa, :vsn)`.
  That reads the `.app` resource, which the running node loads ONCE at boot
  and never re-reads. The jail hot path is `git pull → mix compile →
  mix release --overwrite → POST /admin/reload`; `/admin/reload`
  (`Grappa.HotReload.reload_modified/0`) reloads only the `.beam` files
  whose on-disk md5 changed — it never re-reads `.app`. So after a
  **hot-deployed** version bump, `Application.spec/2` would keep reporting
  the boot-time value while the operator expects the new one. Sourcing
  `base/0` from a compiled constant instead keeps the number inside the
  artifact, with no runtime filesystem access and no way to drift from the
  string `mix.exs` stamps (#652). What it does NOT buy is the payoff #652
  claimed — the new number arriving on a hot reload — because a `VERSION`
  bump is itself a cold deploy; see "The declared price" below.
  This is also NOT the #391 defect: that was a **runtime** read of
  a **build** file (`mix.exs`), which a package lacks — it *raised* and
  crashed the `CTCP VERSION` reply. Here the read is at compile time,
  inside the build tree where `VERSION` always exists (source checkout OR
  release tarball), and the artifact carries a plain string — no runtime
  filesystem access, so no fallback to design and no packaging failure.

  ## The declared price (#652), and what it turned out to be

  #652 declared the price as a divergence: after a **hot** bump the running
  node's `.app` vsn would stay at its boot value while `base/0` reported the
  new number, reconverging at the next cold restart. `Grappa.Version` is the
  ONLY `Application.spec(:grappa, …)` consumer in the tree, so nothing else
  would observe it.

  Measured on m42 on 2026-08-10, the real price is a different one: that
  divergence never opens, because **a bump that changes only `VERSION` is a
  COLD deploy**, not the HOT one #652 expected. `mix.exs` reads the same file
  to stamp the OTP application vsn, so under `mix release` the bump moves the
  artifact to `lib/grappa-<new>/ebin` while the running node still resolves
  `:code.lib_dir(:grappa)` — the directory `Grappa.HotReload.reload_modified/0`
  walks — to its boot directory `lib/grappa-<old>/ebin`. Nothing in there
  changed, so `/admin/reload` answers `{"failed":[],"reloaded":[]}`: neither
  the `.app` vsn NOR `base/0` moves, and the node serves the old number with
  the new code already on disk until it is restarted. (In a source checkout
  `:code.lib_dir/1` is the unversioned `_build/<env>/lib/grappa`, which is why
  development never showed this.)

  `Grappa.Deploy.Preflight` still classifies such a bump HOT. That
  misclassification is a behaviour defect with an issue of its own; what is
  corrected here is only the claim this moduledoc made about it.

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
  resolved by `Grappa.Version.GitProbe.resource_paths/1` (#533 / #542) —
  and registered UNCONDITIONALLY, because naming the loose ref only when
  git happens to be storing it loosely at compile time re-opened the very
  same staleness the moment a `git gc` packed it (#1797).

  When there was **no `.git` at build** — a package built from a release
  tarball (Arch) — `@git_facts` is `nil` and the reported version is the
  bare `base` (the package version = the cut tag): no git suffix is applied.
  This is *derive, don't inject* — `base` is the compiled `VERSION`-file
  constant (#652), the same string `mix.exs` reads to stamp the package
  metadata, so nothing hand-set can drift out of sync with the build (the
  drift #391 exists to prevent).

  ## Boundary

  Standalone boundary so both the top-level `Grappa` namespace anchor AND
  `Grappa.Session.EventRouter` (CTCP VERSION reply composer) can call this
  without crossing a forbidden boundary edge — `Session` isn't allowed to
  dep on `Grappa` proper.
  """

  use Boundary, top_level?: true, deps: [], exports: []

  alias Grappa.Version.GitProbe

  @repo_root Path.expand("../..", __DIR__)

  # #652 — the base version is the repo-root `VERSION` file, read at COMPILE
  # time and baked into a module attribute. Registered as an
  # `@external_resource` so a bump dirties this module and `mix compile` on the
  # deploy path recompiles it. That much still holds; what #652 claimed next —
  # that `reload_modified/0` then picks the new beam up by md5 and the reported
  # version updates WITHOUT a cold restart — does not, because in a release the
  # recompiled beam lands under `lib/grappa-<new>/ebin` and the running node
  # never looks there (moduledoc, "The declared price"). The read is
  # compile-time, inside the build tree where `VERSION` always exists, so —
  # unlike the #391 runtime `mix.exs` read — a package build cannot raise.
  @version_path Path.join(@repo_root, "VERSION")
  @external_resource @version_path
  @base_version @version_path |> File.read!() |> String.trim()

  # Re-run compilation whenever the build's git ref moves so an incremental
  # build re-snapshots the sha. The watch set is the corrected #533/#542 one
  # (the LOOSE branch ref a same-branch fast-forward rewrites, plus HEAD and
  # packed-refs) — see `GitProbe.resource_paths/1`. Registering each path as
  # an `@external_resource` is what dirties this module on the next
  # `mix compile`, and each is registered whether or not it exists TODAY:
  # git packs and unpacks refs behind us, so a set filtered by existence
  # goes blind to the very fast-forward it was written to catch (#1797).
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
  The canonical base version — the repo-root `VERSION` file, read at compile
  time and baked into `@base_version` (#652). NOT `Application.spec(:grappa,
  :vsn)`: the `.app` resource is read once at boot and never re-read, and the
  constant needs no runtime filesystem access while being the same string
  `mix.exs` stamps. It does not, however, make a bump land on a hot deploy —
  a `VERSION`-only bump is COLD (moduledoc, "The declared price").
  """
  @spec base() :: String.t()
  def base, do: @base_version

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
