defmodule Grappa.AdminOverview.Wire do
  @moduledoc """
  Wire shape for the admin top bar's projection (#1075 / #1073).

  Exists so the payload has ONE declared shape that both ends read from.
  `mix grappa.gen_wire_types` globs `**/*wire.ex` and mirrors the typespecs
  below into `cicchetto/src/lib/wireTypes.ts`, and `scripts/check.sh` runs
  that task with `--check` — so a field added here without regenerating
  fails the build, and cic cannot drift into a hand-written copy of this
  map. That drift gate is the whole reason this module is not just a
  `@type` sitting on `Grappa.AdminOverview`.

  ## `loadavg` is nullable ON PURPOSE

  `float() | nil`, and the `nil` is load-bearing rather than defensive:
  `:cpu_sup` may be unreachable (os_mon absent from the release, the port
  program missing for the platform), and "cannot measure" is a different
  fact from "the box is idle". Collapsing it to `0.0` anywhere along this
  wire — here, in the JSON, or in the client's formatter — renders a calm
  bar for a machine nobody can see. The generated TS type carries the
  `| null` so a client that forgets has to be told by its own compiler.

  ## `visitors` is a PAIR, `sessions` is not

  Not an oversight and not asymmetry for its own sake. `visitors` carries
  DB `total` alongside live `live` because the Visitors tab carries that
  same duality (`live_state: null` is its U-0 honesty signal), and the two
  are allowed to disagree — the disagreement is the diagnostic. `sessions`
  has no DB twin to report: the Sessions tab is registry-driven by
  construction ("one row = one live pid") and routes the DB-intent signal
  to `/admin/visitors` and `/admin/credentials` instead. See
  `Grappa.AdminOverview`'s moduledoc for the pair that was drafted, and
  withdrawn, before this shape settled.
  """

  @typedoc """
  Visitor counts: `total` is DB rows, `live` is DISTINCT visitors holding
  at least one registered `Session.Server`. Neither is computed from the
  other.
  """
  @type visitors :: %{
          total: non_neg_integer(),
          live: non_neg_integer()
        }

  @typedoc """
  The admin-bar payload, served by `GET /admin/overview` and pushed as
  `"overview"` on the admin channel — the same map through both doors.

  `hostname` is the node's own host. `loadavg` is the 1-minute average and
  is the HOST's, not grappa's: a jail shares the host kernel (measured in
  production, 2026-08-09), so a client MUST label it or an operator reads
  it as "grappa is busy". `nil` means the sampler was unreachable.
  """
  @type t :: %{
          sessions: non_neg_integer(),
          visitors: visitors(),
          hostname: String.t(),
          loadavg: float() | nil,
          version: String.t()
        }
end
