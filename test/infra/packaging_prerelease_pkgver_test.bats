#!/usr/bin/env bats
#
# Bats suite for GH #1591 — a pre-release `VERSION` must build the Arch
# package, and the package it builds must sort BELOW the final release it
# precedes.
#
# `makepkg` refuses a hyphen in `pkgver` (measured: rc=12,
# "pkgver is not allowed to contain colons, forward slashes, hyphens or
# whitespace", from its own lint at
# /usr/share/makepkg/lint_pkgbuild/pkgver.sh — `[[ $ver = *[[:space:]/:-]* ]]`).
# `VERSION` is semver and feeds mix.exs + the OTP application vsn, so the
# hyphen cannot be spelled away upstream: the transformation belongs at the
# `pkgver` boundary, where makepkg's constraint lives. That boundary is
# `infra/packaging/aur/pkgver.sh`, and this suite is its contract.
#
# THE SPELLING IS NOT FREE, and the reason is measured rather than argued.
# `vercmp <candidate> 1.3.0`, on pacman 7.1.0:
#
#     1.3.0rc1   -1   the pre-release is OLDER  ← the only correct one
#     1.3.0_rc1  +1    "     "         NEWER
#     1.3.0.rc1  +1
#     1.3.0+rc1  +1
#     1.3.0~rc1  +1
#
# All five BUILD (rc=0). Only the separator-less one orders right, and
# pacman's own comparator says why: its segment loop is
# `while (*one && *two) { skip separators; ... }`, so when the shorter side
# runs out the loop exits AT THE CONDITION and the separator is never
# skipped; the tie-break that follows is `isalpha(*one) → -1`
# (lib/libalpm/version.c, "we never want a remaining alpha string to beat an
# empty string"). A letter left over means older; a separator left over
# means newer. Hence: delete the hyphen, join nothing in its place.
#
# The same measurement is why the mapping is FAIL-CLOSED rather than
# best-effort. `1.3.0-1` is legal semver that sorts below `1.3.0`, but its
# mapping `1.3.01` leaves a DIGIT at the tie-break and measures +1 — it would
# publish a pre-release that outranks its own release. There is no spelling
# that saves it, so the mapper refuses it instead of shipping it.
#
# Scope: the mapping + its refusals (pure string logic, no Arch needed), and
# the two structural facts the mapping forces on the recipes — the tag is no
# longer spelled `${pkgver}`, and the release job now asserts the number it
# derived actually reached the built package.

load ../bats_helpers

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
    PKG_DIR="$REPO_ROOT/infra/packaging"
    PKGVER_SH="$PKG_DIR/aur/pkgver.sh"
    REGEN="$PKG_DIR/aur/regen.sh"
    PKGBUILD="$PKG_DIR/aur/PKGBUILD"
    SRCINFO="$PKG_DIR/aur/.SRCINFO"
    WORKFLOW="$REPO_ROOT/.github/workflows/release.yml"
}

# The `arch` job of release.yml, from its key to the next top-level job key.
# Read off the JOB, never the whole file: release.yml also builds deb, rpm and
# docker, and a whole-file grep would be satisfied by any of their steps.
arch_job() {
    awk '/^  arch:/ { f = 1; next } f && /^  [a-z]/ { exit } f' "$WORKFLOW"
}

# ── The mapping ─────────────────────────────────────────────────────────────

@test "#1591 a bare X.Y.Z passes through byte-for-byte" {
    # The identity case is load-bearing, not a formality: every one of the 23
    # tags cut so far is bare, so a mapper that touched them would restamp the
    # whole release history's worth of package names for a case that has never
    # occurred.
    for v in 0.1.0 1.2.0 1.3.0 10.20.30; do
        run "$PKGVER_SH" "$v"
        [ "$status" -eq 0 ]
        [ "$output" = "$v" ]
    done
}

@test "#1591 the hyphen makepkg refuses is deleted, and nothing is put in its place" {
    run "$PKGVER_SH" 1.3.0-rc1
    [ "$status" -eq 0 ]
    [ "$output" = "1.3.0rc1" ]
}

@test "#1591 no mapped pkgver carries a character makepkg's lint refuses" {
    # The refused class is makepkg's own bracket expression, transcribed:
    # `[[ $ver = *[[:space:]/:-]* ]]` in lint_pkgbuild/pkgver.sh.
    for v in 1.3.0 1.3.0-rc1 1.3.0-rc.1 1.3.0-alpha1 1.3.0-beta.2 1.3.0-rc1+deadbeef; do
        run "$PKGVER_SH" "$v"
        [ "$status" -eq 0 ]
        [ -n "$output" ]
        refute grep -qE '[[:space:]/:-]' <<<"$output"
    done
}

@test "#1591 what is left after the numeric core is a LETTER — the tie-break vercmp reads" {
    # THE ordering property, expressed as the shape pacman's comparator keys
    # on rather than as a vercmp call: bats runs on the host, where there is
    # no pacman. The container measurement behind this rule is in the header;
    # the release job re-checks it with the real vercmp on a real Arch box.
    for v in 1.3.0-rc1 1.3.0-rc.1 1.3.0-alpha1 1.3.0-beta.2 1.3.0-rc1+deadbeef; do
        run "$PKGVER_SH" "$v"
        [ "$status" -eq 0 ]
        # Strip the leading numeric core (digits and dots); what remains is
        # what the comparator is left holding once the final release's
        # segments run out.
        rest="$(sed -E 's/^[0-9.]+//' <<<"$output")"
        [ -n "$rest" ]
        grep -qE '^[A-Za-z]' <<<"$rest"
    done
}

@test "#1591 a numeric-leading pre-release is REFUSED — its mapping would outrank the release" {
    # `1.3.0-1` is legal semver and sorts BELOW `1.3.0`; `1.3.01` measures +1.
    # Fail closed: refuse to derive a number rather than publish one that
    # inverts the upgrade path.
    for v in 1.3.0-1 1.3.0-0.1 1.3.0-1rc; do
        run "$PKGVER_SH" "$v"
        # The refusal's OWN exit code, not merely non-zero: an absent script
        # exits 127 and would satisfy `-ne 0` while proving nothing.
        [ "$status" -eq 2 ]
        grep -qi 'letter' <<<"$output"
    done
}

@test "#1591 an empty or missing version is refused, never mapped to the empty string" {
    # makepkg's lint rejects an empty pkgver too ("is not allowed to be
    # empty"), but at release time, in CI, on a tag. Refuse here.
    run "$PKGVER_SH"
    [ "$status" -eq 2 ]

    run "$PKGVER_SH" ""
    [ "$status" -eq 2 ]
}

# ── What the mapping forces on the recipes ─────────────────────────────────

@test "#1591 regen.sh derives BOTH recipes' pkgver through the mapper" {
    # The client carrier can grow a pre-release exactly the same way the
    # bouncer's did. One mapper, both numbers — a second recipe that skipped
    # it would fail at makepkg, at release time, on a tag.
    grep -qF 'pkgver.sh' "$REGEN"
    # Two derivations, both mapped: the bouncer's and the client's.
    [ "$(grep -cF 'pkgver.sh' "$REGEN")" -ge 2 ]
}

@test "#1591 the bouncer recipe names the TAG through _grappaver, not through pkgver" {
    # Once pkgver may differ from VERSION, every `v${pkgver}` in the recipe is
    # a tag that was never cut. The client recipe has carried `_grappaver` for
    # this reason since #1447; the bouncer needs it for the same reason now,
    # and `regen.sh`'s `_grappaver` sed — a deliberate no-op on this file until
    # today — becomes live.
    grep -qx '_grappaver=@GRAPPA_VERSION@' "$PKGBUILD"
    grep -qx 'pkgver=@GRAPPA_VERSION@' "$PKGBUILD"

    # The two places a tag is spelled. Read off the declarations, not the
    # file: the recipe discusses pkgver at length in prose.
    src_line="$(grep -E '^source=' "$PKGBUILD")"
    srcdir_line="$(grep -E '^_srcdir=' "$PKGBUILD")"
    [ -n "$src_line" ]
    [ -n "$srcdir_line" ]
    grep -qF '${_grappaver}' <<<"$src_line"
    grep -qF '${_grappaver}' <<<"$srcdir_line"
    refute grep -qF 'v${pkgver}' <<<"$src_line"
    refute grep -qF '${pkgver}' <<<"$srcdir_line"
}

@test "#1591 the committed bouncer .SRCINFO agrees that the source is the TAG" {
    # .SRCINFO is regenerated by `makepkg --printsrcinfo`, which does not run
    # on this host — but the committed template must not claim the tarball is
    # named after a pkgver that can now differ from the tag.
    [ -f "$SRCINFO" ]
    grep -qE '^[[:space:]]*pkgver = @GRAPPA_VERSION@$' "$SRCINFO"
    grep -qE '^[[:space:]]*source = .*tags/v@GRAPPA_VERSION@\.tar\.gz$' "$SRCINFO"
}

# ── The hole the issue names: nothing asserted grappa's own package number ──

@test "#1591 the arch job asserts the DERIVED pkgver actually reached the built package" {
    # The issue's second finding: both existing package-version gates compare
    # against the SHOTTINO carrier (release.yml's deb and rpm legs), so a
    # restamp of grappa's number would be seen by nobody. On the Arch side the
    # number is now deliberately transformed, which makes the missing gate the
    # difference between a derivation and a hope.
    job="$(arch_job)"
    [ -n "$job" ]
    grep -qF 'pacman -Q grappa' <<<"$job"
    grep -qF 'pkgver.sh' <<<"$job"
}

@test "#1591 the arch job re-checks the ordering with the real vercmp" {
    # The host-side shape rule above is a transcription of a measurement. This
    # is the measurement itself, on a real Arch box, at the only moment a
    # pre-release can reach a user: `vercmp <pkgver> <core>` must be negative.
    job="$(arch_job)"
    [ -n "$job" ]
    grep -qF 'vercmp' <<<"$job"
}
