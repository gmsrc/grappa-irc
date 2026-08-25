#!/usr/bin/env bats
#
# Drift guard: every entrypoint that can launch a cicchetto build must derive
# the repo-root build facts and export them —
#
#   * GRAPPA_VERSION, from infra/packaging/version.sh (#538/#652);
#   * GRAPPA_CREDITS, from infra/packaging/credits.sh (#1773).
#
# ONE guard for both, not two files, for the reason the WHY below already
# gives: what can be shared is the CHECK, and a second file would carry a
# second copy of the roster — the drift this exists to catch. The filename
# still says "version" because two DESIGN_NOTES entries cite it by path
# (2026-07-… and later), and renaming it would falsify a historical record to
# buy a naming nicety.
#
# Both payloads travel the SAME channel and for the same measured reason: the
# cic build containers mount only ./cicchetto, so the repo root — VERSION file
# and git alike — is unreachable inside them. They differ in one place only,
# and it is deliberate: an unset GRAPPA_VERSION makes vite throw, while
# credits.sh cannot fail, because the AUR tarball and Dockerfile.release have
# no `.git` by construction (see that script's header).
#
# WHY a guard and not a shared helper: the derive+export pair is two lines, but
# it lives in bash (scripts/*.sh), POSIX sh (the FreeBSD jail, which has no bash
# port), a Dockerfile RUN layer and a PKGBUILD build() — no sourceable shim
# reaches all four, and infra/docker/deploy.sh is deliberately standalone (it
# does NOT source scripts/_lib.sh). What CAN be shared is the check: the cost of
# the duplication is drift, so the fix for drift is a test, not a tenth file.
#
# #692 is the incident this encodes: the installer (infra/docker/deploy.sh) was
# the one wrapper that never got the export, so since the guard landed in
# cicchetto/vite.config.ts every self-hosted `install` / `update` that reached a
# cic build died refusing to bake an empty <meta cicchetto-version>. Nothing in
# CI exercised that path, so it went unnoticed until a real box updated.
#
# Two halves, because neither alone is enough:
#   * the ROSTER pins the launchers we know about — it fails when someone
#     REMOVES an export from one of them;
#   * the SCAN discovers launchers by what they invoke — it fails when someone
#     ADDS a launcher and forgets the export, which is exactly #692.

setup() {
    REPO_SRC="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
}

# Every launcher, as of #692. A new one belongs here AND must export.
ROSTER=(
    scripts/bun.sh
    scripts/deploy-cic.sh
    # #1384 — the Docker substrate's cic launch moved out of both deploy
    # entry points into the ONE hook set they now share.
    infra/lib/deploy_docker.sh
    scripts/integration.sh
    scripts/testnet.sh
    infra/docker/deploy.sh
    infra/freebsd/jail_cic_build.sh
    infra/linux/cic_build.sh
    infra/packaging/build.sh
    infra/packaging/aur/PKGBUILD
    Dockerfile.release
)

# Comments are prose, not behaviour: version.sh's own header NAMES every
# carrier, and _lib.sh mentions cicchetto-build in a note. Matching them would
# make the guard lie in both directions, so strip trailing comments first.
#
# A `-v host:container` argument is data, not an invocation, for the same
# reason: it hands a path to a container, it does not launch anything. #1030
# added a `-v "$SRC_ROOT/cicchetto/e2e:…:ro"` overlay to scripts/_lib.sh, which
# made the `cicchetto/e2e` signal read a bind-mount as an e2e bring-up. The
# real drivers name the dir by ASSIGNMENT (`E2E_DIR="$SRC_ROOT/cicchetto/e2e"`
# in scripts/integration.sh + scripts/testnet.sh), so stripping mount specs
# leaves them caught — pinned by the two cases at the bottom of this file.
code_of() {
    sed -e 's/[[:space:]]*#.*$//' -e 's/-v "[^"]*"//g' -e 's/--volume "[^"]*"//g' "$1"
}

# Every predicate below feeds grep a HERE-STRING, never a pipe. A pipe into
# `grep -q` exits on the first hit and leaves sed mid-stream; where SIGPIPE is
# ignored (the disposition GitHub's runner hands a step) the write returns
# EPIPE and GNU sed reports it on stderr, which the `run` sites then folded
# into `$output` — the guard printed pipe noise instead of the launchers at
# fault, and a clean scan read as a failure. BSD sed is silent on EPIPE, so it
# only ever reddened CI. A here-string has no reader to close, so the condition
# cannot arise; `--separate-stderr` below closes the other half (any OTHER
# stderr, e.g. an unreadable candidate file, must not masquerade as a finding
# either).

# A launcher is a file whose CODE can reach a cic build. Five signals, because
# the launchers do not all name it the same way:
#   cicchetto-build   the compose service (substring: also cicchetto-build-test)
#   bun|npm run build the verb the bun/npm substrates run directly
#   --profile prod    the profile the compose oneshot is gated behind, so any
#                     `up` on it STARTS the build (not merely depends_on it)
#   cicchetto/e2e     the e2e stack, whose bring-up builds cicchetto-build-test
#                     (its drivers cd into the dir and run a bare `compose up`,
#                     so the service name never appears in their code)
#   oven/bun          the raw bun oneshot scripts/bun.sh runs by image
# Known limit: this reads text, so a launcher that resolves everything through
# variables can still hide. That is what ROSTER is for, and why the two halves
# cross-check each other below.
launches_cic_build() {
    grep -qE 'cicchetto-build|(bun|npm) run build|--profile prod|cicchetto/e2e|oven/bun' <<< "$(code_of "$1")"
}

# Compliance is BOTH halves, per payload. `export GRAPPA_VERSION=0.10.0` alone
# would pass an export-only check while planting a second hand-edited version
# carrier — exactly what the VERSION file is the single source of truth
# against; `export GRAPPA_CREDITS='{}'` would bake a hand-written empty roll,
# which is the #1773 failure with extra steps.
exports_var() {
    grep -q "export $2" <<< "$(code_of "$1")"
}

derives_from() {
    grep -q "$2" <<< "$(code_of "$1")"
}

exports_version() {
    exports_var "$1" GRAPPA_VERSION
}

derives_version() {
    derives_from "$1" 'version\.sh'
}

exports_credits() {
    exports_var "$1" GRAPPA_CREDITS
}

derives_credits() {
    derives_from "$1" 'credits\.sh'
}

complies() {
    derives_version "$1" && exports_version "$1" \
        && derives_credits "$1" && exports_credits "$1"
}

# The shell/build entrypoints a cic build can be launched from. compose files
# are excluded on purpose: they PASS THROUGH `GRAPPA_VERSION: ${GRAPPA_VERSION:-}`
# from the wrapper's environment, they never derive it.
candidate_files() {
    local root="$1"
    ls "$root"/scripts/*.sh 2>/dev/null || true
    if [ -d "$root/infra" ]; then
        find "$root/infra" -type f \( -name '*.sh' -o -name 'PKGBUILD' \) | sort
    fi
    if [ -f "$root/Dockerfile.release" ]; then
        printf '%s\n' "$root/Dockerfile.release"
    fi
}

# Echo every launcher under $1 that does not derive AND export GRAPPA_VERSION.
unexported_launchers() {
    local root="$1" f
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        launches_cic_build "$f" || continue
        complies "$f" && continue
        printf '%s\n' "${f#"$root"/}"
    done < <(candidate_files "$root")
}

# Echo every launcher the scan can SEE under $1, compliant or not.
discovered_launchers() {
    local root="$1" f
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        launches_cic_build "$f" || continue
        printf '%s\n' "${f#"$root"/}"
    done < <(candidate_files "$root")
}

@test "roster: every known cic-build launcher derives GRAPPA_VERSION from version.sh and exports it" {
    local missing=()
    for rel in "${ROSTER[@]}"; do
        local f="$REPO_SRC/$rel"
        [ -f "$f" ] || { missing+=("$rel (file is gone)"); continue; }
        derives_version "$f" || missing+=("$rel (no version.sh derive)")
        exports_version "$f" || missing+=("$rel (no export GRAPPA_VERSION)")
    done
    [ "${#missing[@]}" -eq 0 ] || {
        printf 'launchers that stopped deriving/exporting GRAPPA_VERSION:\n' >&2
        printf '  %s\n' "${missing[@]}" >&2
        return 1
    }
}

# Its own case, not a second pair of lines inside the one above: the two
# payloads fail independently, and a merged case would report "the roster is
# broken" without saying which fact went missing.
@test "roster: every known cic-build launcher derives GRAPPA_CREDITS from credits.sh and exports it (#1773)" {
    local missing=()
    for rel in "${ROSTER[@]}"; do
        local f="$REPO_SRC/$rel"
        [ -f "$f" ] || { missing+=("$rel (file is gone)"); continue; }
        derives_credits "$f" || missing+=("$rel (no credits.sh derive)")
        exports_credits "$f" || missing+=("$rel (no export GRAPPA_CREDITS)")
    done
    [ "${#missing[@]}" -eq 0 ] || {
        printf 'launchers that stopped deriving/exporting GRAPPA_CREDITS:\n' >&2
        printf '  %s\n' "${missing[@]}" >&2
        return 1
    }
}

@test "scan: no shell or build entrypoint launches a cic build without exporting BOTH build facts" {
    run --separate-stderr unexported_launchers "$REPO_SRC"
    [ "$status" -eq 0 ]
    # The scan's own errors are not findings, and must not pass silently
    # either — an unreadable candidate means the guard covered less than it
    # claims (see the stderr note above).
    [ -z "$stderr" ] || {
        printf 'the scan itself errored (coverage is incomplete):\n%s\n' "$stderr" >&2
        return 1
    }
    [ -z "$output" ] || {
        printf 'cic-build launchers with no GRAPPA_VERSION export (see #692):\n%s\n' "$output" >&2
        return 1
    }
}

@test "roster: every launcher the scan can see is on the roster" {
    run --separate-stderr discovered_launchers "$REPO_SRC"
    [ "$status" -eq 0 ]
    [ -z "$stderr" ] || {
        printf 'the scan itself errored (coverage is incomplete):\n%s\n' "$stderr" >&2
        return 1
    }

    local unrostered=() found
    while IFS= read -r found; do
        [ -n "$found" ] || continue
        local known=0 rel
        for rel in "${ROSTER[@]}"; do
            [ "$rel" = "$found" ] && known=1
        done
        [ "$known" -eq 1 ] || unrostered+=("$found")
    done <<< "$output"

    [ "${#unrostered[@]}" -eq 0 ] || {
        printf 'cic-build launchers missing from ROSTER (add them, see #692):\n' >&2
        printf '  %s\n' "${unrostered[@]}" >&2
        return 1
    }
}

@test "scan: RED — a launcher that hardcodes the version instead of deriving it is caught" {
    local fake="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$fake/scripts"
    # Compliant on the CREDITS axis on purpose, so this case can only fail for
    # the reason it names. A fixture missing both would report green-for-the-
    # wrong-reason the day the version half stopped being checked.
    cat > "$fake/scripts/ship-the-bundle.sh" <<'EOF'
#!/usr/bin/env bash
export GRAPPA_VERSION=0.10.0
GRAPPA_CREDITS="$(infra/packaging/credits.sh)"
export GRAPPA_CREDITS
docker compose --profile prod run --rm cicchetto-build
EOF

    run --separate-stderr unexported_launchers "$fake"
    [ "$status" -eq 0 ]
    [ "$output" = "scripts/ship-the-bundle.sh" ]
}

@test "scan: RED — a launcher that plumbs the version but forgets the credits is caught (#1773)" {
    local fake="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$fake/scripts"
    # The #1773 shape: fully compliant on the axis the guard already had, and
    # silently baking an EMPTY credit roll on the axis it did not.
    cat > "$fake/scripts/ship-the-bundle.sh" <<'EOF'
#!/usr/bin/env bash
GRAPPA_VERSION="$(infra/packaging/version.sh)"
export GRAPPA_VERSION
docker compose --profile prod run --rm cicchetto-build
EOF

    run --separate-stderr unexported_launchers "$fake"
    [ "$status" -eq 0 ]
    [ "$output" = "scripts/ship-the-bundle.sh" ]
}

# The pin for the GNU-sed EPIPE incident. Two conditions must BOTH hold to
# reproduce it, which is why it only ever fired on the CI runner:
#   * the signal matches near the top and megabytes of code follow, so an
#     early-exiting matcher closes the pipe with the writer mid-stream;
#   * SIGPIPE is IGNORED, so sed is not killed silently — the write returns
#     EPIPE and GNU sed reports it on stderr. GitHub's runner hands steps that
#     disposition; an interactive shell does not, which is why this passed
#     locally and reddened in CI.
# `trap '' PIPE` reproduces the runner's disposition, so the pin holds on every
# platform. It asserts the SCAN IS SILENT (empty stderr) as well as exact — a
# reader that abandons its writer is caught even though `--separate-stderr` now
# keeps the noise out of the finding itself.
@test "scan: a launcher larger than the pipe buffer yields a clean diagnostic" {
    local fake="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$fake/scripts"
    {
        printf '#!/usr/bin/env bash\n'
        printf 'docker compose --profile prod run --rm cicchetto-build\n'
        yes 'echo padding past the pipe buffer' | head -40000
    } > "$fake/scripts/ship-the-bundle.sh"

    # AFTER the fixture: `yes | head` is itself an early-exiting pipeline, so
    # arming the trap first would make the generator the thing that complains.
    trap '' PIPE

    run --separate-stderr unexported_launchers "$fake"
    [ "$status" -eq 0 ]
    [ -z "$stderr" ]
    [ "$output" = "scripts/ship-the-bundle.sh" ]
}

@test "scan: RED — a new launcher that forgets the export is caught" {
    local fake="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$fake/scripts"
    cat > "$fake/scripts/ship-the-bundle.sh" <<'EOF'
#!/usr/bin/env bash
docker compose --profile prod run --rm cicchetto-build
EOF

    run --separate-stderr unexported_launchers "$fake"
    [ "$status" -eq 0 ]
    [ "$output" = "scripts/ship-the-bundle.sh" ]
}

@test "scan: GREEN — the same launcher passes once it derives and exports" {
    local fake="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$fake/scripts"
    cat > "$fake/scripts/ship-the-bundle.sh" <<'EOF'
#!/usr/bin/env bash
GRAPPA_VERSION="$(infra/packaging/version.sh)"
export GRAPPA_VERSION
GRAPPA_CREDITS="$(infra/packaging/credits.sh)"
export GRAPPA_CREDITS
docker compose --profile prod run --rm cicchetto-build
EOF

    run --separate-stderr unexported_launchers "$fake"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "scan: a bind-mount of the e2e dir is data, not a launcher" {
    local fake="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$fake/scripts"
    cat > "$fake/scripts/_lib.sh" <<'EOF'
#!/usr/bin/env bash
WORKTREE_VOLUMES=(
    -v "$SRC_ROOT/cicchetto/e2e:/app/cicchetto/e2e:ro"
)
EOF

    run --separate-stderr discovered_launchers "$fake"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "scan: RED — mounting the e2e dir does not hide a build in the same file" {
    local fake="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$fake/scripts"
    cat > "$fake/scripts/_lib.sh" <<'EOF'
#!/usr/bin/env bash
WORKTREE_VOLUMES=(
    -v "$SRC_ROOT/cicchetto/e2e:/app/cicchetto/e2e:ro"
)
docker compose --profile prod run --rm cicchetto-build
EOF

    run --separate-stderr unexported_launchers "$fake"
    [ "$status" -eq 0 ]
    [ "$output" = "scripts/_lib.sh" ]
}

@test "scan: naming the e2e dir by assignment is still a launcher" {
    local fake="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$fake/scripts"
    cat > "$fake/scripts/integration.sh" <<'EOF'
#!/usr/bin/env bash
E2E_DIR="$SRC_ROOT/cicchetto/e2e"
cd "$E2E_DIR" && docker compose up -d
EOF

    run --separate-stderr unexported_launchers "$fake"
    [ "$status" -eq 0 ]
    [ "$output" = "scripts/integration.sh" ]
}
