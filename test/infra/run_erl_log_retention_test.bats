#!/usr/bin/env bats
#
# Bats suite for #1656 — the FreeBSD jail's run_erl log ring must outlive an
# incident.
#
# run_erl(1) keeps the node's stdout/stderr in a CIRCULAR set of
# `RUN_ERL_LOG_GENERATIONS` files of `RUN_ERL_LOG_MAXSIZE` bytes each, and the
# stock ring is 5 x 100 KB = 500 KB. On this substrate that ring is the ONLY
# history the BEAM leaves behind: there is no journald, no docker logs.
#
# MEASURED on the jail 2026-08-22: the four surviving `erlang.log.*` spanned
# 22:52 -> 00:32 — one hundred minutes, with the generation in between already
# overwritten. Two separate incidents lost their evidence to that ring in a
# single night (#1656, #1657) and both were filed cause-unknown as a result.
#
# The variable NAMES are not folklore: they were read out of the shipped
# run_erl binary (`strings .../erts-16.4.0.5/bin/run_erl | grep ^RUN_ERL`),
# which lists RUN_ERL_LOG_GENERATIONS and RUN_ERL_LOG_MAXSIZE among others.
#
# Every assertion here is about the CEILING the ring buys, never about the
# literal numbers — an operator is free to tune them in /etc/rc.conf.d/grappa,
# and a future edit is free to pick different ones, as long as the ring still
# survives the night that #1656 did not.

load ../bats_helpers

REPO_SRC="$BATS_TEST_DIRNAME/../.."
RCD="$REPO_SRC/infra/freebsd/rc.d/grappa"

# run_erl(1)'s own defaults — the bar the pin has to clear to mean anything.
STOCK_GENERATIONS=5
STOCK_MAXSIZE=100000

# ~240 KB/h, from the measurement in the header (400 KB over 100 minutes).
MEASURED_BYTES_PER_HOUR=245760

# Echo the rc.conf-overridable default assigned to $1, e.g.
#   : ${grappa_log_generations:="20"}   ->   20
rcd_default() {
    sed -n "s/^: \${$1:=\"\([0-9]*\)\"}.*/\1/p" "$RCD"
}


# Shipped service definitions (same SET as service_locale_pin_test.bats) that
# INVOKE the `daemon` subcommand. Comment lines are stripped first: three of
# these files discuss `daemon(8)` or run_erl in prose, and prose is not a spawn.
daemon_spawning_definitions() {
    local rel
    git -C "$REPO_SRC" ls-files -- infra | while IFS= read -r rel; do
        case "$rel" in
            *.service | */rc.d/*) ;;
            *) continue ;;
        esac
        grep -v '^[[:space:]]*#' "$REPO_SRC/$rel" | grep -q 'daemon' || continue
        printf '%s\n' "$rel"
    done
}

@test "the rc.d exports both run_erl retention variables into the release" {
    grep -q 'export RUN_ERL_LOG_GENERATIONS=' "$RCD"
    grep -q 'export RUN_ERL_LOG_MAXSIZE=' "$RCD"
}

@test "both retention variables are rc.conf-overridable, not hardcoded" {
    # The rc.subr idiom is what lets an operator retune a jail without
    # patching a tracked file. A literal baked into the `su` line would be a
    # pin nobody on the box can move.
    [ -n "$(rcd_default grappa_log_generations)" ]
    [ -n "$(rcd_default grappa_log_maxsize)" ]
    grep -q 'export RUN_ERL_LOG_GENERATIONS=.\${grappa_log_generations}' "$RCD"
    grep -q 'export RUN_ERL_LOG_MAXSIZE=.\${grappa_log_maxsize}' "$RCD"
}

@test "the ring is bigger than the stock one on BOTH axes" {
    # Either axis left at stock silently halves (or worse) the retention the
    # other one buys, and the product assertion below would still pass on a
    # 1-generation ring of one enormous file — which loses the OLDEST evidence
    # first, the opposite of what an incident needs.
    [ "$(rcd_default grappa_log_generations)" -gt "$STOCK_GENERATIONS" ]
    [ "$(rcd_default grappa_log_maxsize)" -gt "$STOCK_MAXSIZE" ]
}

@test "the ring holds at least 24h of logs at the measured rate" {
    # The property that matters, stated as the incident states it: an operator
    # who reads the log the morning after must still find the night in it. The
    # stock 500 KB ring buys about two hours and is what lost #1656 and #1657.
    total=$(( $(rcd_default grappa_log_generations) * $(rcd_default grappa_log_maxsize) ))
    [ "$total" -ge $(( MEASURED_BYTES_PER_HOUR * 24 )) ]
}

@test "the jail rc.d is the only shipped service definition that spawns run_erl" {
    # systemd and both container images run `bin/grappa start` in the
    # FOREGROUND, so their logs go to journald / docker and no run_erl ring
    # exists to size. A future substrate that adopts `daemon` inherits the
    # 500 KB ring silently — this is the case that will notice.
    run daemon_spawning_definitions
    [ "$status" -eq 0 ]
    [ "$output" = "infra/freebsd/rc.d/grappa" ]
}
