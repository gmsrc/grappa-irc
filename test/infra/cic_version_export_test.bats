#!/usr/bin/env bats
#
# Drift guard: every entrypoint that can launch a cicchetto build must derive
# GRAPPA_VERSION from the repo-root VERSION file and export it (#538/#652).
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
    scripts/deploy.sh
    scripts/deploy-cic.sh
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
code_of() {
    sed -e 's/[[:space:]]*#.*$//' "$1"
}

# Every predicate below pipes `code_of` into grep and DISCARDS the match rather
# than using `grep -q`. `-q` exits on the first hit, which SIGPIPEs the sed
# upstream; GNU sed then prints `couldn't write N items to stdout: Broken pipe`
# on stderr (BSD sed stays silent, so this only ever reddened CI). bats' `run`
# folds stderr into `$output`, so that noise BECAME the diagnostic: the guard
# reported pipe errors instead of the launchers at fault, and a clean scan read
# as a failure. Only files larger than the pipe buffer trip it, which is why
# the synthetic fixtures below never showed it. Reading the stream to EOF costs
# nothing on files this size and keeps the diagnostic honest.

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
    code_of "$1" | grep -E 'cicchetto-build|(bun|npm) run build|--profile prod|cicchetto/e2e|oven/bun' > /dev/null
}

# Compliance is BOTH halves. `export GRAPPA_VERSION=0.10.0` alone would pass an
# export-only check while planting a second hand-edited version carrier —
# exactly what the VERSION file is the single source of truth against.
exports_version() {
    code_of "$1" | grep 'export GRAPPA_VERSION' > /dev/null
}

derives_version() {
    code_of "$1" | grep 'version\.sh' > /dev/null
}

complies() {
    derives_version "$1" && exports_version "$1"
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

@test "scan: no shell or build entrypoint launches a cic build without exporting GRAPPA_VERSION" {
    run unexported_launchers "$REPO_SRC"
    [ "$status" -eq 0 ]
    [ -z "$output" ] || {
        printf 'cic-build launchers with no GRAPPA_VERSION export (see #692):\n%s\n' "$output" >&2
        return 1
    }
}

@test "roster: every launcher the scan can see is on the roster" {
    run discovered_launchers "$REPO_SRC"
    [ "$status" -eq 0 ]

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
    cat > "$fake/scripts/ship-the-bundle.sh" <<'EOF'
#!/usr/bin/env bash
export GRAPPA_VERSION=0.10.0
docker compose --profile prod run --rm cicchetto-build
EOF

    run unexported_launchers "$fake"
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
# `trap '' PIPE` reproduces the runner's disposition here, so the pin holds on
# every platform. The assertion is EQUALITY with the filename — a diagnostic
# carrying one extra line of pipe noise is a diagnostic that lies.
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

    run unexported_launchers "$fake"
    [ "$status" -eq 0 ]
    [ "$output" = "scripts/ship-the-bundle.sh" ]
}

@test "scan: RED — a new launcher that forgets the export is caught" {
    local fake="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$fake/scripts"
    cat > "$fake/scripts/ship-the-bundle.sh" <<'EOF'
#!/usr/bin/env bash
docker compose --profile prod run --rm cicchetto-build
EOF

    run unexported_launchers "$fake"
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
docker compose --profile prod run --rm cicchetto-build
EOF

    run unexported_launchers "$fake"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}
