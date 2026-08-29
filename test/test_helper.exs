# Concurrency is controlled by `config :ex_unit, max_cases: 1` in
# `config/test.exs` (CP25 shared-singleton fix). DO NOT add `max_cases:`
# here — `ExUnit.start/1` opts override `config :ex_unit` silently.
#
# 2026-05-13: discovered that the CP25 fix shipped INERT for ~12 hours
# because this line carried `max_cases: 2` which silently overrode the
# config value of 1. ALL ci.yml runs since 25761866724 (the lone
# accidental green) had been red on the bootstrap_test:413 shared-
# singleton class. Per memory `feedback_exunit_start_overrides_config`.
#
# Original sqlite-busy rationale (preserved for context): with
# `async: true` tests checking out concurrent Sandbox owners +
# write-heavy setups (Argon2 hashing in Accounts tests, 505-row inserts
# in Scrollback tests), the default `max_cases: System.schedulers_online()`
# overruns the `busy_timeout` window with cascading "Database busy"
# errors. The `max_cases: 1` config solves both the singleton class AND
# the sqlite-busy class with one knob.
ExUnit.start(capture_log: true)
Ecto.Adapters.SQL.Sandbox.mode(Grappa.Repo, :manual)

# #594 — the cross-process BusyRetry fault table, created ONCE here so it is
# owned by the long-lived ExUnit runner process and survives every test. A
# `:public :named_table` keyed by target pid; `arm_faults/3` writes it,
# `maybe_inject_fault/0` reads it by `self()`. Creating it lazily in the first
# test that arms would race `:ets.new` across async tests — hence here.
Grappa.Repo.BusyRetry.ensure_fault_table()
Mox.defmock(Grappa.Admission.CaptchaMock, for: Grappa.Admission.Captcha)
Mox.defmock(Grappa.Net.ImageFetcherMock, for: Grappa.Net.ImageFetcher)
# #543 INC-5 — source-alias platform adapter + the hardened command seam.
# `SourceAliasMock` stands in for a FreeBSD/Linux/Disabled adapter in the
# ref-count manager tests; `HardenedCmdMock` stands in for the shell-out so
# the FreeBSD/Linux adapters' argv + exit-mapping are asserted without a real
# `sudo ifconfig` / `sysctl` / `ip route`.
Mox.defmock(Grappa.Net.SourceAliasMock, for: Grappa.Net.SourceAlias)
Mox.defmock(Grappa.Sys.HardenedCmdMock, for: Grappa.Sys.HardenedCmd)
