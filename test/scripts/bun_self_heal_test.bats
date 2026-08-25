#!/usr/bin/env bats
#
# Bats suite for scripts/bun.sh — the node_modules self-heal (#1311).
#
# WHY THIS EXISTS
#
# The e2e stack mounts a named volume at /work/node_modules INSIDE the
# `.:/work` bind of cicchetto/e2e (cicchetto/e2e/compose.yaml), and docker
# materialises that mount point on the host. Every worktree that has run the
# testnet therefore owns an EMPTY cicchetto/e2e/node_modules — and a guard
# spelled `[ ! -d ]` reads an empty directory as "installed". The first
# `bun run check` then dies with `TS2688 Cannot find type definition file for
# '@playwright/test'`, which reads like a type error in the branch under test
# rather than an absent toolchain.
#
# "Does the directory exist" is not "are the dependencies there". These cases
# pin the second question, on BOTH guards, in both directions.
#
# Scope: asserts WHICH bun invocations reach the container for a given
# on-disk state. `docker` is stubbed on PATH, so no container starts and no
# real install runs — this pins the GUARD, not the install.

load ../bats_helpers

setup() {
    REAL_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"

    # A throwaway tree shaped like a checkout, so _lib.sh can resolve
    # SRC_ROOT (dirname of the script, since $PWD is not a worktree root) and
    # REPO_ROOT (git --git-common-dir, hence the init). PHYSICAL path: on
    # macOS $TMPDIR is a symlink, and _lib.sh compares SRC_ROOT to a
    # git-resolved REPO_ROOT.
    FIXTURE="$(cd "$BATS_TEST_TMPDIR" && pwd -P)/fixture"
    mkdir -p "$FIXTURE/scripts" "$FIXTURE/infra/packaging" "$FIXTURE/cicchetto/e2e"
    git -C "$FIXTURE" init -q

    cp "$REAL_ROOT/scripts/_lib.sh" "$FIXTURE/scripts/_lib.sh"
    cp "$REAL_ROOT/scripts/bun.sh" "$FIXTURE/scripts/bun.sh"
    cp "$REAL_ROOT/infra/packaging/version.sh" "$FIXTURE/infra/packaging/version.sh"
    # #1773 — bun.sh derives GRAPPA_CREDITS here too, before any verb runs.
    cp "$REAL_ROOT/infra/packaging/credits.sh" "$FIXTURE/infra/packaging/credits.sh"
    chmod +x "$FIXTURE/scripts/bun.sh" "$FIXTURE/infra/packaging/version.sh" \
        "$FIXTURE/infra/packaging/credits.sh"
    # bun.sh derives GRAPPA_VERSION through version.sh, which reads this.
    printf '9.9.9\n' > "$FIXTURE/VERSION"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$FAKE_DIR/argv.log"
    : > "$ARGV_LOG"

    cat > "$FAKE_DIR/docker" <<EOF
#!/usr/bin/env bash
printf 'docker' >> "$ARGV_LOG"
for a in "\$@"; do printf ' %s' "\$a" >> "$ARGV_LOG"; done
printf '\n' >> "$ARGV_LOG"
exit 0
EOF
    chmod +x "$FAKE_DIR/docker"
    export PATH="$FAKE_DIR:$PATH"

    # MANDATORY, not tidiness: _lib.sh reads $PWD first and only falls back to
    # the script's own directory when $PWD is not a checkout root. bats runs
    # from the real worktree, which IS one — so without this the fixture is
    # ignored and every case silently measures the developer's own
    # cicchetto/.
    cd "$FIXTURE"
}

# A node_modules directory with dependencies actually installed in it.
populate() {
    mkdir -p "$1/typescript"
    touch "$1/typescript/package.json"
}

# The mount point docker leaves behind: the directory exists, and holds
# nothing.
materialise_empty() {
    mkdir -p "$1"
}

@test "the fixture, not the real checkout, is the subject under test" {
    populate "$FIXTURE/cicchetto/node_modules"
    populate "$FIXTURE/cicchetto/e2e/node_modules"

    run "$FIXTURE/scripts/bun.sh" run check
    [ "$status" -eq 0 ]

    grep -q -- "-v $FIXTURE/cicchetto:/app " "$ARGV_LOG"
    refute grep -q -- "-v $REAL_ROOT/cicchetto:/app " "$ARGV_LOG"
}

@test "empty cicchetto/e2e/node_modules still installs the e2e toolchain" {
    populate "$FIXTURE/cicchetto/node_modules"
    materialise_empty "$FIXTURE/cicchetto/e2e/node_modules"

    run "$FIXTURE/scripts/bun.sh" run check
    [ "$status" -eq 0 ]

    grep -q ' bun install --cwd e2e$' "$ARGV_LOG"
    refute grep -q ' bun install$' "$ARGV_LOG"
}

@test "empty cicchetto/node_modules still installs the cic toolchain" {
    materialise_empty "$FIXTURE/cicchetto/node_modules"
    populate "$FIXTURE/cicchetto/e2e/node_modules"

    run "$FIXTURE/scripts/bun.sh" run check
    [ "$status" -eq 0 ]

    grep -q ' bun install$' "$ARGV_LOG"
    refute grep -q ' bun install --cwd e2e$' "$ARGV_LOG"
}

@test "absent node_modules install both toolchains" {
    run "$FIXTURE/scripts/bun.sh" run check
    [ "$status" -eq 0 ]

    grep -q ' bun install$' "$ARGV_LOG"
    grep -q ' bun install --cwd e2e$' "$ARGV_LOG"
}

@test "populated node_modules install nothing and run the asked-for verb" {
    populate "$FIXTURE/cicchetto/node_modules"
    populate "$FIXTURE/cicchetto/e2e/node_modules"

    run "$FIXTURE/scripts/bun.sh" run check
    [ "$status" -eq 0 ]

    # The real invocation is the witness that the run happened at all — the
    # two refutes below hold vacuously against an empty log.
    grep -q ' bun run check$' "$ARGV_LOG"
    refute grep -q ' bun install$' "$ARGV_LOG"
    refute grep -q ' bun install --cwd e2e$' "$ARGV_LOG"
}

@test "install-family verbs skip the self-heal even with empty node_modules" {
    materialise_empty "$FIXTURE/cicchetto/node_modules"
    materialise_empty "$FIXTURE/cicchetto/e2e/node_modules"

    run "$FIXTURE/scripts/bun.sh" install
    [ "$status" -eq 0 ]

    # Exactly one docker invocation: the operator's own `bun install`.
    [ "$(wc -l < "$ARGV_LOG")" -eq 1 ]
}
