defmodule Grappa.Config.EnvRegistryDriftTest do
  @moduledoc """
  Drift pin for the runtime env-var registry (#369 X1).

  `config/runtime.exs` declares itself THE registry in a top-of-file
  comment: every env var it reads MUST be propagated by `compose.yaml`
  (so Docker forwards it) and documented in `.env.example` (so operators
  know). That contract was comment-only — nothing enforced it, and the
  2026-07-20 architecture review measured live drift. This pins exactly
  that contract; the modest win is catching a missing-forward in CI
  instead of at a prod boot.

  DERIVED, not manifested (CLAUDE.md design-rule 1 — derive, don't
  duplicate): the known-var set is parsed at test time from the THREE
  files that actually consume env vars — `config/runtime.exs`
  (`System.get_env` / `fetch_env!`) and `bin/start.sh` (`${VAR:=}` /
  `${VAR:?}` / `${VAR:-}` operator knobs), which together are `app_vars/0`,
  plus `compose.yaml` itself (`compose_orchestration_reads/0`), which
  consumes vars to orchestrate the containers rather than to run the app.
  A hand-kept manifest would be a parallel list that drifts from the
  reads — the exact failure this pin exists to catch. No production
  module: nothing at runtime needs the list.

  The third surface was hand-kept until #1027 and duly drifted the first
  time a service was added: two of three consuming files were derived and
  the third was a literal list, so five vars that compose demonstrably
  reads (`ports:`, `command:`, a sidecar's own `environment:`) failed the
  pin as "dead knobs". Deriving it is the repair; adding five names would
  have propagated the asymmetry.

  Orchestration vars are ALLOWED in `.env.example`, not REQUIRED there —
  only `app_vars/0` is required. So a compose-only knob may still go
  undocumented (`GRAPPA_VERSION`, `CIC_BUILD_OUT` are, today). Widening
  the requirement is a separate call, deliberately not made here.

  Scope is deliberately the Docker contract (`compose.yaml` +
  `.env.example`) only — what the registry comment claims. The FreeBSD /
  Linux substrate templates are NOT pinned: they have per-substrate
  consumers a flat pin gets wrong (e.g. `GRAPPA_OUTBOUND_V6_POOL` is a
  FreeBSD-only NDP-keepalive input, not an app var), and a prod-required
  var missing there already crashes loud via runtime.exs `raise`.

  Two exemptions (the "20% domain boundary"): `@docker_orchestration`
  (the residue no derivation can reach — see its own comment), and
  `@env_example_exempt` (`.env.example` omits `DATABASE_PATH` because
  compose COMPUTES it and an `environment:` literal shadows any `.env`
  value — documenting it would be a lie).
  """

  # async: true — pure file parsing, no global state.
  use ExUnit.Case, async: true

  @runtime_exs "config/runtime.exs"
  @start_sh "bin/start.sh"
  @compose "compose.yaml"
  @env_example ".env.example"

  # RESIDUE, not a manifest. Everything a derivation can reach is derived
  # (`app_vars/0`, `compose_orchestration_reads/0`); these two are the only
  # names left that no reader can see, and each is here for a stated
  # reason, not for convenience. Adding a third entry is almost certainly
  # wrong — check first whether the var has a reader the derivation should
  # be looking at instead. UID/GID and the publish ports USED to sit here
  # and no longer do: compose reads them, so compose is where they come
  # from now.
  #
  #   MIX_ENV        — read only INSIDE the grappa `environment:` block,
  #                    the one region the orchestration derivation must
  #                    subtract (see compose_orchestration_reads/0). It is
  #                    also the one non-app key that block forwards, so it
  #                    is what keeps the compose orphan pin honest.
  #   NGINX_PUBLISH  — a DEPRECATED alias (#485 dropped the nginx
  #                    container). NOTHING reads it any more; it survives
  #                    for one release as a commented note in
  #                    .env.example, so no derivation can justify it.
  @docker_orchestration MapSet.new(["MIX_ENV", "NGINX_PUBLISH"])

  # .env.example legitimately omits DATABASE_PATH — compose computes it.
  @env_example_exempt MapSet.new(["DATABASE_PATH"])

  # ── derivation (single source of truth) ────────────────────────────

  # Every env var runtime.exs reads. Covers `System.get_env("X")`,
  # `System.get_env("X", default)`, and `System.fetch_env!("X")` /
  # `fetch_env("X")` — the required-var idiom the moduledoc names.
  defp runtime_env_reads do
    ~r/System\.(?:get_env|fetch_env!?)\(\s*"([A-Z][A-Z0-9_]*)"/
    |> Regex.scan(read!(@runtime_exs), capture: :all_but_first)
    |> List.flatten()
    |> MapSet.new()
  end

  # An operator-facing knob: `${VAR:=default}` / `${VAR:?msg}` /
  # `${VAR:-default}`. Deliberately NOT plain `${VAR}` — in bin/start.sh
  # that also matches computed locals (GRAPPA_MAX_PORTS, GRAPPA_MAX_PROCS),
  # derived not env. One regex for both files, because compose interpolates
  # with the same shell syntax.
  #
  # Two known limits, both accepted, neither silent-safe to forget:
  #   - a knob written BARE (no default, no `:?`) is invisible here. Both
  #     files write the operator form everywhere today.
  #   - this is a text scan, not a parse: the operator form written inside
  #     a COMMENT counts as a read. compose.yaml has exactly one such
  #     ghost (`NOT ${VAR:-}`, prose in the grappa `environment:` block),
  #     and it is invisible today only because that block is subtracted
  #     below. A ghost written elsewhere would silently widen the allowed
  #     set — it can never hide a var, only excuse one.
  @knob ~r/\$\{([A-Z][A-Z0-9_]*):[?=-]/

  defp shell_env_reads do
    @knob
    |> Regex.scan(read!(@start_sh), capture: :all_but_first)
    |> List.flatten()
    |> MapSet.new()
  end

  defp app_vars, do: MapSet.union(runtime_env_reads(), shell_env_reads())

  # Vars compose.yaml consumes to orchestrate the CONTAINERS — publish
  # ports, uid/gid, bind-mount targets, the command line and `environment:`
  # of a sidecar service. Real consumption, just not by the Elixir app, so
  # `app_vars/0` will never contain them.
  #
  # The grappa service's own `environment:` block is SUBTRACTED, and that
  # subtraction is the whole reason this function is safe. Every key in
  # that block is written `KEY: ${KEY:-…}`, so a var there interpolates
  # ITSELF: fold it in and the orphan pins below would accept whatever
  # compose happens to forward, purely because compose forwards it. The
  # gate would still be green and would no longer be able to fail. The
  # block is the surface `compose_grappa_env_keys/0` polices against
  # `app_vars/0`; it must not double as evidence for its own defence.
  defp compose_orchestration_reads do
    compose = read!(@compose)

    @knob
    |> Regex.scan(String.replace(compose, compose_grappa_env_block(), ""),
      capture: :all_but_first
    )
    |> List.flatten()
    |> MapSet.new()
  end

  # ── declaration-file parsers ───────────────────────────────────────

  # Keys declared (incl. commented `# KEY=`) in a KEY=VALUE env file. A
  # commented optional var still counts as documented. Prose comments
  # (`# NOTE: FOO (bar)` — no `=`) never match.
  defp env_file_decls(path) do
    path
    |> read!()
    |> String.split("\n")
    |> Enum.flat_map(fn line ->
      case Regex.run(~r/^#?\s*([A-Z][A-Z0-9_]*)=/, line) do
        [_, key] -> [key]
        nil -> []
      end
    end)
    |> MapSet.new()
  end

  # The grappa service's `environment:` block, verbatim. Anchored to the
  # `  grappa:` service (bounded by the next 2-space service header) so a
  # sibling service's environment: is never read; the block itself ends at
  # the first line indented <= 4 spaces. Comment / blank lines inside are
  # not an end — neither is indented enough to match.
  #
  # Two readers, and they want opposite things from it: the key pin below
  # polices exactly this region, and compose_orchestration_reads/0 above
  # removes exactly this region. One extraction, so the two can never
  # disagree about where the block stops.
  defp compose_grappa_env_block do
    [_, after_grappa] = String.split(read!(@compose), ~r/^  grappa:\n/m, parts: 2)
    [grappa_svc | _] = String.split(after_grappa, ~r/^  [a-z]/m, parts: 2)
    [_, body] = String.split(grappa_svc, ~r/\n {4}environment:\n/, parts: 2)

    body
    |> String.split("\n")
    |> Enum.take_while(&(not Regex.match?(~r/^ {0,4}\S/, &1)))
    |> Enum.join("\n")
  end

  defp compose_grappa_env_keys do
    compose_grappa_env_block()
    |> String.split("\n")
    |> Enum.flat_map(fn line ->
      case Regex.run(~r/^ {6}([A-Z][A-Z0-9_]*):/, line) do
        [_, key] -> [key]
        nil -> []
      end
    end)
    |> MapSet.new()
  end

  defp read!(path), do: File.read!(Path.expand(path, File.cwd!()))

  defp sorted(set), do: set |> MapSet.to_list() |> Enum.sort()

  # ── sanity: derivation must not silently capture nothing ───────────

  describe "derivation self-check (guards against a vacuously-green pin)" do
    test "app_vars/0 captures a healthy set from real source" do
      # If a regex broke and captured nothing, every ⊆ assertion below
      # would pass vacuously. Floor the count well under the real ~19.
      assert MapSet.size(app_vars()) >= 15
    end

    test "runtime.exs reads include known boot vars" do
      reads = runtime_env_reads()

      for expected <- ~w(PHX_HOST SECRET_KEY_BASE DATABASE_PATH EXTRA_CHECK_ORIGINS LOG_LEVEL) do
        assert expected in reads, "expected runtime.exs to read #{expected}"
      end
    end

    test "shell reads capture the operator knobs but NOT computed locals" do
      reads = shell_env_reads()
      assert "GRAPPA_MAX_USERS" in reads
      assert "GRAPPA_DIRTY_SCHEDULERS" in reads
      assert "RELEASE_COOKIE" in reads
      # Arithmetic locals use `$(( ))` / plain `${VAR}` — never `:=`/`:?`/`:-`.
      refute "GRAPPA_MAX_PORTS" in reads
      refute "GRAPPA_MAX_PROCS" in reads
    end

    test "compose reads see the container knobs but NOT the app env it forwards" do
      reads = compose_orchestration_reads()

      # Outside the grappa `environment:` block: `user:`, `ports:`, and a
      # sidecar service's own environment: — all genuine orchestration.
      assert "CONTAINER_UID" in reads
      assert "GRAPPA_PUBLISH" in reads
      assert "SHOTTINO_IRCD_PASS" in reads

      # INSIDE it. These must not leak in, or the orphan pins below pass by
      # tautology: compose writes `SECRET_KEY_BASE: ${SECRET_KEY_BASE:-}`,
      # so a leak would let every forwarded key vouch for itself and the
      # gate could no longer fail. This refute IS the subtraction's witness.
      refute "SECRET_KEY_BASE" in reads
      refute "LOG_LEVEL" in reads
    end
  end

  # ── the pins (Docker contract only) ─────────────────────────────────

  describe "compose.yaml grappa environment: block" do
    test "propagates EVERY app-consumed var (else it degrades silently in Docker prod)" do
      missing = MapSet.difference(app_vars(), compose_grappa_env_keys())

      assert MapSet.size(missing) == 0,
             "compose.yaml grappa `environment:` is missing app-consumed vars " <>
               "(runtime.exs / bin/start.sh read them but Docker won't forward them): " <>
               "#{inspect(sorted(missing))}"
    end

    test "forwards NO orphan var (every key is app-consumed or Docker orchestration)" do
      orphans =
        MapSet.difference(compose_grappa_env_keys(), MapSet.union(app_vars(), @docker_orchestration))

      assert MapSet.size(orphans) == 0,
             "compose.yaml grappa `environment:` forwards vars nothing reads " <>
               "(add the reader or drop the key): #{inspect(sorted(orphans))}"
    end
  end

  describe ".env.example (Docker operator documentation)" do
    test "documents every operator-settable app var (DATABASE_PATH exempt — compose computes it)" do
      expected = MapSet.difference(app_vars(), @env_example_exempt)
      missing = MapSet.difference(expected, env_file_decls(@env_example))

      assert MapSet.size(missing) == 0,
             ".env.example is missing app vars operators must know about: #{inspect(sorted(missing))}"
    end

    test "declares NO var outside the app + Docker-orchestration surface" do
      consumed =
        app_vars()
        |> MapSet.union(compose_orchestration_reads())
        |> MapSet.union(@docker_orchestration)

      orphans = MapSet.difference(env_file_decls(@env_example), consumed)

      assert MapSet.size(orphans) == 0,
             ".env.example documents vars nothing consumes (dead knob?): #{inspect(sorted(orphans))}"
    end
  end
end
