#!/usr/bin/env bash
# Run the bats-core test suite for host-side bash dispatchers (bin/*).
#
# Usage:
#   scripts/bats.sh                       # all tests: test/bin/ test/infra/ test/scripts/
#   scripts/bats.sh test/bin/grappa_test.bats
#
# Bats runs ON THE HOST (vendor/bats-core submodule, pinned to v1.9.0),
# against host-side scripts — no docker compose involvement.

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

cd "$SRC_ROOT"

bats_bin="$SRC_ROOT/vendor/bats-core/bin/bats"

if [ ! -x "$bats_bin" ]; then
    # Self-heal a fresh clone / worktree: vendor/bats-core is a per-worktree
    # working tree and is not checked out by default.
    # `-c protocol.file.allow=always` is REQUIRED, not cosmetic (#592).
    # Why: docs/TESTING.md § "What each script actually runs".
    printf 'scripts/bats.sh: vendor/bats-core missing — initialising submodule...\n' >&2
    git -C "$SRC_ROOT" -c protocol.file.allow=always submodule update --init vendor/bats-core >&2 \
        || die "vendor/bats-core init failed. Run: git -C \"$SRC_ROOT\" -c protocol.file.allow=always submodule update --init vendor/bats-core"
fi

if [ ! -x "$bats_bin" ]; then
    die "vendor/bats-core/bin/bats still not executable after submodule init."
fi

if [ $# -eq 0 ]; then
    set -- test/bin/ test/infra/ test/scripts/
fi

exec "$bats_bin" "$@"
