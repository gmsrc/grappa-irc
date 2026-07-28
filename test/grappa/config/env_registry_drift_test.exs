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
  duplicate): `app_vars/0` is parsed at test time from the two files that
  actually consume env vars — `config/runtime.exs` (`System.get_env` /
  `fetch_env!`) and `bin/start.sh` (`${VAR:=}` / `${VAR:?}` / `${VAR:-}`
  operator knobs). A hand-kept manifest would be a parallel list that
  drifts from the reads — the exact failure this pin exists to catch. No
  production module: nothing at runtime needs the list.

  Scope is deliberately the Docker contract (`compose.yaml` +
  `.env.example`) only — what the registry comment claims. The FreeBSD /
  Linux substrate templates are NOT pinned: they have per-substrate
  consumers a flat pin gets wrong (e.g. `GRAPPA_OUTBOUND_V6_POOL` is a
  FreeBSD-only NDP-keepalive input, not an app var), and a prod-required
  var missing there already crashes loud via runtime.exs `raise`.

  Two exemptions (the "20% domain boundary"): `@docker_orchestration`
  (UID/GID, publish ports, `MIX_ENV` — drive Docker, not the app; allowed
  as extras), and `@env_example_exempt` (`.env.example` omits
  `DATABASE_PATH` because compose COMPUTES it and an `environment:`
  literal shadows any `.env` value — documenting it would be a lie).
  """

  # async: true — pure file parsing, no global state.
  use ExUnit.Case, async: true

  @runtime_exs "config/runtime.exs"
  @start_sh "bin/start.sh"
  @compose "compose.yaml"
  @env_example ".env.example"

  # Docker-orchestration vars: read by compose.yaml / .env.example to
  # drive the container runtime, NOT by the app. Allowed as extras.
  # NGINX_PUBLISH is a DEPRECATED alias (#485 dropped the nginx container);
  # compose.yaml no longer reads it, but it stays a commented note in
  # .env.example for one release, so it must remain allowed here.
  @docker_orchestration MapSet.new([
                          "CONTAINER_UID",
                          "CONTAINER_GID",
                          "MIX_ENV",
                          "GRAPPA_PUBLISH",
                          "NGINX_PUBLISH"
                        ])

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

  # Operator-facing shell knobs: `${VAR:=default}` / `${VAR:?msg}` /
  # `${VAR:-default}`. Deliberately NOT plain `${VAR}` — that also matches
  # computed locals (GRAPPA_MAX_PORTS, GRAPPA_MAX_PROCS), derived not env.
  defp shell_env_reads do
    ~r/\$\{([A-Z][A-Z0-9_]*):[?=-]/
    |> Regex.scan(read!(@start_sh), capture: :all_but_first)
    |> List.flatten()
    |> MapSet.new()
  end

  defp app_vars, do: MapSet.union(runtime_env_reads(), shell_env_reads())

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

  # Keys of the grappa service's `environment:` block in compose.yaml.
  # Anchored to the `  grappa:` service (bounded by the next 2-space
  # service header) so a sibling service's environment: is never read;
  # within it the block ends at the next 4-space sibling key. Comment /
  # blank lines inside the block are skipped, not treated as the end.
  defp compose_grappa_env_keys do
    [_, after_grappa] = String.split(read!(@compose), ~r/^  grappa:\n/m, parts: 2)
    [grappa_svc | _] = String.split(after_grappa, ~r/^  [a-z]/m, parts: 2)
    [_, body] = String.split(grappa_svc, ~r/\n {4}environment:\n/, parts: 2)

    body
    |> String.split("\n")
    |> Enum.reduce_while([], fn line, acc ->
      cond do
        match = Regex.run(~r/^ {6}([A-Z][A-Z0-9_]*):/, line) ->
          [_, key] = match
          {:cont, [key | acc]}

        Regex.match?(~r/^ {6}#/, line) ->
          {:cont, acc}

        Regex.match?(~r/^\s*$/, line) ->
          {:cont, acc}

        # Any line indented <= 4 spaces ends the 6-space block.
        Regex.match?(~r/^ {0,4}\S/, line) ->
          {:halt, acc}

        true ->
          {:cont, acc}
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
      orphans =
        MapSet.difference(env_file_decls(@env_example), MapSet.union(app_vars(), @docker_orchestration))

      assert MapSet.size(orphans) == 0,
             ".env.example documents vars nothing consumes (dead knob?): #{inspect(sorted(orphans))}"
    end
  end
end
