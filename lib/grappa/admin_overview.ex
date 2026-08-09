defmodule Grappa.AdminOverview do
  @moduledoc """
  Scalar projection behind the admin top bar (#1075, companion to the cic
  half in #1073): session count, visitor counts, hostname, loadavg and the
  running version.

  ## Why this is a projection and not a count of the tab lists

  The obvious shape — have the bar fetch `GET /admin/sessions` and
  `GET /admin/visitors` and count the rows — is the wrong one. Both list
  surfaces are *enriched* per row: `LiveIntrospection.list_sessions/0`
  issues a `GenServer.call` PER live pid (joined channels + peer address,
  each with a 250ms degradation budget) and
  `Visitors.list_all_with_live_state/0` does one registry lookup plus one
  such call per credential. On a push cadence that is `O(N × 250ms)` of
  session-mailbox traffic to produce two integers.

  The 20% that does not fit the existing infrastructure is exactly this:
  the tabs want enriched ROWS, the bar wants SCALARS. So this module
  counts with one `Registry.select/2` (no pid is ever messaged) plus one
  `Repo.aggregate/3`, and shares the *sources* with the tabs rather than
  their payloads — the bar and the Sessions tab enumerate the same
  `Grappa.SessionRegistry`, so they cannot disagree about which pids exist.

  ## The DB/live pair sits where the domain has one — and only there

  CLAUDE.md: DB state and live state are separate sources of truth, and an
  admin listing must carry both. That rule is applied here per-resource,
  not cosmetically across the whole payload:

    * `visitors` carries `{total, live}` because the Visitors tab carries
      the same duality (a DB row whose `Session.Server` is missing renders
      `live_state: null` — the U-0 honesty signal). `total` is DB rows,
      `live` is distinct visitor ids holding at least one pid. Neither is
      computed from the other; they are ALLOWED to disagree, and the
      disagreement is the diagnostic.

    * `sessions` is live-only, deliberately. The Sessions tab is
      registry-driven by construction — "one row = one live pid" — and its
      own moduledoc routes the DB-intent signal to `/admin/visitors` and
      `/admin/credentials` rather than carrying it. There is no DB twin to
      report: the nearest candidate,
      `Credentials.list_credentials_for_all_users/0`, is scoped
      `user_id IS NOT NULL` (visitor sessions are spawned from
      `Visitors.list_active/0` instead), so pairing it against a pid count
      that spans BOTH subject kinds would produce a systematically
      lopsided pair that means nothing. A fabricated pair is worse than an
      honest single number.

  ## Loadavg is sampled, and it is the HOST's

  `:cpu_sup.avg1/0` (os_mon) rather than `/proc/loadavg`: production is a
  FreeBSD jail, which has no `/proc`. cpu_sup shells out to a per-OS port
  program, which is the reason to pay for the dependency.

  **The 256 divisor is measured, not folklore.** `avg1/0` returns the load
  as a fixed-point integer scaled by 256, and that scaling was checked
  inside the production jail against `sysctl vm.loadavg` on the same box at
  the same moment (vjt, 2026-08-09): `avg1=135` against a reported `0.45`
  (135/256 = 0.53), and `avg5=165` against `0.62` (165/256 = 0.64). The 1
  minute figure drifts because the two reads are not simultaneous; the 5
  minute one lands on the nose, which is what identifies the scale.

  **`:os_mon` is not in the release without `extra_applications`.** The
  same probe found os_mon absent from `_build/prod/rel/grappa/lib` in both
  prod and the dryrun — it exists only in the jail's system Erlang, so a
  release-run node answers `undef` on `cpu_sup:avg1`. Adding it to
  `extra_applications` in `mix.exs` is what puts it in the artifact, and
  that makes this feature a **COLD deploy** — see
  `Grappa.Deploy.Preflight`, which trips on `mix.exs` (`mix_deps`),
  `lib/grappa/application.ex` (`application`, the `boot/0` call site) and
  `config/config.exs` (`config`). Three independent reasons; none of them
  is hot-reloadable.

  `config/config.exs` keeps `memsup`/`disksup` off, and that is a
  necessity rather than tidiness: with os_mon started whole, that jail
  raises `{set,{system_memory_high_watermark,[]}}` immediately.

  A jail shares the host kernel, so the number is the **host's** load, not
  grappa's — confirmed by the same probe, `sysctl vm.loadavg` reading
  identically inside the jail and on the host. Clients must label it
  accordingly or an operator will read it as "grappa is busy".

  An unavailable sampler yields `nil`, never `0.0` — "we cannot measure"
  and "the box is idle" are different facts, and only one of them should
  render as a calm bar.

  ## Cadence

  Counts change because something happened; loadavg does not — it is a
  sampled quantity with no event to hang off. Rather than run two
  mechanisms, `GrappaWeb.AdminChannel` ticks the whole payload on
  `push_interval_ms/0` for as long as an admin console is open. The tick
  lives in the channel process, not in a supervised singleton: it exists
  only while someone is looking, and it dies with the socket.

  `push_interval_ms/0` re-reads `:persistent_term` per tick, so a
  hot-deployed interval change takes effect on the next one. A 1s sample
  of a 1-minute average is noise; the default is deliberately coarse.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.LiveIntrospection, Grappa.Version, Grappa.Visitors],
    exports: []

  alias Grappa.{LiveIntrospection, Version, Visitors}

  @typedoc """
  The admin-bar payload. `loadavg` is `nil` when the sampler is
  unavailable — the honesty signal, distinct from a measured `0.0`.
  """
  @type t :: %{
          sessions: non_neg_integer(),
          visitors: %{total: non_neg_integer(), live: non_neg_integer()},
          hostname: String.t(),
          loadavg: float() | nil,
          version: String.t()
        }

  @key {__MODULE__, :push_interval_ms}
  @default_push_interval_ms 5_000

  @doc """
  Reads the push cadence from `Application.get_env/3` once and stores it in
  `:persistent_term`. Called from `Grappa.Application.start/2` — the
  CLAUDE.md-designated boot boundary for a non-process DI seam (mirrors
  `Grappa.Admission.Config.boot/0`).
  """
  @spec boot() :: :ok
  def boot do
    interval =
      :grappa
      |> Application.get_env(:admin_overview, [])
      |> Keyword.get(:push_interval_ms, @default_push_interval_ms)

    :persistent_term.put(@key, validate_interval!(interval))
    :ok
  end

  @doc """
  Milliseconds between admin-bar pushes. Lock-free `:persistent_term` read.

  Carries the compiled default so a node that hot-reloads this module
  before `boot/0` has ever run still ticks at a sane cadence instead of
  raising in a channel callback.
  """
  @spec push_interval_ms() :: pos_integer()
  def push_interval_ms, do: :persistent_term.get(@key, @default_push_interval_ms)

  @doc """
  The current admin-bar payload. One registry scan + one `COUNT` + two
  cheap machine reads; messages no session pid.
  """
  @spec snapshot() :: t()
  def snapshot do
    live = LiveIntrospection.count_live()

    %{
      sessions: live.sessions,
      visitors: %{total: Visitors.count_all(), live: live.visitors},
      hostname: hostname(),
      loadavg: derive_loadavg(sample_avg1()),
      version: Version.current()
    }
  end

  @doc """
  Pure fold of `:cpu_sup.avg1/0`'s reply into the wire value.

  cpu_sup reports a fixed-point integer scaled by 256; anything else the
  sampler can hand back (an `{:error, _}` tuple, `:undefined`, the
  `:unavailable` marker this module substitutes when os_mon is absent) is
  "unknown", which is `nil`. Split out from the sampling so the whole
  matrix is unit-testable without an os_mon in the loop.
  """
  @spec derive_loadavg(term()) :: float() | nil
  def derive_loadavg(avg1) when is_integer(avg1) and avg1 >= 0,
    do: Float.round(avg1 / 256, 2)

  def derive_loadavg(_), do: nil

  if Mix.env() == :test do
    @doc false
    @spec put_test_push_interval_ms(pos_integer()) :: :ok
    def put_test_push_interval_ms(ms) when is_integer(ms) and ms > 0,
      do: :persistent_term.put(@key, ms)
  end

  # Narrow on purpose. `UndefinedFunctionError` is os_mon not being in the
  # release at all; the `:exit` is `:cpu_sup` not being started (its
  # supervisor disabled, or the port program missing for this OS). Both are
  # "no sampler", which this reports as `nil` — a VISIBLE degradation on the
  # wire, not a swallowed failure. Any other exception is a real bug and is
  # left to crash.
  defp sample_avg1 do
    :cpu_sup.avg1()
  rescue
    UndefinedFunctionError -> :unavailable
  catch
    :exit, _ -> :unavailable
  end

  defp hostname do
    {:ok, name} = :inet.gethostname()
    to_string(name)
  end

  defp validate_interval!(ms) when is_integer(ms) and ms > 0, do: ms

  defp validate_interval!(other) do
    raise ArgumentError,
          "config :grappa, :admin_overview, push_interval_ms must be a positive " <>
            "integer, got: #{inspect(other)}"
  end
end
