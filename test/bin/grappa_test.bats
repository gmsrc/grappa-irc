#!/usr/bin/env bats
#
# Bats suite for bin/grappa — the host-side operator dispatcher.
#
# Scope: tests grappa.sh's verb routing, kebab→snake mapping, help text,
# and the shape of subprocess invocations (docker compose / scripts/mix.sh).
# Stubs `docker` AND `scripts/mix.sh` via PATH + SCRIPTS_DIR override so
# no real container or DB write happens.
#
# Out of scope: this is NOT an integration test. The actual docker
# compose API surface drift is caught by scripts/integration.sh.

load ../bats_helpers

setup() {
    BIN_GRAPPA="$BATS_TEST_DIRNAME/../../bin/grappa"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR/scripts"
    ARGV_LOG="$FAKE_DIR/argv.log"
    : > "$ARGV_LOG"

    # Stub `docker` + `scripts/mix.sh` on PATH / via SCRIPTS_DIR override.
    # Note: `git` is NOT stubbed — _lib.sh sources call `git rev-parse`
    # to derive REPO_ROOT. Tests assume the host has a real git checkout
    # (the worktree itself); running these in a non-git CWD will break.

    # Fake `docker` on PATH — records every invocation, exits 0.
    cat > "$FAKE_DIR/docker" <<EOF
#!/usr/bin/env bash
printf 'docker' >> "$ARGV_LOG"
for a in "\$@"; do printf ' %q' "\$a" >> "$ARGV_LOG"; done
printf '\n' >> "$ARGV_LOG"
exit 0
EOF
    chmod +x "$FAKE_DIR/docker"

    # Fake scripts/mix.sh — same recording shape, exits 0.
    cat > "$FAKE_DIR/scripts/mix.sh" <<EOF
#!/usr/bin/env bash
printf 'mix.sh' >> "$ARGV_LOG"
for a in "\$@"; do printf ' %q' "\$a" >> "$ARGV_LOG"; done
printf '\n' >> "$ARGV_LOG"
exit 0
EOF
    chmod +x "$FAKE_DIR/scripts/mix.sh"

    export PATH="$FAKE_DIR:$PATH"
    export SCRIPTS_DIR="$FAKE_DIR/scripts"
}

# --- help -----------------------------------------------------------------

@test "help lists every verb under each group header" {
    run "$BIN_GRAPPA" help
    [ "$status" -eq 0 ]
    [[ "$output" == *"Boot-time"* ]]
    [[ "$output" == *"Live-state"* ]]
    [[ "$output" == *"Debug"* ]]
    # boot-time verbs
    [[ "$output" == *"create-user"* ]]
    [[ "$output" == *"bind-network"* ]]
    [[ "$output" == *"add-server"* ]]
    [[ "$output" == *"set-network-caps"* ]]
    [[ "$output" == *"unbind-network"* ]]
    [[ "$output" == *"update-network-credential"* ]]
    [[ "$output" == *"seed-scrollback"* ]]
    [[ "$output" == *"gen-encryption-key"* ]]
    [[ "$output" == *"gen-vapid"* ]]
    [[ "$output" == *"remove-server"* ]]
    # live-state verbs (stubs in T-1)
    [[ "$output" == *"delete-visitor"* ]]
    [[ "$output" == *"reset-totp"* ]]
    [[ "$output" == *"reset-passkeys"* ]]
    [[ "$output" == *"reap-visitors"* ]]
    [[ "$output" == *"list-sessions"* ]]
    [[ "$output" == *"list-credentials"* ]]
    [[ "$output" == *"list-visitors"* ]]
    [[ "$output" == *"remote-shell"* ]]
    # debug verbs
    [[ "$output" == *"open-db"* ]]
    [[ "$output" == *"shell"* ]]
}

@test "no args prints help and exits 0" {
    run "$BIN_GRAPPA"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Boot-time"* ]]
}

# --- unknown verb ---------------------------------------------------------

@test "unknown verb exits 64 with usage to stderr" {
    run "$BIN_GRAPPA" frobnicate
    [ "$status" -eq 64 ]
    [[ "$output" == *"unknown verb"* ]]
    [[ "$output" == *"frobnicate"* ]]
    [[ "$output" == *"bin/grappa help"* ]]
}

# --- per-verb help --------------------------------------------------------

@test "help delete-visitor shows real usage (uuid arg + Operator entry point)" {
    run "$BIN_GRAPPA" help delete-visitor
    [ "$status" -eq 0 ]
    [[ "$output" == *"uuid"* ]]
    [[ "$output" != *"STUB"* ]]
    [[ "$output" != *"land in T-3"* ]]
}

@test "help remote-shell shows real usage (not the T-1 stub)" {
    run "$BIN_GRAPPA" help remote-shell
    [ "$status" -eq 0 ]
    [[ "$output" == *"--batch"* ]]
    [[ "$output" == *"-e"* ]]
    [[ "$output" != *"STUB"* ]]
}

@test "help <boot-verb> prints inline help and never reaches mix" {
    run "$BIN_GRAPPA" help create-user
    [ "$status" -eq 0 ]
    [[ "$output" == *"create-user"* ]]
    [[ "$output" == *"--password"* ]]
    [ ! -s "$ARGV_LOG" ]
}

@test "help <debug-verb> prints inline help" {
    run "$BIN_GRAPPA" help shell
    [ "$status" -eq 0 ]
    [[ "$output" == *"shell"* ]]
}

@test "help <unknown-verb> exits 64" {
    run "$BIN_GRAPPA" help frobnicate
    [ "$status" -eq 64 ]
}

# --- #1086: --help / -h as a FLAG, not just a verb -------------------------
#
# The dispatcher used to know help only as a verb (`bin/grappa help <verb>`).
# A `--help` AFTER a verb was passed through as an ordinary argument: boot
# verbs handed it to a mix task that parses `strict:`, which discarded it
# silently and then blew up on the first required option with a raw KeyError
# traceback. These assert the flag form reaches the SAME per-verb help path
# the verb form already used, for every kind of verb, and that the verb's
# real work never runs.

@test "#1086 <boot-verb> --help routes to per-verb help, not to the task" {
    run "$BIN_GRAPPA" bind-network --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"bind-network"* ]]
    [[ "$output" == *"--auth"* ]]
    # Neither the task NOR `mix help` may be reached: the first is the
    # crash path, the second is the delegation this slice removed.
    [ ! -s "$ARGV_LOG" ]
}

@test "#1086 <boot-verb> -h routes to per-verb help" {
    run "$BIN_GRAPPA" bind-network -h
    [ "$status" -eq 0 ]
    [[ "$output" == *"bind-network"* ]]
    [ ! -s "$ARGV_LOG" ]
}

@test "#1086 --help is honoured after other arguments, not only first" {
    run "$BIN_GRAPPA" bind-network --user vjt --network azzurra --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"bind-network"* ]]
    [ ! -s "$ARGV_LOG" ]
}

@test "#1086 <rpc-verb> --help prints inline help without touching docker" {
    run "$BIN_GRAPPA" list-sessions --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"list-sessions"* ]]
    [[ "$output" == *"SessionRegistry"* ]]
    [ ! -s "$ARGV_LOG" ]
}

@test "#1086 <arg-taking verb> --help prints inline help instead of erroring" {
    run "$BIN_GRAPPA" delete-visitor --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"uuid"* ]]
    [ ! -s "$ARGV_LOG" ]
}

@test "#1086 <debug-verb> --help prints inline help without touching docker" {
    run "$BIN_GRAPPA" shell --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"shell"* ]]
    [ ! -s "$ARGV_LOG" ]
}

@test "#1086 bare --help prints the top banner and exits 0" {
    run "$BIN_GRAPPA" --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"Boot-time"* ]]
    [[ "$output" == *"bind-network"* ]]
}

@test "#1086 --help on an unknown verb still exits 64" {
    run "$BIN_GRAPPA" frobnicate --help
    [ "$status" -eq 64 ]
}

# --- VERBS table completeness --------------------------------------------
#
# db-latency + db-latency-reset (#357) were in VERBS but in neither
# VERB_DISPLAY_ORDER nor the help functions, so they were invisible in the
# banner and `bin/grappa help db-latency` died with 127
# (`verb_help_db_latency: command not found`). Both halves of that are a
# CLASS, not two typos: the banner is rendered by walking
# VERB_DISPLAY_ORDER, and per-verb help is dispatched by name, so either
# omission silently orphans a verb. These walk the table instead.

# Every verb in the VERBS table, whatever its kind.
table_verbs() {
    sed -nE 's/^[[:space:]]*\[([a-z-]+)\]="(boot|rpc|attach|debug|meta)\|.*/\1/p' "$BIN_GRAPPA"
}

@test "the VERBS extractor is not silently empty (guard against a dead loop)" {
    run table_verbs
    [ "$status" -eq 0 ]
    [ "$(wc -l <<<"$output")" -ge 20 ]
    [[ "$output" == *"db-latency"* ]]
}

@test "the banner lists every verb in the table (VERB_DISPLAY_ORDER covers VERBS)" {
    run "$BIN_GRAPPA" help
    [ "$status" -eq 0 ]
    local banner="$output" verb
    while read -r verb; do
        [[ "$banner" == *"$verb"* ]] || {
            printf 'verb %q is in VERBS but absent from the banner\n' "$verb" >&2
            return 1
        }
    done < <(table_verbs)
}

@test "every verb in the table has per-verb help that exits 0 and prints something" {
    # `prints something` only became assertable once the boot verbs
    # answered inline (#1086): while they delegated, the stubbed
    # scripts/mix.sh exited 0 with nothing on stdout.
    local verb
    while read -r verb; do
        run "$BIN_GRAPPA" help "$verb"
        [ "$status" -eq 0 ]
        [ -n "$output" ]
    done < <(table_verbs)
}

# --- #1086 second slice: boot-verb help is INLINE ------------------------
#
# The ten boot verbs used to answer `--help` with
# `exec scripts/mix.sh --env=dev help grappa.<task>`, i.e. mix's built-in
# reader of the task's @shortdoc/@moduledoc. That answered a different
# question than the one asked — the moduledoc documents
# `scripts/mix.sh grappa.create_user`, not `bin/grappa create-user` — and
# it cost a container: with no live grappa container, scripts/mix.sh falls
# through _lib.sh's `in_container_or_oneshot` to
# `docker compose run --rm --no-deps`, booting an image to print a
# paragraph. These are the tests that state the REASON.

# The boot verbs, read off the VERBS table so a verb added there is
# covered without editing this file.
boot_verbs() {
    sed -nE 's/^[[:space:]]*\[([a-z-]+)\]="boot\|.*/\1/p' "$BIN_GRAPPA"
}

@test "#1086 the boot-verb extractor sees the whole table (guard against a dead loop)" {
    run boot_verbs
    [ "$status" -eq 0 ]
    [ "$(wc -l <<<"$output")" -eq 10 ]
    [[ "$output" == *"create-user"* ]]
    [[ "$output" == *"gen-vapid"* ]]
}

@test "#1086 every boot verb answers --help with no working docker and no scripts/ dir" {
    # Hostile environment: `docker` on PATH refuses to run at all, and
    # SCRIPTS_DIR points at an empty directory, so `$SCRIPTS_DIR/mix.sh`
    # does not exist. Any surviving delegation exits non-zero here — as
    # all ten did before this slice, with 127.
    cat > "$FAKE_DIR/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker: refusing to run in the no-docker help test\n' >&2
exit 127
EOF
    chmod +x "$FAKE_DIR/docker"
    mkdir -p "$BATS_TEST_TMPDIR/empty-scripts"
    export SCRIPTS_DIR="$BATS_TEST_TMPDIR/empty-scripts"

    local verb
    while read -r verb; do
        run "$BIN_GRAPPA" "$verb" --help
        [ "$status" -eq 0 ]
        # The help names the verb the operator typed (kebab), not the mix
        # task the moduledoc documents.
        [[ "$output" == *"$verb"* ]]
        [ "${#output}" -gt 80 ]
    done < <(boot_verbs)
}

@test "#1086 boot-verb help names bin/grappa's verb, never the mix task spelling" {
    run "$BIN_GRAPPA" help update-network-credential
    [ "$status" -eq 0 ]
    [[ "$output" == *"update-network-credential"* ]]
    refute grep -q 'grappa.update_network_credential' <<<"$output"
    refute grep -q 'scripts/mix.sh' <<<"$output"
}

# --- debug verbs ----------------------------------------------------------

@test "shell invokes docker compose exec grappa bash" {
    run "$BIN_GRAPPA" shell
    [ "$status" -eq 0 ]
    grep -qE 'docker .*compose .*exec grappa bash' "$ARGV_LOG"
}

@test "open-db invokes sqlite3 in container with RW (no -readonly)" {
    run "$BIN_GRAPPA" open-db
    [ "$status" -eq 0 ]
    grep -q 'sqlite3' "$ARGV_LOG"
    refute grep -q -- '-readonly' "$ARGV_LOG"
}

# --- boot-time verb dispatch ---------------------------------------------

@test "create-user dispatches scripts/mix.sh grappa.create_user with args" {
    run "$BIN_GRAPPA" create-user --name vjt --password 'pwd'
    [ "$status" -eq 0 ]
    grep -q 'mix.sh grappa.create_user --name vjt --password pwd' "$ARGV_LOG"
}

@test "kebab-to-snake mapping handles multi-word verbs" {
    run "$BIN_GRAPPA" update-network-credential --foo bar
    [ "$status" -eq 0 ]
    grep -q 'mix.sh grappa.update_network_credential --foo bar' "$ARGV_LOG"
}

@test "set-network-caps maps to grappa.set_network_caps" {
    run "$BIN_GRAPPA" set-network-caps --network azzurra --max 5
    [ "$status" -eq 0 ]
    grep -q 'mix.sh grappa.set_network_caps --network azzurra --max 5' "$ARGV_LOG"
}

# --- live-state verbs (T-3 — wired through --rpc-eval) ------------------

@test "delete-visitor invokes docker exec -T grappa with --rpc-eval calling Operator.delete_visitor!" {
    run "$BIN_GRAPPA" delete-visitor abc-uuid-1234
    [ "$status" -eq 0 ]
    grep -q 'docker .*compose .*exec -T grappa sh' "$ARGV_LOG"
    grep -q -- '--rpc-eval' "$ARGV_LOG"
    grep -q -- 'grappa@grappa' "$ARGV_LOG"
    grep -q 'Grappa.Operator.delete_visitor' "$ARGV_LOG"
    grep -q 'abc-uuid-1234' "$ARGV_LOG"
    # --rpc-eval (NOT --remsh which would eval on client) — same shape
    # as remote-shell --batch per T-2.
    refute grep -q -- '--remsh' "$ARGV_LOG"
}

@test "delete-visitor with no args exits 64 with usage" {
    run "$BIN_GRAPPA" delete-visitor
    [ "$status" -eq 64 ]
    [[ "$output" == *"delete-visitor"* ]]
    [[ "$output" == *"uuid"* ]]
}

# The account-recovery verbs must land in the rpc lane, not the boot lane:
# a mix task runs in a second BEAM whose revocation reaches no live socket.
# Asserting --rpc-eval here is asserting that fix, not the plumbing.
@test "reset-totp invokes --rpc-eval calling Operator.reset_totp! on the live node" {
    run "$BIN_GRAPPA" reset-totp alice
    [ "$status" -eq 0 ]
    grep -q 'docker .*compose .*exec -T grappa sh' "$ARGV_LOG"
    grep -q -- '--rpc-eval' "$ARGV_LOG"
    grep -q -- 'grappa@grappa' "$ARGV_LOG"
    grep -q 'Grappa.Operator.reset_totp' "$ARGV_LOG"
    grep -q 'alice' "$ARGV_LOG"
    refute grep -q 'mix.sh' "$ARGV_LOG"
}

@test "reset-totp with no args exits 64 with usage" {
    run "$BIN_GRAPPA" reset-totp
    [ "$status" -eq 64 ]
    [[ "$output" == *"reset-totp"* ]]
    [[ "$output" == *"account-name"* ]]
}

@test "reset-passkeys invokes --rpc-eval calling Operator.reset_passkeys! on the live node" {
    run "$BIN_GRAPPA" reset-passkeys alice
    [ "$status" -eq 0 ]
    grep -q -- '--rpc-eval' "$ARGV_LOG"
    grep -q 'Grappa.Operator.reset_passkeys' "$ARGV_LOG"
    grep -q 'alice' "$ARGV_LOG"
    refute grep -q 'mix.sh' "$ARGV_LOG"
}

@test "reset-passkeys with no args exits 64 with usage" {
    run "$BIN_GRAPPA" reset-passkeys
    [ "$status" -eq 64 ]
    [[ "$output" == *"reset-passkeys"* ]]
    [[ "$output" == *"account-name"* ]]
}

@test "reap-visitors invokes docker exec -T grappa with --rpc-eval calling Operator.reap_visitors!" {
    run "$BIN_GRAPPA" reap-visitors
    [ "$status" -eq 0 ]
    grep -q 'docker .*compose .*exec -T grappa sh' "$ARGV_LOG"
    grep -q -- '--rpc-eval' "$ARGV_LOG"
    grep -q 'Grappa.Operator.reap_visitors' "$ARGV_LOG"
}

@test "remote-shell with no args invokes docker exec grappa iex --remsh grappa@grappa" {
    run "$BIN_GRAPPA" remote-shell
    [ "$status" -eq 0 ]
    grep -q 'docker .*compose .*exec grappa sh' "$ARGV_LOG"
    # printf %q escapes the inner sh -c quotes; assert the load-bearing
    # tokens individually rather than reconstructing the escaped form.
    grep -q 'iex' "$ARGV_LOG"
    grep -q -- '--sname' "$ARGV_LOG"
    grep -q -- 'admin-' "$ARGV_LOG"
    grep -q -- '--cookie' "$ARGV_LOG"
    grep -q 'RELEASE_COOKIE' "$ARGV_LOG"
    grep -q -- '--remsh' "$ARGV_LOG"
    grep -q -- 'grappa@grappa' "$ARGV_LOG"
    # Interactive mode — NO -T flag in the docker exec.
    refute grep -qE 'docker .*compose .*exec -T grappa sh' "$ARGV_LOG"
}

@test "remote-shell --batch -e <expr> invokes docker exec -T with --rpc-eval" {
    run "$BIN_GRAPPA" remote-shell --batch -e 'Process.list() |> length()'
    [ "$status" -eq 0 ]
    grep -q 'docker .*compose .*exec -T grappa sh' "$ARGV_LOG"
    grep -q -- '--rpc-eval' "$ARGV_LOG"
    grep -q 'Process.list' "$ARGV_LOG"
    grep -q -- 'grappa@grappa' "$ARGV_LOG"
    # Batch uses --rpc-eval (eval on REMOTE), NOT --remsh (which would
    # eval on the client node before attaching the shell).
    refute grep -q -- '--remsh' "$ARGV_LOG"
}

@test "remote-shell --batch without -e exits 64 with usage" {
    run "$BIN_GRAPPA" remote-shell --batch
    [ "$status" -eq 64 ]
    [[ "$output" == *"--batch"* ]]
    [[ "$output" == *"-e"* ]]
}

@test "remote-shell shape includes --sname admin- and --cookie literal RELEASE_COOKIE" {
    run "$BIN_GRAPPA" remote-shell
    [ "$status" -eq 0 ]
    # The cookie value is expanded INSIDE the container's sh -c, so the
    # host-side argv contains the LITERAL string "$RELEASE_COOKIE".
    grep -q -- 'admin-' "$ARGV_LOG"
    grep -q -- '\$RELEASE_COOKIE' "$ARGV_LOG"
}

@test "list-sessions invokes docker exec -T grappa with --rpc-eval calling Operator.list_sessions_text!" {
    run "$BIN_GRAPPA" list-sessions
    [ "$status" -eq 0 ]
    grep -q 'docker .*compose .*exec -T grappa sh' "$ARGV_LOG"
    grep -q -- '--rpc-eval' "$ARGV_LOG"
    grep -q 'Grappa.Operator.list_sessions_text' "$ARGV_LOG"
}

@test "list-credentials invokes docker exec -T grappa with --rpc-eval calling Operator.list_credentials_text!" {
    run "$BIN_GRAPPA" list-credentials
    [ "$status" -eq 0 ]
    grep -q 'docker .*compose .*exec -T grappa sh' "$ARGV_LOG"
    grep -q -- '--rpc-eval' "$ARGV_LOG"
    grep -q 'Grappa.Operator.list_credentials_text' "$ARGV_LOG"
}

@test "list-visitors invokes docker exec -T grappa with --rpc-eval calling Operator.list_visitors_text!" {
    run "$BIN_GRAPPA" list-visitors
    [ "$status" -eq 0 ]
    grep -q 'docker .*compose .*exec -T grappa sh' "$ARGV_LOG"
    grep -q -- '--rpc-eval' "$ARGV_LOG"
    grep -q 'Grappa.Operator.list_visitors_text' "$ARGV_LOG"
}

# --- M3 (REV-I) — VERBS table single-source-of-truth invariants ---------

@test "rpc verb with extra args exits 64 (nullary rpc handler refuses args)" {
    # Per M3 (REV-I) prefer-bespoke rule: nullary rpc verbs go through
    # dispatch_rpc which refuses extra args. If a future arg-taking
    # rpc verb is added without a bespoke verb_<snake>() handler, this
    # test will catch the mistake at the right call site.
    run "$BIN_GRAPPA" reap-visitors --extra
    [ "$status" -eq 64 ]
    [[ "$output" == *"reap-visitors"* ]]
    [[ "$output" == *"no arguments"* ]]
}
