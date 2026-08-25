#!/usr/bin/env bats
#
# #592 — the submodule auto-init in scripts/testnet.sh AND scripts/bats.sh
# must pass `-c protocol.file.allow=always`.
#
# In a git worktree the submodule is cloned from the superproject's LOCAL
# module store ($REPO/.git/modules/…) over the file:// transport, which the
# CVE-2022-39253 mitigation blocks by default. Without the flag every fresh
# worktree dies with `fatal: transport 'file' not allowed`, so the auto-init
# that exists precisely to spare the manual `git submodule update --init`
# never spares it — it just fails more verbosely. This is a CLASS (both
# scripts share the pattern), not a single case.
#
# Cloning for real in a worktree under bats is impractical (it needs a
# populated superproject module store hit under the exact CVE conditions),
# so — per the issue and the orchestrator's steer — this asserts on the
# CONSTRUCTED command instead of faking a clone: a `git` stub on PATH
# records every invocation, forwards everything except `submodule update`
# to real git, and the test asserts the recorded submodule-update line
# carries the flag. Honest + tight: it proves the flag reaches the
# invocation, not that a clone succeeds. RED before the fix (the recorded
# line lacks the flag), GREEN after.

setup() {
    TESTNET_SH="$BATS_TEST_DIRNAME/../../scripts/testnet.sh"
    BATS_SH="$BATS_TEST_DIRNAME/../../scripts/bats.sh"
    LIB_SH="$BATS_TEST_DIRNAME/../../scripts/_lib.sh"
    VERSION_SH="$BATS_TEST_DIRNAME/../../infra/packaging/version.sh"
    CREDITS_SH="$BATS_TEST_DIRNAME/../../infra/packaging/credits.sh"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    GIT_LOG="$FAKE_DIR/git-argv.log"
    : > "$GIT_LOG"

    # Capture the real git BEFORE the stub shadows it on PATH.
    REAL_GIT="$(command -v git)"

    # Physical (symlink-resolved) base so _lib.sh's pwd-derived SRC_ROOT
    # and git's --git-common-dir agree on macOS (/var → /private/var).
    TMP="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"

    MAIN="$TMP/main"
    git init -q -b main "$MAIN"
    git -C "$MAIN" config user.email test@grappa.local
    git -C "$MAIN" config user.name bats
    mkdir -p "$MAIN/scripts" "$MAIN/infra/packaging" "$MAIN/lib" "$MAIN/cicchetto/e2e"
    cp "$TESTNET_SH" "$MAIN/scripts/testnet.sh"
    cp "$BATS_SH" "$MAIN/scripts/bats.sh"
    cp "$LIB_SH" "$MAIN/scripts/_lib.sh"
    # testnet.sh derives GRAPPA_VERSION from the repo-root VERSION file via
    # version.sh (#652) BEFORE the submodule branch — under set -e it must
    # succeed or the script dies before we reach the code under test.
    cp "$VERSION_SH" "$MAIN/infra/packaging/version.sh"
    # #1773 — GRAPPA_CREDITS is derived on the same lines, before the same
    # branch, and dies the same way when the script is missing.
    cp "$CREDITS_SH" "$MAIN/infra/packaging/credits.sh"
    chmod +x "$MAIN/infra/packaging/version.sh" "$MAIN/infra/packaging/credits.sh"
    printf '9.9.9\n' > "$MAIN/VERSION"
    printf 'defmodule Grappa.MixProject do\n  @version "9.9.9"\nend\n' > "$MAIN/mix.exs"
    # testnet.sh's compose.yaml existence check must pass; the infra
    # submodule dir must be ABSENT so the auto-init branch fires. lib/ is the
    # marker _lib.sh uses (with the .git FILE) to detect a worktree.
    : > "$MAIN/cicchetto/e2e/compose.yaml"
    echo base > "$MAIN/lib/base.ex"
    git -C "$MAIN" add -A
    git -C "$MAIN" commit -qm base

    # A REAL worktree so _lib.sh derives SRC_ROOT=WT and `git rev-parse
    # --git-common-dir` resolves MAIN's .git — the exact worktree condition
    # the bug needs. A fresh worktree has NO cicchetto/e2e/infra and NO
    # vendor/bats-core, so each script's auto-init branch fires.
    WT="$TMP/wt"
    git -C "$MAIN" worktree add -q -b wt "$WT"

    # git stub: record every invocation; short-circuit `submodule update`
    # (record + exit 0, NO real clone) so the test never needs a populated
    # module store; forward everything else (rev-parse, …) to real git so
    # _lib.sh resolves REPO_ROOT normally.
    cat > "$FAKE_DIR/git" <<EOF
#!/usr/bin/env bash
{ printf 'git'; for a in "\$@"; do printf ' %q' "\$a"; done; printf '\n'; } >> "$GIT_LOG"
for a in "\$@"; do
    [ "\$a" = "submodule" ] && exit 0
done
exec "$REAL_GIT" "\$@"
EOF
    chmod +x "$FAKE_DIR/git"
    export PATH="$FAKE_DIR:$PATH"
}

@test "testnet.sh submodule auto-init passes protocol.file.allow=always in a worktree" {
    cd "$WT"
    # Any verb reaches the auto-init branch (it sits above the verb
    # dispatch); an unknown one exits at the usage die without needing docker.
    run "$WT/scripts/testnet.sh" __no_such_verb__
    [[ "$output" == *"initialising"* ]]
    grep -q 'submodule update --init cicchetto/e2e/infra' "$GIT_LOG"
    grep -q -- '-c protocol.file.allow=always submodule update' "$GIT_LOG"
}

@test "bats.sh submodule auto-init passes protocol.file.allow=always in a worktree" {
    cd "$WT"
    run "$WT/scripts/bats.sh"
    [[ "$output" == *"initialising submodule"* ]]
    grep -q 'submodule update --init vendor/bats-core' "$GIT_LOG"
    grep -q -- '-c protocol.file.allow=always submodule update' "$GIT_LOG"
}
