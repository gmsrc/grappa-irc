#!/usr/bin/env bash
# Run the bats-core test suite for host-side bash dispatchers (bin/*).
#
# Usage:
#   scripts/bats.sh                       # all tests: test/bin/ test/infra/ test/scripts/
#   scripts/bats.sh test/bin/grappa_test.bats
#
# Bats runs ON THE HOST (vendor/bats-core submodule, pinned to v1.9.0),
# against host-side scripts — no docker compose involvement.

# GRAPPA_CACHE_ID is dropped HERE, before _lib.sh reads it (#1522).
#
# The knob (#1263) binds `.caches/<id>` over `_build`, `deps` and
# `priv/plts` so two workers can run `mix` at once. This door runs no mix —
# but the Docker deploy scripts REFUSE to start while it is set (#1409:
# only `compose run` accepts `-v`, so the oneshots would use the per-id
# caches while `compose up` boots from the shared ones). So every bats case
# that drives a deploy door dies on that refusal when the caller's shell
# carries an id: eight cases across three files, failing with a message
# about deploying that has nothing to do with the code under test.
#
# #1409 cured the same leak per-file, in two files. Censused after the fact:
# TWENTY bats files drive a deploy door by name and eighteen carry no unset,
# so the class is "any bats case reaching a deploy door" and the cure belongs
# at the door, where a case written tomorrow inherits it. The
# two per-file `unset`s stay: they also cover a direct `vendor/bats-core/
# bin/bats` invocation, which never passes through here.
#
# Dropping a variable the caller set is stated out loud, not silently.
if [ -n "${GRAPPA_CACHE_ID:-}" ]; then
    printf 'scripts/bats.sh: ignoring GRAPPA_CACHE_ID=%s — bats runs no mix, and the deploy doors refuse while it is set (#1522).\n' "$GRAPPA_CACHE_ID" >&2
    unset GRAPPA_CACHE_ID
fi

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
