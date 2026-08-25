#!/usr/bin/env bats
#
# Bats suite for the ONE Docker hook set (#1384, review D-S2).
#
# Two entry points drive the Docker source substrate: `scripts/deploy.sh`
# (operator, on a checkout, with the host's compose override) and
# `infra/docker/deploy.sh update` (standalone box, secrets + install/stop).
# Each used to carry its OWN 14 `substrate_*` functions, so the operator's
# outcome depended on which door they walked through, and a fix applied to
# one silently left the other wrong. #1377 is the worked example: it
# established the MIX_ENV floor on both PATHS of the operator door and could
# not reach the twin at all.
#
# These are the two divergences that carry a consequence rather than a
# spelling, asserted through the TWIN — the door #1377 could not reach. The
# operator door keeps its own suites (deploy_docker_test.bats,
# deploy_reload_verify_test.bats); this one exists to fail when the two
# doors stop agreeing.
#
# Harness mirrors deploy_docker_update_test.bats.

load ../bats_helpers

setup() {
    BATS_TEST_TMPDIR="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"
    REPO_SRC="$BATS_TEST_DIRNAME/../.."

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$BATS_TEST_TMPDIR/argv.log"
    : > "$ARGV_LOG"
    export ARGV_LOG
    # A second log carrying the MIX_ENV each compose invocation inherited,
    # kept out of ARGV_LOG so it cannot widen any ordering assertion — the
    # shape #1377 established for the operator door.
    ENV_LOG="$BATS_TEST_TMPDIR/env.log"
    : > "$ENV_LOG"
    export ENV_LOG
    export HOME="$BATS_TEST_TMPDIR/home"
    mkdir -p "$HOME"

    export GIT_CONFIG_GLOBAL="$BATS_TEST_TMPDIR/gitconfig"
    export GIT_AUTHOR_NAME=bats GIT_AUTHOR_EMAIL=bats@example.org
    export GIT_COMMITTER_NAME=bats GIT_COMMITTER_EMAIL=bats@example.org

    UPSTREAM="$BATS_TEST_TMPDIR/upstream"
    git init -q -b main "$UPSTREAM"
    mkdir -p "$UPSTREAM/infra/docker" "$UPSTREAM/infra/lib" "$UPSTREAM/infra/packaging" \
             "$UPSTREAM/runtime" "$UPSTREAM/lib"
    cp "$REPO_SRC/infra/docker/deploy.sh" "$UPSTREAM/infra/docker/deploy.sh"
    cp "$REPO_SRC/infra/lib/deploy_common.sh" "$UPSTREAM/infra/lib/deploy_common.sh"
    cp "$REPO_SRC/infra/lib/cic_dist.sh" "$UPSTREAM/infra/lib/cic_dist.sh"
    # The shared hook set. Copied when present so that before it exists this
    # suite is red for the RIGHT reason — the two doors disagree — rather
    # than for a missing file.
    if [ -f "$REPO_SRC/infra/lib/deploy_docker.sh" ]; then
        cp "$REPO_SRC/infra/lib/deploy_docker.sh" "$UPSTREAM/infra/lib/deploy_docker.sh"
    fi
    cp "$REPO_SRC/VERSION" "$UPSTREAM/VERSION"
    cp "$REPO_SRC/infra/packaging/version.sh" "$UPSTREAM/infra/packaging/version.sh"
    # #1773 — the cic launch derives GRAPPA_CREDITS from this one, under
    # `set -e`; a checkout without it is not a checkout the deploy can drive.
    cp "$REPO_SRC/infra/packaging/credits.sh" "$UPSTREAM/infra/packaging/credits.sh"
    chmod +x "$UPSTREAM/infra/docker/deploy.sh" "$UPSTREAM/infra/packaging/version.sh" \
        "$UPSTREAM/infra/packaging/credits.sh"
    cat > "$UPSTREAM/compose.yaml" <<'EOF'
services:
  grappa:
    container_name: grappa
EOF
    touch "$UPSTREAM/runtime/.gitkeep"
    echo base > "$UPSTREAM/lib/base.txt"
    git -C "$UPSTREAM" add -A
    git -C "$UPSTREAM" commit -qm "base"

    export REPO_ROOT="$BATS_TEST_TMPDIR/repo"
    git clone -q "$UPSTREAM" "$REPO_ROOT"

    # THE PRE-STATE. An installed box whose .env was written BY HAND rather
    # than by `install` — so it carries no MIX_ENV. `install` writes
    # `set_env MIX_ENV prod` into .env, which is the twin's own mechanism for
    # the same precondition the operator door solves by exporting; a box that
    # never ran `install` therefore has neither. compose then interpolates
    # `${MIX_ENV:-dev}` and every oneshot below opens grappa_dev.db.
    cat > "$REPO_ROOT/.env" <<'EOF'
PHX_HOST=staging.example.org
GRAPPA_PUBLISH=127.0.0.1:3100
EOF

    export PREFLIGHT_RC=0
    export RELOAD_FAILS=0
    export HOT_HEALTHCHECK_RETRIES=2 HOT_HEALTHCHECK_SLEEP=0
    export COLD_HEALTHCHECK_RETRIES=2 COLD_HEALTHCHECK_SLEEP=0
    export FAKE_OWNER_DIR="$REPO_ROOT"
    # An ambient MIX_ENV from the developer's shell would satisfy every arm
    # below without the script having established anything.
    unset MIX_ENV

    cat > "$FAKE_DIR/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$ARGV_LOG"
printf 'MIX_ENV=%s | docker %s\n' "${MIX_ENV-<unset>}" "$*" >> "$ENV_LOG"
if [ "$1" = inspect ]; then
    [ -n "${FAKE_OWNER_DIR:-}" ] || exit 1
    printf '%s\n' "$FAKE_OWNER_DIR"
    exit 0
fi
case "$*" in
    *"run --no-start"*) exit "$PREFLIGHT_RC" ;;
    *"run --rm cicchetto-build"*)
        cic_out="${CIC_BUILD_OUT:-./runtime/cicchetto-dist}"
        mkdir -p "$cic_out/assets"
        printf '<!doctype html>\n' > "$cic_out/index.html"
        ;;
    *"exec -T grappa curl"*reload*)
        if [ "$RELOAD_FAILS" = "1" ]; then
            printf '{"loaded":[],"failed":[{"module":"Foo","reason":"old_code_in_use"}]}'
        else
            printf '{"loaded":[],"failed":[]}'
        fi
        ;;
esac
exit 0
EOF
    chmod +x "$FAKE_DIR/docker"
    export PATH="$FAKE_DIR:$PATH"
}

commit_upstream() {
    echo "$RANDOM" > "$UPSTREAM/$1"
    git -C "$UPSTREAM" add -A
    git -C "$UPSTREAM" commit -qm "change $1"
}

run_update() {
    cd "$REPO_ROOT"
    run "$REPO_ROOT/infra/docker/deploy.sh" update "$@"
}

# The MIX_ENV recorded for the first invocation whose argv matches.
env_for() {
    grep -- "$1" "$ENV_LOG" | head -1 | sed 's/ | docker.*//'
}

@test "the standalone door establishes the environment floor too, not only the operator one" {
    refute grep -q MIX_ENV "$REPO_ROOT/.env"
    commit_upstream lib/base.txt

    run_update --force-hot
    [ "$status" -eq 0 ]

    # The hot path's one host-side oneshot that opens the database.
    grep -q 'seed_themes' "$ARGV_LOG"
    [ "$(env_for seed_themes)" = "MIX_ENV=prod" ]
}

@test "the standalone door's cold path establishes it as well" {
    refute grep -q MIX_ENV "$REPO_ROOT/.env"
    commit_upstream lib/base.txt

    run_update --force-cold
    [ "$status" -eq 0 ]

    [ "$(env_for 'mix grappa.migrate')" = "MIX_ENV=prod" ]
    [ "$(env_for seed_themes)" = "MIX_ENV=prod" ]
}

@test "both doors migrate through the audited task, not bare ecto.migrate" {
    # `grappa.migrate` carries the #1348 duplicate-version audit;
    # `ecto.migrate` cannot. A version claimed by two files and already
    # applied leaves the pending set empty, so the migrator reports success
    # having run neither file — for good. CLAUDE.md marks that regime 🔴,
    # and the operator door has been audited since #1348 while this one was
    # never moved with it.
    commit_upstream lib/base.txt

    run_update --force-cold
    [ "$status" -eq 0 ]

    grep -q 'mix grappa.migrate' "$ARGV_LOG"
    refute grep -q 'mix ecto.migrate' "$ARGV_LOG"
}

@test "an explicit MIX_ENV is still a floor, not an override" {
    commit_upstream lib/base.txt

    cd "$REPO_ROOT"
    MIX_ENV=staging run "$REPO_ROOT/infra/docker/deploy.sh" update --force-hot
    [ "$status" -eq 0 ]

    [ "$(env_for seed_themes)" = "MIX_ENV=staging" ]
}
