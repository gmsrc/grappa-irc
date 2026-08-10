defmodule Grappa.Cic.Bundle do
  @moduledoc """
  Single source of truth for the deployed cic bundle hash + version.

  Reads `runtime/cicchetto-dist/index.html` on every call and parses
  the Vite-emitted `<script src="/assets/index-<hash>.js">` tag. The
  hash changes every cic build, so a `compose --profile prod run --rm
  cicchetto-build` lands the next call's hash without server restart
  or hot-reload — same live-read pattern as `Grappa.Version` (CP23 S3
  memory `feedback_live_read_disk_for_hot_reload`).

  #292 adds `current_version/0`: the human-readable semver Vite bakes
  into the same `index.html` as a `<meta name="cicchetto-version">`
  tag (from `cicchetto/package.json`). The refresh banner shows
  "current X → available Y" — the *available* semver is read here, from
  the DEPLOYED dist (not the source `package.json`), so the server
  advertises what is actually served. The hash is still the trigger
  (a trivial rebuild reuses the semver); the version is display
  enrichment. When two builds share a semver (no bump), cic appends the
  short bundle hash so the "changed" signal never goes dead.

  Returns `nil` when the file is absent (dev without a cic build, test
  env, prod before the first cicchetto-build oneshot completes), and
  `current_version/0` also returns `nil` for a bundle built before the
  meta tag existed. The user-topic join push (B4) and refresh-banner
  broadcast (B5) treat a `nil` hash as "no bundle to compare against"
  and skip the push; a `nil` version rides the wire as an omitted key
  (cic falls back to the build-hash display).

  Standalone boundary so both `GrappaWeb.GrappaChannel` (after_join
  push) and `GrappaWeb.AdminController.cic_bundle_changed/2` (re-read
  + broadcast) can call this without crossing forbidden boundary
  edges.

  ## Single source of truth for WHERE the bundle lives (#399)

  `root/0` is the ONE resolver for the built-dist directory — read by
  the hash/version live-read here AND by the endpoint's `Plug.Static`
  + SPA history-fallback that self-serve the frontend (so a plain
  `bin/grappa start` works without nginx). The path is stashed in
  `:persistent_term` by `boot/1` at app start (CLAUDE.md
  "`Application.{put,get}_env`: boot-time only" — the designated
  boundary is `config/runtime.exs` → `Grappa.Application.start/2`),
  defaulting to the compile-time `runtime/cicchetto-dist` anchor when
  unset so dev/test and the pre-#399 deploy shape keep working. A
  packaged install (deb/rpm/Arch) relocates the dist by setting
  `CIC_DIST_ROOT`.

  ## The root is diagnosed at boot, not at the first request (#1161)

  Getting that path wrong is not a rare typo — it is the recurring
  failure of this design. #526: the FreeBSD jail sets no working
  directory, so the relative default resolved off the repo root.
  #1161: `compose.yaml` sets `CIC_DIST_ROOT` for the *development*
  stack, and compose's `environment:` overrides the image's `ENV`, so
  pointing that file at the published release image redirects the root
  away from the SPA the image bakes at `/app/cicchetto-dist`. Both
  times the server came up healthy and only the frontend 404'd, with a
  message that reads like a missing build step — sending the operator
  to look for a build that this path does not have.

  So `boot/1` warns, naming the RESOLVED path, what was missing there,
  the variable that moves it, and what the operator will see if they
  ignore it. **A root that does not resolve is never silently replaced
  by a fallback** (the release image's baked path, the compile-time
  anchor): that would make `CIC_DIST_ROOT` advisory, and a deliberate
  relocation with a typo would then serve a *different* bundle than the
  one asked for — a plausible wrong answer, which is worse than a 404.
  """

  use Boundary, top_level?: true, deps: [], exports: []

  require Logger

  # Compile-time default anchor — `lib/grappa/cic/` → repo root →
  # `runtime/cicchetto-dist`. Overridable at boot via `boot/1`
  # (`CIC_DIST_ROOT`). The bind-mount / in-place-release model keeps
  # the dist on disk; per-call `File.read/1` is fine — `index.html` is
  # small + page-cached, and the live-read is what lets a
  # `cicchetto-build` land the next hash without a server restart.
  @default_root Path.expand("../../../runtime/cicchetto-dist", __DIR__)
  @root_key {__MODULE__, :root}

  # Vite emits `<script type="module" crossorigin src="/assets/index-<hash>.js">`.
  # The hash is the chunk-content fingerprint; bumps on every build that
  # produces different bytes. `[^."]+` excludes the `.js` suffix and any
  # accidental quote.
  @hash_re ~r{<script[^>]+src="/assets/index-([^."]+)\.js"}

  # Vite injects `<meta name="cicchetto-version" content="<semver>">` via
  # the `transformIndexHtml` hook in `cicchetto/vite.config.ts` (attrs in
  # a deterministic `name`-then-`content` order). The semver is the
  # `cicchetto/package.json` version, baked at build. `[^"]+` captures the
  # content up to the closing quote.
  @version_re ~r{<meta[^>]+name="cicchetto-version"[^>]+content="([^"]+)"}

  # #1161 boot diagnosis. Split from the two messages that share them so the
  # symptom and the remedy read identically whichever way the root is wrong.
  @symptom "the SPA will 404 on every document request."
  @knob "Set CIC_DIST_ROOT to the directory holding the built SPA (the one with index.html)."

  @doc """
  Stash the built-dist root into `:persistent_term`. Called once from
  `Grappa.Application.start/2` with the boot-resolved path
  (`Application.get_env(:grappa, :cic_dist_root)`, which
  `config/runtime.exs` derives from `CIC_DIST_ROOT`). Idempotent;
  later calls overwrite.

  Warns when the resolved root holds no bundle — see the "#1161" section
  of the moduledoc. Never raises: a bundle-less boot is legitimate (dev
  before a cic build, prod before the first `cicchetto-build` oneshot),
  and the API half of the server is still worth serving.
  """
  @spec boot(Path.t()) :: :ok
  def boot(root) when is_binary(root) do
    :persistent_term.put(@root_key, root)
    warn_unless_bundled(Path.expand(root))
    :ok
  end

  # #1161: the root is resolved here and nowhere else asks about it until a
  # browser does, so this is the only chance to say WHERE we will look before
  # the first 404 says only that we did not find anything. `Path.expand/1`
  # first: a relative root is correct only where the CWD is what the operator
  # assumed, and the resolved path is the part they cannot infer (#526).
  defp warn_unless_bundled(root) do
    cond do
      not File.dir?(root) ->
        Logger.warning("cic bundle root does not exist: #{root} — #{@symptom} #{@knob}")

      not File.regular?(Path.join(root, "index.html")) ->
        Logger.warning("cic bundle root has no index.html: #{root} — #{@symptom} #{@knob}")

      true ->
        :ok
    end
  end

  @doc """
  The built-dist directory. Lock-free `:persistent_term` read;
  defaults to the compile-time `runtime/cicchetto-dist` anchor before
  `boot/1` runs (dev/test, or a mix task that never boots the app).
  """
  @spec root() :: Path.t()
  def root, do: :persistent_term.get(@root_key, @default_root)

  # index.html inside the resolved root — the hash/version live-read
  # target, resolved fresh each call so a `boot/1` relocation takes
  # effect without recompiling the compile-time anchor.
  defp bundle_path, do: Path.join(root(), "index.html")

  @doc """
  Returns the current cic bundle hash, or `nil` if the bundle is absent.
  """
  @spec current_hash() :: String.t() | nil
  def current_hash do
    case File.read(bundle_path()) do
      {:ok, html} -> parse_hash(html)
      {:error, _} -> nil
    end
  end

  @doc """
  Returns the current cic bundle semver (from the deployed dist's
  `<meta name="cicchetto-version">` tag), or `nil` if the bundle is
  absent or predates the meta tag.
  """
  @spec current_version() :: String.t() | nil
  def current_version do
    case File.read(bundle_path()) do
      {:ok, html} -> parse_version(html)
      {:error, _} -> nil
    end
  end

  @doc """
  Parses a Vite-emitted `index.html` string and returns the bundle hash.

  Exposed for unit tests + as the pure parsing core of `current_hash/0`.
  """
  @spec parse_hash(binary()) :: String.t() | nil
  def parse_hash(html) when is_binary(html) do
    case Regex.run(@hash_re, html, capture: :all_but_first) do
      [hash] when is_binary(hash) and hash != "" -> hash
      _ -> nil
    end
  end

  @doc """
  Parses a Vite-emitted `index.html` string and returns the bundle
  semver from the `<meta name="cicchetto-version">` tag.

  Exposed for unit tests + as the pure parsing core of `current_version/0`.
  """
  @spec parse_version(binary()) :: String.t() | nil
  def parse_version(html) when is_binary(html) do
    case Regex.run(@version_re, html, capture: :all_but_first) do
      [version] when is_binary(version) and version != "" -> version
      _ -> nil
    end
  end
end
