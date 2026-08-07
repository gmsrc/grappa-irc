#!/usr/bin/env python3
"""#124 mutation harness. Each entry: apply ONE exact replacement, run the
named test file, report the summary line, revert. A replacement that does not
apply exactly once aborts — a silently-missed injection would report a false
'test survived'."""
import subprocess, sys, re

MIG = "priv/repo/migrations/20260807120000_fold_nickserv_pass_onto_password.exs"
MIGT = "test/grappa/migrations/fold_nickserv_pass_onto_password_test.exs"
CRED = "lib/grappa/networks/credential.ex"
CREDT = "test/grappa/networks/credential_test.exs"
CTRL = "lib/grappa_web/controllers/networks_controller.ex"
CTRLT = "test/grappa_web/controllers/networks_controller_test.exs"
SRV = "lib/grappa/session/server.ex"
SRVT = "test/grappa/session/server_test.exs"

MUTANTS = [
    ("M1 promote-guard never matches (test's SQL copy)", MIGT,
     "AND auth_method = 'none'", "AND auth_method = 'no-such-method'", MIGT),
    ("M2 fold fills gaps instead of overwriting (test's SQL copy)", MIGT,
     "WHERE nickserv_pass_encrypted IS NOT NULL\n  \"\"\"",
     "WHERE nickserv_pass_encrypted IS NOT NULL\n     AND password_encrypted IS NULL\n  \"\"\"", MIGT),
    ("M3 migration file drifts from the test's copy", MIG,
     "SET password_encrypted = nickserv_pass_encrypted",
     "SET oper_pass_encrypted = nickserv_pass_encrypted", MIGT),
    ("M4 recover_secret reads the retired column again", CRED,
     "    if cred.auth_method == :nickserv_identify and secret_present?(upstream_password(cred)),\n      do: upstream_password(cred),\n      else: nil",
     "    if secret_present?(cred.nickserv_pass_encrypted),\n      do: cred.nickserv_pass_encrypted,\n      else: nil",
     CREDT),
    ("M5 stale nickserv_pass write is dropped silently instead of 410", CTRL,
     "    if Map.has_key?(params, \"nickserv_pass\"),\n      do: {:error, :nickserv_pass_retired},\n      else: :ok",
     "    _ = params\n    :ok", CTRLT),
    ("M6 any auth_method stages the password as a NickServ secret", SRV,
     "  defp pending_password_from_opts(%{auth_method: :nickserv_identify, password: pw})",
     "  defp pending_password_from_opts(%{password: pw})", SRVT),
]


def run(path):
    p = subprocess.run(["scripts/test.sh", path], capture_output=True, text=True)
    for line in p.stdout.splitlines():
        if re.search(r"\d+ tests?, \d+ failures?", line):
            return line.strip()
    return "NO SUMMARY (compile error?) rc=%d" % p.returncode


for name, path, old, new, testfile in MUTANTS:
    src = open(path).read()
    if src.count(old) != 1:
        print("ABORT %s: injector matched %d times in %s" % (name, src.count(old), path))
        sys.exit(1)
    open(path, "w").write(src.replace(old, new))
    try:
        print("%-62s -> %s" % (name, run(testfile)))
    finally:
        open(path, "w").write(src)
