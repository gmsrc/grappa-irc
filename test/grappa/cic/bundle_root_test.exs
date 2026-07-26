defmodule Grappa.Cic.BundleRootTest do
  @moduledoc """
  #399 — `Grappa.Cic.Bundle` is the single source of truth for WHERE the
  built cic bundle lives. `boot/1` stashes the root in `:persistent_term`
  (boot-time, CLAUDE.md-designated boundary) and `root/0` reads it
  lock-free; both the bundle-hash live-read and the endpoint's
  `Plug.Static` + SPA fallback resolve against this ONE root, so a
  packaged install can relocate the dist via `CIC_DIST_ROOT`.

  `async: false` — mutates the process-global `:persistent_term` root.
  """
  use ExUnit.Case, async: false

  alias Grappa.Cic.Bundle

  test "root/0 reflects the boot-injected value" do
    original = Bundle.root()
    on_exit(fn -> Bundle.boot(original) end)

    Bundle.boot("/srv/grappa/cicchetto-dist")
    assert Bundle.root() == "/srv/grappa/cicchetto-dist"
  end

  test "current_hash/0 reads index.html from the booted root" do
    original = Bundle.root()
    on_exit(fn -> Bundle.boot(original) end)

    # Point at the committed test fixture bundle, which carries a
    # Vite-shaped `<script src="/assets/index-TESTHASH.js">` tag.
    fixture = Path.expand("../../support/fixtures/cic_dist", __DIR__)
    Bundle.boot(fixture)

    assert Bundle.current_hash() == "TESTHASH"
    assert Bundle.current_version() == "9.9.9"
  end
end
