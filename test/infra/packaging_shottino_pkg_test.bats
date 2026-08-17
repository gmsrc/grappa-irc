#!/usr/bin/env bats
#
# Bats suite for GH #1447 slice A — shottino gets its OWN nfpm config, built
# and proven on every packaging job but NOT published yet.
#
# Slice A is deliberately additive: `grappa` still ships /usr/bin/shottino, so
# the two packages both own that path and CANNOT be co-installed. That makes
# "the standalone package does not reach the release" the load-bearing property
# of this slice, and it is the first thing pinned below.
#
# THE HAZARD, MEASURED — and not where the first reading put it.
#
# `infra/packaging/release_assets.sh` matches release assets by NAME AT ANY
# DEPTH (`found()`: `find "$dir" -type f -name '*.deb'`), so it was the obvious
# suspect. It is not the gatekeeper: it only ever sees what the `publish` job
# DOWNLOADED. The real gate is one step earlier — the upload globs are
# PATH-scoped (`path: dist/*.deb`, `path: dist/*.rpm`), so a package written
# outside `dist/` is never uploaded, never downloaded, and never attached.
# That is why a separate output directory is the cure, and why this suite
# derives the forbidden directories FROM the workflow instead of naming `dist`.
#
# The other three properties are the ones that make the package a CLIENT
# package rather than a second copy of the bouncer: its own version line, one
# file, no maintainer scripts, no ERTS deps.
#
# Every derivation carries a floor — a derivation that matched nothing would
# make its assertion pass vacuously.

load ../bats_helpers

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
    PKG_DIR="$REPO_ROOT/infra/packaging"
    NFPM_SERVER="$PKG_DIR/nfpm.yaml"
    NFPM_CLIENT="$PKG_DIR/nfpm-shottino.yaml"
    VERSION_SH="$PKG_DIR/version.sh"
    BUILD_SH="$PKG_DIR/build.sh"
    WORKFLOW="$REPO_ROOT/.github/workflows/release.yml"
    VERSION_H="$REPO_ROOT/frontends/shottino/version.h"
}

# The `contents:` block of an nfpm config: from `contents:` to the next
# top-level key. Top-level keys sit at column 0, everything inside is deeper.
contents_block() {
    awk '/^contents:/ { f = 1; next } f && /^[a-z]/ { exit } f' "$1"
}

# Every `dst:` a config installs, one per line.
installed_paths() {
    contents_block "$1" | sed -n 's/^[[:space:]]*dst:[[:space:]]*//p'
}

# The directories the release workflow UPLOADS from — the dirname of every
# `path:` under an upload-artifact step. These are the directories a build
# output must stay out of to remain unpublished.
upload_dirs() {
    awk '
        /uses: actions\/upload-artifact/ { hit = 1 }
        hit && /^[[:space:]]+path:[[:space:]]/ {
            sub(/^[[:space:]]+path:[[:space:]]*/, "")
            sub(/\/[^\/]*$/, "")
            print
            hit = 0
        }
    ' "$WORKFLOW" | sort -u
}

# ── The slice's load-bearing property ──────────────────────────────────────

@test "#1447 the workflow's upload globs are path-scoped, so a directory can hide from the release" {
    # The floor for the test below: if this derivation found nothing, "the
    # client package is built outside every upload dir" would hold vacuously.
    run upload_dirs
    [ "$status" -eq 0 ]
    [ -n "$output" ]
    [ "$(printf '%s\n' "$output" | wc -l)" -ge 2 ]
}

@test "#1447 the client package is written outside every directory the release uploads" {
    grep -q 'SHOTTINO_OUT_DIR' "$BUILD_SH"

    client_out="$(sed -n 's/^SHOTTINO_OUT_DIR="\${SHOTTINO_OUT_DIR:-\${REPO_ROOT}\/\(.*\)}"$/\1/p' "$BUILD_SH")"
    [ -n "$client_out" ]

    while IFS= read -r dir; do
        [ "$dir" != "$client_out" ]
    done < <(upload_dirs)
}

# ── Its own version line, derived from the header ──────────────────────────

@test "#1447 version.sh with no argument still prints the repo VERSION" {
    # The FreeBSD jail build calls this bare (infra/freebsd/jail_cic_build.sh).
    # Making the new mode the default would break it silently.
    run "$VERSION_SH"
    [ "$status" -eq 0 ]
    [ "$output" = "$(head -1 "$REPO_ROOT/VERSION" | tr -d '\r')" ]
}

@test "#1447 version.sh shottino prints the version line from version.h" {
    # DERIVED from the header, never re-typed here: a suite that hard-coded
    # 0.3.0 would need editing on every client release and would pin nothing.
    from_header="$(sed -n 's/^#define SHOTTINO_VERSION "\(.*\)"$/\1/p' "$VERSION_H")"
    [ -n "$from_header" ]

    run "$VERSION_SH" shottino
    [ "$status" -eq 0 ]
    [ "$output" = "$from_header" ]
}

@test "#1447 the client package does not take the bouncer's version" {
    # Two artifacts, two cadences (vjt, 2026-08-16). The config must reach for
    # the shottino line, not GRAPPA_VERSION.
    grep -q '^version: \${SHOTTINO_VERSION}$' "$NFPM_CLIENT"
    refute grep -q '^version: \${GRAPPA_VERSION}$' "$NFPM_CLIENT"
}

# ── A client package, not a second bouncer ─────────────────────────────────

@test "#1447 the client package is named shottino, not grappa" {
    grep -q '^name: shottino$' "$NFPM_CLIENT"
}

@test "#1447 the client package ships exactly one file, the client binary" {
    run installed_paths "$NFPM_CLIENT"
    [ "$status" -eq 0 ]
    [ "$output" = "/usr/bin/shottino" ]
}

@test "#1447 the client package runs no maintainer scripts" {
    # The server package's postinstall creates a system user, generates
    # secrets and enables a unit. A terminal client must do none of that —
    # installing it must not enable a service the user did not ask for.
    grep -q '^scripts:' "$NFPM_SERVER"
    refute grep -q '^scripts:' "$NFPM_CLIENT"
}

@test "#1447 the client package carries none of the bouncer-only dependencies" {
    # Derived from the server config, not re-typed: these are the entries that
    # exist for ERTS or for the maintainer scripts. If the client config grows
    # one, it has stopped being a client package.
    server_only=(libncurses6 libstdc++6 libgcc-s1 passwd shadow-utils util-linux)
    for dep in "${server_only[@]}"; do
        grep -qF -- "- $dep" "$NFPM_SERVER"
        refute grep -qF -- "- $dep" "$NFPM_CLIENT"
    done
}

@test "#1447 the client package depends on the wide ncurses and on OpenSSL" {
    # configure probes exactly these two (`check_pkg ncursesw`,
    # `check_pkg openssl`), and shottino.c calls
    # SSL_CTX_set_default_verify_paths + SSL_VERIFY_PEER, so the system CA
    # store is a runtime dependency and not a copied one.
    grep -qF -- '- libncursesw6' "$NFPM_CLIENT"
    grep -qF -- '- ca-certificates' "$NFPM_CLIENT"
    grep -qE '^\s+- libssl3t64 \| libssl3$' "$NFPM_CLIENT"
    grep -qF -- '- ncurses-libs' "$NFPM_CLIENT"
    grep -qF -- '- openssl-libs' "$NFPM_CLIENT"
}

# ── The path takeover, written literally ───────────────────────────────────

@test "#1447 the takeover names grappa 1.3.0 in each format's own relation syntax" {
    # vjt's ruling, 2026-08-17: the boundary is the first release that stops
    # shipping the file. A historical constant, written as a constant.
    #
    # Deb and RPM SPELL a relation differently and `replaces` reaches both, so
    # it is written per-format. The Debian spelling is what deb.breaks and
    # overrides.deb.replaces carry; overrides.rpm.replaces carries the rpm one.
    [ "$(grep -cF -- '- grappa (<< 1.3.0)' "$NFPM_CLIENT")" -eq 2 ]
    [ "$(grep -cF -- '- grappa < 1.3.0' "$NFPM_CLIENT")" -eq 1 ]
    grep -q '^  breaks:$' "$NFPM_CLIENT"
}

@test "#1447 no Debian-spelled relation is offered to the rpm renderer" {
    # This is the one that would have shipped silently. nfpm maps `replaces` to
    # RPM's Obsoletes: (rpm/rpm.go:289) through rpmpack, whose parser is
    # `([^=<>\s]*)\s*((?:=|>|<)*)\s*(.*)?` (rpmpack/sense.go:24). Given
    # `grappa (<< 1.3.0)` the operator group matches EMPTY — `(` is not an
    # operator — so it yields name `grappa`, version `(<< 1.3.0)`, sense `""`;
    # and `""` is a legal key for SenseAny, so NOTHING errors. Green build,
    # garbage metadata. Hence: no parenthesised relation under overrides.rpm.
    rpm_block="$(awk '/^  rpm:/ { f = 1; next } f && /^  [a-z]/ { exit } f' "$NFPM_CLIENT")"
    [ -n "$rpm_block" ]
    grep -q 'grappa' <<<"$rpm_block"
    refute grep -q '((<<|>>))' <<<"$rpm_block"
    refute grep -qF '(<<' <<<"$rpm_block"
}

@test "#1447 the takeover relations are literal, never interpolated" {
    # Not a restatement of the constants above — its own failure mode. nfpm
    # v2.43.0 expands ${VARS} in depends/replaces/recommends/provides/suggests/
    # conflicts (nfpm.go:214-227) and NOT in deb.breaks (the Deb struct,
    # nfpm.go:438), so an interpolation there is written into the control file
    # verbatim. Every relation naming grappa holds no `$`, ever.
    takeover="$(grep -E '^[[:space:]]*- grappa[ (]' "$NFPM_CLIENT")"
    [ -n "$takeover" ]
    [ "$(printf '%s\n' "$takeover" | wc -l)" -eq 3 ]
    refute grep -q '\$' <<<"$takeover"
}
