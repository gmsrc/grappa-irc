#!/usr/bin/env bats
#
# #1066 — SVC_AKILL_CLONES must carry a value the directive it actually
# reaches will accept.
#
# cicchetto/e2e/compose.yaml sets SVC_AKILL_CLONES; the azzurra-testnet
# submodule's services/conf.tmpl decides which services.conf directive
# that value lands in. Today it lands in `CLONES`, which is a BOOLEAN
# (conf.c:786 — strtol, then fatal unless the result is 0 or 1), not in
# `CLONEKILL`, the numeric clone-akill threshold the variable is named
# after (conf.c:940 — 0, or 5..50). The submodule's own entrypoint.sh
# documents "Valid values: 0 (off) or 5..50", which is the OTHER
# directive's range: measured on this stack, 5, 20 and 50 all die with
#
#     FATAL ERROR: Value 5 for CLONES is not valid
#
# before services finishes parsing its config, and the whole integration
# stack goes with it as an opaque cascade.
#
# So this pairing — the value here, the directive over there — is the
# thing worth guarding, and neither half can guard it alone. Reading the
# directive out of the template rather than hardcoding it means the
# guard keeps working, without an edit, if the submodule is ever fixed
# to write CLONEKILL: the accepted set simply becomes the numeric one.
#
# An unrecognised directive is a FAILURE, not a pass: a third name means
# somebody moved the variable to a knob whose validator nobody here has
# read, which is exactly how #1066 happened in the first place.

load ../bats_helpers

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
    TMPL="$REPO_ROOT/cicchetto/e2e/infra/services/conf.tmpl"
    COMPOSE="$REPO_ROOT/cicchetto/e2e/compose.yaml"

    # A fresh worktree has the submodule empty. Init it the same way
    # scripts/testnet.sh and scripts/bats.sh already do (#592): the clone
    # comes from the superproject's local module store over file://, which
    # the CVE-2022-39253 mitigation blocks without the flag. Offline,
    # idempotent, a no-op once present. CI checks it out ahead of us.
    if [ ! -f "$TMPL" ]; then
        git -C "$REPO_ROOT" -c protocol.file.allow=always \
            submodule update --init cicchetto/e2e/infra >&2 || true
    fi
    [ -f "$TMPL" ]
    [ -f "$COMPOSE" ]
}

# Every services.conf directive the template feeds ${SVC_AKILL_CLONES} to.
tmpl_directives() {
    sed -n 's/^\([A-Z_]\{1,\}\):\${SVC_AKILL_CLONES}[[:space:]]*$/\1/p' "$TMPL"
}

# Every value cicchetto/e2e/compose.yaml sets for SVC_AKILL_CLONES.
compose_values() {
    sed -n 's/^[[:space:]]*SVC_AKILL_CLONES:[[:space:]]*"\{0,1\}\([0-9]\{1,\}\)"\{0,1\}[[:space:]]*$/\1/p' \
        "$COMPOSE"
}

@test "the testnet template feeds SVC_AKILL_CLONES into exactly one directive" {
    run tmpl_directives
    [ "$status" -eq 0 ]
    [ "$(printf '%s\n' "$output" | grep -c .)" -eq 1 ]
}

@test "the e2e compose sets SVC_AKILL_CLONES exactly once" {
    run compose_values
    [ "$status" -eq 0 ]
    [ "$(printf '%s\n' "$output" | grep -c .)" -eq 1 ]
}

@test "the value the e2e sets is one the directive it reaches accepts" {
    local directive value
    directive="$(tmpl_directives)"
    value="$(compose_values)"

    case "$directive" in
        # conf.c:786 — CONF_SET_CLONE, the clone-detection master switch.
        CLONES)
            [ "$value" = "0" ] || [ "$value" = "1" ]
            ;;
        # conf.c:940 — CONF_AKILL_CLONES, the autokill threshold.
        CLONEKILL)
            [ "$value" = "0" ] || { [ "$value" -ge 5 ] && [ "$value" -le 50 ]; }
            ;;
        *)
            printf 'SVC_AKILL_CLONES now feeds the %s directive; read its\n' "$directive" >&2
            printf 'validator in azzurra/services src/conf.c and teach this guard.\n' >&2
            return 1
            ;;
    esac
}
