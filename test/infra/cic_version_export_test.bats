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

# A launcher is a file that NAMES a cic build: the compose service, or the
# package-manager verb the bun/npm substrates run.
launches_cic_build() {
    code_of "$1" | grep -qE 'cicchetto-build|(bun|npm) run build'
}

exports_version() {
    code_of "$1" | grep -q 'export GRAPPA_VERSION'
}

derives_version() {
    code_of "$1" | grep -q 'version\.sh'
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

# Echo every launcher under $1 that does NOT export GRAPPA_VERSION.
unexported_launchers() {
    local root="$1" f
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        launches_cic_build "$f" || continue
        exports_version "$f" && continue
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
