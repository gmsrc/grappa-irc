#!/usr/bin/env bats
#
# Bats suite for infra/lib/beam_wait.sh — the shared BEAM stop/start
# synchronization helper (defect #9). Stubs pgrep/pkill/epmd via PATH;
# BEAM/epmd state lives in $STATE files the fakes read and the fake
# pkill mutates (simulating the kill taking effect).
#
# The load-bearing distinction under test: `wait-stopped` may escalate
# (SIGKILL the BEAM after timeout, restart a stale epmd AFTER the BEAM
# is confirmed dead) while `wait-name-free` must NEVER kill anything —
# pkill'ing epmd while a BEAM is alive makes the BEAM respawn it and
# races the new node's name registration (live-repro 2026-05-31).
#
# EVERY behaviour runs through BOTH substrate entry points, not through
# the lib alone: the jail's rc.d and deploy.sh call the FreeBSD path and
# grappa.service's ExecStartPre calls the Linux one, so a shim that
# stopped delegating — or started doing something of its own — is the
# exact regression the #923 dedupe exists to prevent, and it has to be a
# red here rather than a surprise on the next prod stop.

load ../bats_helpers

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."

    ENTRY_POINTS=(
        "$REPO_SRC/infra/freebsd/jail_beam_wait.sh"
        "$REPO_SRC/infra/linux/grappa_beam_wait.sh"
    )

    STATE="$BATS_TEST_TMPDIR/state"
    mkdir -p "$STATE"
    export STATE
    KILL_LOG="$STATE/kill.log"
    : > "$KILL_LOG"
    export KILL_LOG

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"

    # beam.smp is "running" while $STATE/beam exists.
    cat > "$FAKE_DIR/pgrep" <<'EOF'
#!/bin/sh
[ -f "$STATE/beam" ] && exit 0
exit 1
EOF

    # pkill records, then makes the kill take effect on the state files.
    cat > "$FAKE_DIR/pkill" <<'EOF'
#!/bin/sh
printf 'pkill %s\n' "$*" >> "$KILL_LOG"
case "$*" in
    *beam.smp*) rm -f "$STATE/beam" ;;
    *epmd*)     rm -f "$STATE/epmd_names" ;;
esac
exit 0
EOF

    # epmd -names prints the registration table or fails when not running.
    cat > "$FAKE_DIR/epmd" <<'EOF'
#!/bin/sh
if [ -f "$STATE/epmd_names" ]; then
    cat "$STATE/epmd_names"
    exit 0
fi
echo "epmd: Cannot connect to local epmd" >&2
exit 1
EOF

    chmod +x "$FAKE_DIR"/*
    export PATH="$FAKE_DIR:$PATH"
}

beam_running() { touch "$STATE/beam"; }
name_registered() { printf 'name %s at port 39559\n' "$1" > "$STATE/epmd_names"; }

# Between entry points: same test, clean slate. bats prints a failing
# test's output, so the echo attributes the failure to one substrate.
next_entry_point() {
    rm -f "$STATE/beam" "$STATE/epmd_names"
    : > "$KILL_LOG"
    echo "--- entry point: $1"
}

# --- wait-stopped ------------------------------------------------------------

@test "wait-stopped: BEAM gone and name free returns 0 without killing" {
    for BEAM_WAIT in "${ENTRY_POINTS[@]}"; do
        next_entry_point "$BEAM_WAIT"

        run "$BEAM_WAIT" wait-stopped grappa 5
        [ "$status" -eq 0 ]
        [ ! -s "$KILL_LOG" ]
    done
}

@test "wait-stopped: BEAM alive past timeout gets SIGKILL, then returns 0" {
    for BEAM_WAIT in "${ENTRY_POINTS[@]}"; do
        next_entry_point "$BEAM_WAIT"
        beam_running

        run "$BEAM_WAIT" wait-stopped grappa 1
        [ "$status" -eq 0 ]
        grep -q "pkill -9 beam.smp" "$KILL_LOG"
    done
}

@test "wait-stopped: stale epmd name after BEAM exit gets epmd restarted" {
    for BEAM_WAIT in "${ENTRY_POINTS[@]}"; do
        next_entry_point "$BEAM_WAIT"
        name_registered grappa

        run "$BEAM_WAIT" wait-stopped grappa 1
        [ "$status" -eq 0 ]
        grep -q "pkill epmd" "$KILL_LOG"
        refute grep -q "beam.smp" "$KILL_LOG"
    done
}

@test "wait-stopped: other node names do not block" {
    for BEAM_WAIT in "${ENTRY_POINTS[@]}"; do
        next_entry_point "$BEAM_WAIT"
        name_registered other_node

        run "$BEAM_WAIT" wait-stopped grappa 1
        [ "$status" -eq 0 ]
        [ ! -s "$KILL_LOG" ]
    done
}

# --- wait-name-free -----------------------------------------------------------

@test "wait-name-free: free name returns 0 immediately" {
    for BEAM_WAIT in "${ENTRY_POINTS[@]}"; do
        next_entry_point "$BEAM_WAIT"

        run "$BEAM_WAIT" wait-name-free grappa 5
        [ "$status" -eq 0 ]
        [ ! -s "$KILL_LOG" ]
    done
}

@test "wait-name-free: registered name times out loud and NEVER kills" {
    for BEAM_WAIT in "${ENTRY_POINTS[@]}"; do
        next_entry_point "$BEAM_WAIT"
        name_registered grappa
        beam_running   # the dangerous case: old node still draining

        run "$BEAM_WAIT" wait-name-free grappa 1
        [ "$status" -eq 1 ]
        [[ "$output" == *"still registered"* ]]
        [ ! -s "$KILL_LOG" ]
    done
}

# --- usage ---------------------------------------------------------------------

@test "unknown verb is a usage error (64)" {
    for BEAM_WAIT in "${ENTRY_POINTS[@]}"; do
        next_entry_point "$BEAM_WAIT"

        run "$BEAM_WAIT" frobnicate grappa 1
        [ "$status" -eq 64 ]
    done
}

@test "missing args is a usage error (64)" {
    for BEAM_WAIT in "${ENTRY_POINTS[@]}"; do
        next_entry_point "$BEAM_WAIT"

        run "$BEAM_WAIT" wait-stopped
        [ "$status" -eq 64 ]
    done
}

# --- the dedupe itself ----------------------------------------------------------

@test "exactly one file under infra/ implements the wait algorithm" {
    cd "$REPO_SRC"

    # Matched as a SUBSTRING, so it catches both the shared lib's
    # `beam_wait_name_free()` and a re-copied `wait_name_free()` under
    # the pre-#923 name — a third copy would arrive by pasting the old
    # shape, and a pattern pinned to the new name would wave it through.
    run grep -rl 'wait_name_free()' infra
    [ "$status" -eq 0 ]
    [ "$output" = "infra/lib/beam_wait.sh" ]
}
