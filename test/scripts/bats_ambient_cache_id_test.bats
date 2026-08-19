#!/usr/bin/env bats
#
# #1522 — scripts/bats.sh must not hand an ambient GRAPPA_CACHE_ID to the
# bats process.
#
# GRAPPA_CACHE_ID (#1263) is a MIX cache knob: it binds `.caches/<id>` over
# `_build`, `deps` and `priv/plts` so two workers can compile at once. The
# bats door runs no mix at all — but scripts/_lib.sh reads the knob, and the
# Docker deploy doors REFUSE to run while it is set (#1409: only `compose
# run` accepts `-v`, so the oneshots would use the per-id caches while
# `compose up` boots from the shared ones). So every bats case that drives a
# deploy door dies on that refusal when the worker's shell carries an id —
# eight cases across three files, with a message about deploying that has
# nothing to do with the code under review. #1522 read that red as a
# property of scripts/check.sh; it is not, and check.sh is green without the
# knob.
#
# #1409 cured the same leak per-file (`unset GRAPPA_CACHE_ID` in
# deploy_docker_test.bats and deploy_docker_update_test.bats) and the three
# other files that drive a deploy door were never given the line. The class
# is "any bats case reaching a deploy door", so the cure belongs at the
# door, where a future case inherits it without remembering.
#
# Like the #592 suite next door, this asserts on the CONSTRUCTED invocation
# rather than faking a real run: a recorder stands in for the bats binary
# and dumps the environment it was handed.

load ../bats_helpers

setup() {
    BATS_SH="$BATS_TEST_DIRNAME/../../scripts/bats.sh"
    LIB_SH="$BATS_TEST_DIRNAME/../../scripts/_lib.sh"

    # Physical (symlink-resolved) base so _lib.sh's pwd-derived SRC_ROOT and
    # git's --git-common-dir agree on macOS (/var -> /private/var).
    TMP="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"
    ENV_LOG="$TMP/env.log"
    : > "$ENV_LOG"

    MAIN="$TMP/main"
    git init -q -b main "$MAIN"
    git -C "$MAIN" config user.email test@grappa.local
    git -C "$MAIN" config user.name bats
    mkdir -p "$MAIN/scripts" "$MAIN/lib" "$MAIN/vendor/bats-core/bin" "$MAIN/test"
    cp "$BATS_SH" "$MAIN/scripts/bats.sh"
    cp "$LIB_SH" "$MAIN/scripts/_lib.sh"
    echo base > "$MAIN/lib/base.ex"
    : > "$MAIN/test/probe.bats"
    git -C "$MAIN" add -A
    git -C "$MAIN" commit -qm base

    # Stand-in for the bats binary: records the environment it inherits and
    # exits 0. Present and executable, so the door's submodule auto-init
    # branch (#592) never fires and cannot muddy these cases.
    cat > "$MAIN/vendor/bats-core/bin/bats" <<EOF
#!/usr/bin/env bash
env > "$ENV_LOG"
exit 0
EOF
    chmod +x "$MAIN/vendor/bats-core/bin/bats"
}

@test "an ambient GRAPPA_CACHE_ID never reaches the bats process (#1522)" {
    cd "$MAIN"
    GRAPPA_CACHE_ID=w9 GRAPPA_BATS_PROBE=present run "$MAIN/scripts/bats.sh" test/probe.bats
    [ "$status" -eq 0 ]
    # Positive control: the recorder ran and captured a real environment, so
    # the absence asserted below is a refusal and not an empty file.
    grep -q '^GRAPPA_BATS_PROBE=present$' "$ENV_LOG"
    refute grep -q '^GRAPPA_CACHE_ID=' "$ENV_LOG"
    # Dropping a knob the caller set is stated where the caller reads it.
    [[ "$output" == *"GRAPPA_CACHE_ID"* ]]
}

@test "no ambient GRAPPA_CACHE_ID: the door drops nothing and says nothing (#1522)" {
    cd "$MAIN"
    unset GRAPPA_CACHE_ID
    GRAPPA_BATS_PROBE=present run "$MAIN/scripts/bats.sh" test/probe.bats
    [ "$status" -eq 0 ]
    grep -q '^GRAPPA_BATS_PROBE=present$' "$ENV_LOG"
    refute grep -q '^GRAPPA_CACHE_ID=' "$ENV_LOG"
    # No knob to drop, so no line about one.
    [[ "$output" != *"GRAPPA_CACHE_ID"* ]]
}
