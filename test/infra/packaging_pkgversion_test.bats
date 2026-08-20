#!/usr/bin/env bats
#
# Bats suite for GH #1594 — the package VERSION field is nfpm's, not ours, and
# the release pipeline never checked it.
#
# TWO properties, one root. Cutting `v1.3.0-rc1` made both visible at once.
#
#   1. nfpm RESTAMPS a pre-release. `1.3.0-rc1` in the VERSION file becomes
#      `1.3.0~rc1` in the .deb `Version:` field and in the .rpm `Version` of
#      the NEVRA. The string the resolvers compare is therefore NOT the string
#      the repo carries, and `~` sorts BELOW the empty string in both dpkg and
#      rpm ordering.
#   2. NOTHING in the pipeline noticed. Both existing version proofs
#      (`release.yml` deb + rpm) compared against `version.sh shottino` — the
#      CLIENT's carrier, `frontends/shottino/version.h`, which a grappa bump
#      does not touch. The bouncer package's stamped number had no assertion
#      at all, in either format.
#
# So `pkgversion.sh` exists to answer, in ONE place, "what does nfpm stamp for
# this component in this format", and both jobs assert every package against
# it. The map is MEASURED, not derived — see docs/DESIGN_NOTES.md #1594 for
# the nfpm 2.43.0 table these rows reproduce. This suite pins the transform;
# the measurement is what says the transform is the right one.

load ../bats_helpers

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
    PKG_DIR="$REPO_ROOT/infra/packaging"
    PKGVERSION="$PKG_DIR/pkgversion.sh"
    WORKFLOW="$REPO_ROOT/.github/workflows/release.yml"

    # A sandbox repo carrying BOTH version carriers, so a case can set the
    # version to any shape in the measured table without touching the real
    # tree. pkgversion.sh delegates to version.sh, and version.sh derives the
    # repo root from its own $0 — so the copies must sit at the same relative
    # depth as the originals.
    SANDBOX="$BATS_TEST_TMPDIR/sandbox"
    mkdir -p "$SANDBOX/infra/packaging" "$SANDBOX/frontends/shottino"
    cp "$PKG_DIR/version.sh" "$PKGVERSION" "$SANDBOX/infra/packaging/"
    chmod +x "$SANDBOX/infra/packaging/"*.sh
    SANDBOX_PKGVERSION="$SANDBOX/infra/packaging/pkgversion.sh"
    # The FLOOR. Without it the two refusal cases below are satisfied by a
    # missing script (exit 127 is also non-zero), and would report green
    # against a sandbox that holds nothing.
    [ -x "$SANDBOX_PKGVERSION" ]
}

# Set the sandbox's bouncer version and echo what pkgversion.sh makes of it.
sandbox_maps() { # $1 = VERSION file content, $2 = format
    printf '%s\n' "$1" > "$SANDBOX/VERSION"
    "$SANDBOX_PKGVERSION" "$2" grappa
}

# ── The map, row by row against the measured nfpm 2.43.0 table ─────────────

@test "#1594 deb: the first hyphen becomes a tilde, and nothing else moves" {
    # Measured with the pinned nfpm 2.43.0 (the version build.sh downloads)
    # against a minimal config, reading `dpkg-deb -f <pkg> Version` off the
    # artefact. Every row here is one row of that table.
    [ "$(sandbox_maps '1.3.0-rc1' deb)" = '1.3.0~rc1' ]
    [ "$(sandbox_maps '1.3.0-rc.1' deb)" = '1.3.0~rc.1' ]
    [ "$(sandbox_maps '1.3.0-rc-1' deb)" = '1.3.0~rc-1' ]
    [ "$(sandbox_maps '1.3.0+foo' deb)" = '1.3.0+foo' ]
    [ "$(sandbox_maps '1.3.0-rc1+foo' deb)" = '1.3.0~rc1+foo' ]
}

@test "#1594 rpm: same tilde, and every FURTHER hyphen becomes an underscore" {
    # The one row where the two formats disagree, and the reason the script
    # takes a format rather than answering once: rpm forbids `-` in Version
    # (it is the Version/Release separator), so nfpm rewrites the leftovers.
    # `1.3.0-rc-1` -> deb `1.3.0~rc-1`, rpm `1.3.0~rc_1`. Measured, not read.
    [ "$(sandbox_maps '1.3.0-rc1' rpm)" = '1.3.0~rc1' ]
    [ "$(sandbox_maps '1.3.0-rc.1' rpm)" = '1.3.0~rc.1' ]
    [ "$(sandbox_maps '1.3.0-rc-1' rpm)" = '1.3.0~rc_1' ]
    [ "$(sandbox_maps '1.3.0+foo' rpm)" = '1.3.0+foo' ]
    [ "$(sandbox_maps '1.3.0-rc1+foo' rpm)" = '1.3.0~rc1+foo' ]
}

@test "#1594 a bare X.Y.Z passes through untouched, in both formats" {
    # The POSITIVE CONTROL of the whole issue. Every tag before v1.3.0-rc1 was
    # a bare release, so if this row moved, the map would be rewriting history
    # that nfpm never rewrote — and the gate built on it would fail every
    # ordinary cut.
    [ "$(sandbox_maps '1.3.0' deb)" = '1.3.0' ]
    [ "$(sandbox_maps '1.3.0' rpm)" = '1.3.0' ]
    [ "$(sandbox_maps '0.9.11' deb)" = '0.9.11' ]
    [ "$(sandbox_maps '0.9.11' rpm)" = '0.9.11' ]
}

@test "#1594 the client component reads its OWN carrier, mapped the same way" {
    # Two artifacts, two cadences (#1447). The mapping is a property of nfpm,
    # not of which file the number came from, so the client goes through the
    # same door — today its line is bare and the map is the identity, which is
    # exactly why routing it here now costs nothing and covers it later.
    printf '1.3.0\n' > "$SANDBOX/VERSION"
    printf '#define SHOTTINO_VERSION "0.4.0-rc2"\n' > "$SANDBOX/frontends/shottino/version.h"

    [ "$("$SANDBOX_PKGVERSION" deb shottino)" = '0.4.0~rc2' ]
    [ "$("$SANDBOX_PKGVERSION" rpm shottino)" = '0.4.0~rc2' ]
}

# ── It refuses rather than guessing ────────────────────────────────────────

@test "#1594 an unknown format, an unknown component or a missing argument refuses" {
    # No defaulting. A gate whose oracle silently answers for the wrong format
    # is worse than no gate: it would compare a .rpm against the deb spelling
    # and pass on every version that has no hyphen — which is every version
    # the repo has ever cut except one.
    printf '1.3.0\n' > "$SANDBOX/VERSION"

    run "$SANDBOX_PKGVERSION" apk grappa
    [ "$status" -ne 0 ]

    run "$SANDBOX_PKGVERSION" deb cicchetto
    [ "$status" -ne 0 ]

    run "$SANDBOX_PKGVERSION" deb
    [ "$status" -ne 0 ]

    run "$SANDBOX_PKGVERSION"
    [ "$status" -ne 0 ]
}

@test "#1594 an unreadable carrier fails loudly instead of echoing an empty version" {
    # An empty expected value would make the CI comparison pass against an
    # equally empty `dpkg-deb -f` on a missing file — two silences agreeing.
    rm -f "$SANDBOX/VERSION"

    run "$SANDBOX_PKGVERSION" deb grappa
    [ "$status" -ne 0 ]
    # And it prints no version-shaped line a caller could mistake for one.
    refute grep -qE '^[0-9]+\.[0-9]+\.[0-9]+' <<<"$output"
}

# ── The pipeline actually uses it, for BOTH packages, in BOTH jobs ─────────

@test "#1594 every package-version proof in the release workflow goes through pkgversion.sh" {
    # The buco this issue names: before it, the two version proofs that existed
    # both read `version.sh shottino`, so a restamp of the BOUNCER's number was
    # unobservable. Four proofs now — bouncer and client, deb and rpm — and
    # each one derives its expected value here.
    [ "$(grep -cF 'pkgversion.sh deb grappa' "$WORKFLOW")" -eq 1 ]
    [ "$(grep -cF 'pkgversion.sh rpm grappa' "$WORKFLOW")" -eq 1 ]
    [ "$(grep -cF 'pkgversion.sh deb shottino' "$WORKFLOW")" -eq 1 ]
    [ "$(grep -cF 'pkgversion.sh rpm shottino' "$WORKFLOW")" -eq 1 ]
}

@test "#1594 the only surviving raw-carrier proof is the Arch one, whose map is not nfpm's" {
    # `version.sh shottino` was the OLD oracle for BOTH nfpm proofs. It answers
    # "what does version.h say" and not "what did nfpm stamp"; leaving one
    # behind would restore the gap for that format only, which is the shape
    # that hid it for three releases.
    #
    # The `arch` job keeps it, and that is not an oversight: makepkg has its
    # own `pkgver` rules — it REFUSES a hyphen outright rather than re-spelling
    # it (#1591) — so routing it through an nfpm-shaped map would assert a
    # transform pacman never performs. Derived, not asserted by eye: the one
    # remaining call is inside the arch job's line range.
    hits="$(grep -nE 'packaging/version\.sh (grappa|shottino)' "$WORKFLOW" | cut -d: -f1)"
    [ "$(printf '%s\n' "$hits" | grep -c .)" -eq 1 ]

    arch_start="$(grep -n '^  arch:$' "$WORKFLOW" | cut -d: -f1)"
    [ -n "$arch_start" ]
    # The next top-level job key after `arch:` bounds the block.
    arch_end="$(awk -v s="$arch_start" 'NR > s && /^  [a-z][a-z0-9_-]*:$/ { print NR; exit }' "$WORKFLOW")"
    [ -n "$arch_end" ]

    [ "$hits" -gt "$arch_start" ]
    [ "$hits" -lt "$arch_end" ]
}

@test "#1594 the bouncer package's stamped version is read off the ARTEFACT, per format" {
    # Same discipline as every other proof in those jobs: assert on the built
    # package, not on the tree that produced it. `Grappa.Version.current()` is
    # already proved elsewhere and is a DIFFERENT claim — it is the number the
    # BEAM reports, which nfpm never touches.
    grep -qF 'dpkg-deb -f "$deb" Version' "$WORKFLOW"
    grep -qF "rpm -qp --queryformat '%{VERSION}'" "$WORKFLOW"
}
