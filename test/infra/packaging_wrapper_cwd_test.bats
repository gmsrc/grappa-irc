#!/usr/bin/env bats
#
# /usr/bin/grappa must hand the release a SEARCHABLE working directory (#1267).
#
# Reported by a self-hoster on Debian 13 (unprivileged LXC, .deb 1.0.0): every
# eval-backed verb — create-user, migrate, seed-themes, rpc, remote — died
# during ERTS boot with `{badarg,[{persistent_term,get,[code_server]...`. The
# narrowing upstream varied ONLY the mode of the cwd: 0700 dies, 0711 and 0555
# boot. So the trigger is precisely the SEARCH (x) bit on the cwd for the
# EFFECTIVE user — not read, not write. The crash is bare ERTS, reproduced with
# `erl -boot .../start_clean` and no grappa module loaded; grappa's part is only
# in HANDING the VM such a cwd. `runuser -u` — unlike `runuser -l` — does not
# change directory, so the child inherits the caller's cwd, and Debian 13 ships
# HOME_MODE 0700 with /root at 0700: the first command in the packaging README
# fails from exactly where the operator's shell puts them.
#
# Why nothing caught it: dpkg runs maintainer scriptlets with cwd `/`, and the
# release.yml job that installs the .deb inherits the same `/`. The packaged
# path stays green while the interactive one is broken — a suite that does not
# CONTROL the cwd cannot see this class at all, which is why every case below
# sets it deliberately.
#
# ── WHAT THIS SUITE DOES NOT PROVE ──────────────────────────────────────────
# It does not boot a BEAM. There is no ERTS here, so "the VM survives an
# unsearchable cwd" is out of reach and remains pinned only by the measurement
# in the issue. What is pinned here is grappa's own side of the contract: that
# BOTH exec branches of the wrapper hand the release a cwd of `/`, when invoked
# from a directory that genuinely cannot be searched. The mutant that removes
# the `cd` is killed; a mutant that broke ERTS itself would not be.

load ../bats_helpers

setup() {
    PKG_SRC="$BATS_TEST_DIRNAME/../../infra/packaging"

    ROOT="$BATS_TEST_TMPDIR/root"
    mkdir -p "$ROOT/usr/lib/grappa/bin" "$ROOT/etc/grappa"

    CALL_LOG="$BATS_TEST_TMPDIR/calls.log"
    CWD_LOG="$BATS_TEST_TMPDIR/cwd.log"
    export CALL_LOG CWD_LOG
    : > "$CALL_LOG"
    : > "$CWD_LOG"

    # The mix-release boot script the wrapper execs, as a recorder. It reports
    # its cwd the way the VM would learn it — a real getcwd, not the inherited
    # $PWD string, since $PWD is a claim the parent makes and getcwd is the
    # thing ERTS actually performs. On an unsearchable cwd getcwd FAILS on
    # darwin and merely returns the path on Linux; either way it is not `/`,
    # so the assertions below hold on both userlands.
    cat > "$ROOT/usr/lib/grappa/bin/grappa" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALL_LOG"
pwd -P >> "$CWD_LOG" 2>/dev/null || printf 'getcwd-failed\n' >> "$CWD_LOG"
EOF
    chmod 0755 "$ROOT/usr/lib/grappa/bin/grappa"

    printf 'DATABASE_PATH=%s/db\n' "$ROOT" > "$ROOT/etc/grappa/grappa.env"

    # ── The two root-only externals, stubbed ────────────────────────────────
    # The privileged branch is unreachable from an unprivileged suite, and it
    # is the branch the bug report came in on. Both stubs are STRICT: an argv
    # they do not recognise aborts loudly rather than passing through, so a
    # future edit to the wrapper's invocation cannot silently start being
    # measured by a stub that no longer models it.
    STUB="$BATS_TEST_TMPDIR/stub"
    mkdir -p "$STUB"

    cat > "$STUB/id" <<'EOF'
#!/bin/sh
[ "$1" = "-u" ] || { echo "id stub: unexpected argv: $*" >&2; exit 64; }
echo 0
EOF

    # The ONE property of runuser this suite is about: `-u` does not change
    # directory, so the child inherits the caller's cwd (measured upstream on
    # debian:trixie — `cd /root/secret && runuser -u testu -- pwd` prints
    # /root/secret). The identity switch needs real root and is not under test,
    # so the stub keeps the identity and reproduces only the cwd inheritance.
    cat > "$STUB/runuser" <<'EOF'
#!/bin/sh
[ "$1" = "-u" ] || { echo "runuser stub: expected -u, got: $*" >&2; exit 64; }
shift 2
[ "$1" = "--" ] || { echo "runuser stub: expected --, got: $*" >&2; exit 64; }
shift
exec "$@"
EOF

    chmod 0755 "$STUB/id" "$STUB/runuser"

    # The wrapper, re-rooted: it addresses the host by absolute path, and a
    # leaked one would either abort as non-root or touch the developer's box.
    WRAPPER="$BATS_TEST_TMPDIR/grappa"
    sed -e "s#/usr/bin/grappa#$ROOT/usr/bin/grappa#g" \
        -e "s#/usr/lib/grappa#$ROOT/usr/lib/grappa#g" \
        -e "s#/usr/share/grappa#$ROOT/usr/share/grappa#g" \
        -e "s#/etc/grappa#$ROOT/etc/grappa#g" \
        "$PKG_SRC/grappa-wrapper.sh" > "$WRAPPER"
    chmod 0755 "$WRAPPER"
    assert_rerooted "$WRAPPER"

    NOSEARCH="$BATS_TEST_TMPDIR/nosearch"
    mkdir -p "$NOSEARCH"
}

teardown() {
    # Give the bits back or bats cannot clean its own tmpdir.
    [ -d "$NOSEARCH" ] && chmod 0755 "$NOSEARCH"
    return 0
}

# A leaked absolute path means the sandbox is porous and every case below
# would be measuring something other than the script we ship.
#
# The sandbox prefix is neutralised FIRST, and replaced by an alphanumeric
# sentinel rather than deleted. Both halves are load-bearing: on darwin
# BATS_TEST_TMPDIR itself lives under /var/folders, so an un-neutralised scan
# reads every correctly re-rooted path as a leak; and deleting the prefix
# instead of replacing it would turn `$ROOT/usr/lib/grappa` back into
# `/usr/lib/grappa`, i.e. into the very thing being looked for.
assert_rerooted() {
    local leaked
    leaked="$(sed "s#$ROOT#SANDBOX#g" "$1" |
        grep -nE '(^|[^/[:alnum:]_.-])/(usr|etc|var)/[[:alnum:]/._-]*grappa')" \
        || return 0
    printf 'absolute host paths survived the re-root:\n%s\n' "$leaked" >&2
    return 1
}

# Run a command from a directory the effective user cannot SEARCH.
#
# Upstream reproduced the trigger with a root-owned 0700 directory entered as
# another user. An unprivileged suite cannot own another user's directory, but
# mode 000 on our OWN denies the owner class the very same bit, and the kernel
# check is per-class: from the process's point of view the two states are
# identical. Only root bypasses it, and root is not who runs this.
#
# The directory must be ENTERED before the bits go, because afterwards nothing
# can enter it — which is also why this is done in a subshell.
from_unsearchable() {
    ( cd "$NOSEARCH" && chmod 000 . && "$@" )
}

# The wrapper as the operator invokes it: as root (stubs on PATH, privileged
# branch) or as the grappa user (no stubs, already-unprivileged branch).
wrapper_as() {
    local who="$1"
    shift
    if [ "$who" = root ]; then
        from_unsearchable env "PATH=$STUB:$PATH" "$WRAPPER" "$@"
    else
        from_unsearchable "$WRAPPER" "$@"
    fi
}

# ── The harness's own oracle ────────────────────────────────────────────────

@test "the harness really hands its child a cwd that is not / (#1267)" {
    # Without this, every assertion below could hold because the suite runs
    # from `/` anyway, and the wrapper's `cd` would never be exercised.
    from_unsearchable "$ROOT/usr/lib/grappa/bin/grappa" probe

    [ "$(cat "$CWD_LOG")" != "/" ]
}

# ── The fix, on both branches ───────────────────────────────────────────────

@test "as root the release is exec'd from /, not the caller's cwd (#1267)" {
    # The reported path: `sudo grappa migrate` from a 0700 home. runuser -u
    # hands the child the caller's cwd, so without a cd in the wrapper the VM
    # boots on a directory it cannot search and dies in code_server.
    wrapper_as root migrate

    # Sanity token: an absent cd is indistinguishable from a wrapper that
    # never reached the release at all.
    grep -qx 'eval Grappa.Release.migrate()' "$CALL_LOG"

    [ "$(cat "$CWD_LOG")" = "/" ]
}

@test "as the grappa user the release is exec'd from / too (#1267)" {
    # The already-unprivileged branch has the same hole the moment someone
    # `su - grappa`s and cds into a directory another user owns. Fixing only
    # the branch the report came in on would leave the class open.
    wrapper_as grappa version

    grep -qx 'version' "$CALL_LOG"

    [ "$(cat "$CWD_LOG")" = "/" ]
}
