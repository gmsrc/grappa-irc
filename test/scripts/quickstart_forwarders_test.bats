#!/usr/bin/env bats
#
# Bats suite for the quickstart shims (#503 unit B). quickstart.sh,
# quickstart-update.sh and quickstart-stop.sh were absorbed into one
# verb-dispatched consumer (infra/docker/deploy.sh); the three scripts are
# kept for one release as THIN forwarders so existing muscle memory + docs
# keep working. Their full behaviour is characterised against the consumer
# in test/infra/deploy_docker_verbs_test.bats (install + stop) and
# test/infra/deploy_docker_update_test.bats (update); this suite only
# asserts each shim execs the right verb, verbatim — args AND environment.

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."
    BOX="$BATS_TEST_TMPDIR/box"
    mkdir -p "$BOX/scripts" "$BOX/infra/docker"

    cp "$REPO_SRC/scripts/quickstart.sh" \
       "$REPO_SRC/scripts/quickstart-update.sh" \
       "$REPO_SRC/scripts/quickstart-stop.sh" "$BOX/scripts/"

    export FWD_LOG="$BATS_TEST_TMPDIR/fwd.log"
    : > "$FWD_LOG"

    # Stub the consumer the shims forward to: record the verb + flags and a
    # sentinel env var, so both the argv and the exec'd environment can be
    # asserted. Written last on the PATH-independent absolute path the shims
    # resolve ($REPO_ROOT/infra/docker/deploy.sh).
    cat > "$BOX/infra/docker/deploy.sh" <<'EOF'
#!/usr/bin/env bash
{ printf 'deploy.sh'; for a in "$@"; do printf ' %s' "$a"; done; printf '\n'
  printf 'SEED_USER=%s\n' "${SEED_USER:-}"; } > "$FWD_LOG"
EOF
    chmod +x "$BOX/infra/docker/deploy.sh"
}

@test "quickstart.sh forwards to the install verb, preserving the environment" {
    SEED_USER=tester "$BOX/scripts/quickstart.sh"
    grep -qx 'deploy.sh install' "$FWD_LOG"
    grep -qx 'SEED_USER=tester' "$FWD_LOG"
}

@test "quickstart-update.sh forwards to the update verb, passing flags through" {
    "$BOX/scripts/quickstart-update.sh" --no-pull
    grep -qx 'deploy.sh update --no-pull' "$FWD_LOG"
}

@test "quickstart-stop.sh forwards to the stop verb, passing flags through" {
    "$BOX/scripts/quickstart-stop.sh" --volumes
    grep -qx 'deploy.sh stop --volumes' "$FWD_LOG"
}

@test "the shims forward with no extra args when none are given" {
    "$BOX/scripts/quickstart-stop.sh"
    grep -qx 'deploy.sh stop' "$FWD_LOG"
}
