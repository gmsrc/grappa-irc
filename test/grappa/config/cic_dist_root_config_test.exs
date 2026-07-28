defmodule Grappa.Config.CicDistRootConfigTest do
  @moduledoc """
  #485 regression pin: `config/runtime.exs` must derive `:cic_dist_root`
  from `CIC_DIST_ROOT` under `MIX_ENV=dev` (the env the e2e harness runs),
  not only `:prod`.

  #399 first read `CIC_DIST_ROOT` inside the `config_env() == :prod`
  block, because prod was then the ONLY substrate whose BEAM self-served
  the SPA (everywhere else nginx served the dist statically). #485 made
  every surviving nginx a DUMB proxy, so grappa-test in the e2e harness —
  which runs `MIX_ENV=dev` — became an SPA server too. But the prod gate
  left `:cic_dist_root` UNSET under `:dev`, so `Grappa.Cic.Bundle.root/0`
  fell back to its CWD default (`runtime/cicchetto-dist`, empty in the
  container — the dist is mounted at `CIC_DIST_ROOT=/app/cicchetto-dist`),
  the endpoint served an empty dist, and EVERY browser e2e spec timed out
  on an unserved SPA.

  Unit tests missed it because `spa_serving_test`/`bundle_root_test` point
  `Grappa.Cic.Bundle` at a fixture directly, bypassing `runtime.exs`. This
  pins the derivation at the config layer so the gap can't silently return
  without an e2e run to catch it — the same broadening precedent as
  `extra_origins` + `:http_host_aliases`.

  `async: false` — mutates the process-global OS env via `System.put_env`.
  """
  use ExUnit.Case, async: false

  @runtime_exs Path.expand("../../../config/runtime.exs", __DIR__)

  # Read `config/runtime.exs` exactly as boot would, but under an
  # arbitrary Mix env, and pull back the derived `:cic_dist_root`.
  # `:prod` is intentionally NOT exercised here: reading it raises on the
  # (correctly) prod-gated DATABASE_PATH/SECRET_KEY_BASE/... — and prod was
  # never the broken env. The regression lived in `:dev`, which the e2e
  # harness runs under.
  defp cic_dist_root(env) do
    @runtime_exs
    |> Config.Reader.read!(env: env)
    |> get_in([:grappa, :cic_dist_root])
  end

  test "CIC_DIST_ROOT is honored under MIX_ENV=dev (#485 — e2e self-serve)" do
    System.put_env("CIC_DIST_ROOT", "/app/cicchetto-dist")
    on_exit(fn -> System.delete_env("CIC_DIST_ROOT") end)

    assert cic_dist_root(:dev) == "/app/cicchetto-dist"
  end

  test "unset CIC_DIST_ROOT falls back to the CWD default under MIX_ENV=dev" do
    System.delete_env("CIC_DIST_ROOT")

    assert cic_dist_root(:dev) == "runtime/cicchetto-dist"
  end

  test "MIX_ENV=test is left to config/test.exs — runtime.exs must NOT set it" do
    # config/test.exs pins :cic_dist_root at the committed fixture bundle,
    # and runtime config runs LAST; if runtime.exs set it under :test it
    # would clobber the fixture and SpaServingTest would serve an empty
    # dist. So even WITH CIC_DIST_ROOT present, runtime.exs derives nothing
    # under :test.
    System.put_env("CIC_DIST_ROOT", "/app/cicchetto-dist")
    on_exit(fn -> System.delete_env("CIC_DIST_ROOT") end)

    assert cic_dist_root(:test) == nil
  end
end
