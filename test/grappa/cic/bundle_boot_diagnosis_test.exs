defmodule Grappa.Cic.BundleBootDiagnosisTest do
  @moduledoc """
  #1161 — a `CIC_DIST_ROOT` that names the wrong directory must be said out
  loud at BOOT, not discovered on the first document request.

  The reported shape: the published release image bakes the SPA at
  `/app/cicchetto-dist` and sets `CIC_DIST_ROOT` to match, but compose's
  `environment:` wins over the image's `ENV` — so pointing the repo's
  development `compose.yaml` at that image redirects the root to a directory
  the image does not have. The container is healthy, the API answers, and only
  the frontend 404s with `cicchetto frontend bundle not built` — a message that
  reads like a missing build step on a path that has no build step. #526 was
  the same class through a different door (the FreeBSD jail's CWD, so the
  relative default resolved somewhere else).

  `boot/1` is the one place that sees the resolved root before anything asks
  for a file, so it is where the diagnosis belongs. Each arm below pins one
  fact of that message: WHERE it looked (expanded, because a relative root
  resolving against an unexpected CWD is half the bug class), WHAT it wanted
  there, WHICH knob moves it, and WHAT the operator will see if they ignore it.

  `async: false` — `boot/1` mutates the process-global `:persistent_term` root.
  """
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias Grappa.Cic.Bundle

  @moduletag :tmp_dir

  setup do
    original = Bundle.root()
    on_exit(fn -> Bundle.boot(original) end)
    :ok
  end

  test "a root that does not exist is named, with the knob and the symptom", %{tmp_dir: tmp} do
    missing = Path.join(tmp, "cicchetto-dist")

    log = capture_log(fn -> assert :ok = Bundle.boot(missing) end)

    assert log =~ missing
    assert log =~ "does not exist"
    assert log =~ "CIC_DIST_ROOT"
    assert log =~ "404"
  end

  test "a root that exists but holds no bundle names index.html", %{tmp_dir: tmp} do
    log = capture_log(fn -> assert :ok = Bundle.boot(tmp) end)

    assert log =~ tmp
    assert log =~ "index.html"
    # Distinct from the arm above: the directory IS there, so a diagnosis that
    # collapses both cases into "missing directory" sends the operator to fix
    # a path that is already correct.
    refute log =~ "does not exist"
  end

  test "a relative root is reported EXPANDED, against the CWD it will resolve to" do
    relative = "runtime/cicchetto-dist-1161-absent"

    log = capture_log(fn -> assert :ok = Bundle.boot(relative) end)

    # The #526 door: `runtime/cicchetto-dist` is only correct where the CWD is
    # the repo root. Echoing the configured value back tells the operator
    # nothing they did not already type; the resolved path is the finding.
    assert log =~ Path.expand(relative)
  end

  test "a root holding a bundle boots silently" do
    fixture = Path.expand("../../support/fixtures/cic_dist", __DIR__)

    log = capture_log(fn -> assert :ok = Bundle.boot(fixture) end)

    assert log == ""
  end
end
