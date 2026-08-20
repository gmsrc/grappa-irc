#!/usr/bin/env bats
#
# Bats suite for infra/packaging/release_assets.sh (#573).
#
# The release publish job used to inline its "collect what built" find glob
# and had NO notion of what SHOULD have built — so two releases (v0.8.0,
# v0.9.0) shipped without their .rpm and the artifact list was
# indistinguishable from a complete one. This script is the SSOT of the
# EXPECTED release asset set; both the attach glob (`found`) and the
# completeness audit (`missing`/`notice`/`apply-body`) derive from that one
# list, so a silent hole is now impossible.
#
# Scope: the SET LOGIC (expected vs arrived) + the idempotent partial-release
# body marker — the bug-prone parts that must not live untested in YAML.
# Pure filesystem + string logic; no docker, no network, no mix.
#
# #1447 slice B — the kinds are matched by the PACKAGE NAME, not by extension
# alone. From this release the client ships as its own artifact, so a bare
# `*.deb` would be satisfied by EITHER package: a release that built the
# bouncer and lost the client would look complete and say nothing. That is the
# same failure #573 was filed for, one package later.

load ../bats_helpers

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."
    SCRIPT="$REPO_SRC/infra/packaging/release_assets.sh"

    # A downloaded-artifacts tree, nested per-artifact subdir (the layout
    # download-artifact usually produces).
    ASSETS="$BATS_TEST_TMPDIR/assets"
    mkdir -p "$ASSETS/grappa-deb" "$ASSETS/grappa-rpm" "$ASSETS/grappa-arch"
}

# Populate a COMPLETE, realistic asset tree (every expected kind present).
seed_complete() {
    : > "$ASSETS/grappa-deb/grappa_0.8.0_amd64.deb"
    : > "$ASSETS/grappa-rpm/grappa-0.8.0-1.x86_64.rpm"
    : > "$ASSETS/grappa-arch/grappa-0.8.0-1-x86_64.pkg.tar.zst"
    : > "$ASSETS/grappa-arch/PKGBUILD"
    : > "$ASSETS/grappa-arch/.SRCINFO"
    # The client package, on its own version line (#1447). Named as the real
    # builders name it: nfpm writes `<name>_<ver>_<arch>.deb` and
    # `<name>-<ver>-1.<arch>.rpm`, makepkg writes `<name>-<ver>-1-<arch>.pkg.tar.zst`.
    : > "$ASSETS/grappa-deb/shottino_0.3.0_amd64.deb"
    : > "$ASSETS/grappa-rpm/shottino-0.3.0-1.x86_64.rpm"
    : > "$ASSETS/grappa-arch/shottino-0.3.0-1-x86_64.pkg.tar.zst"
    # The client's AUR recipe, staged under a distinct BASENAME: a release
    # asset is keyed by basename, so a second file called PKGBUILD would
    # overwrite the first (the publish fallback uploads with --clobber).
    : > "$ASSETS/grappa-arch/shottino.PKGBUILD"
    : > "$ASSETS/grappa-arch/shottino.SRCINFO"
}

@test "found: a complete nested tree lists every expected asset file" {
    seed_complete
    run "$SCRIPT" found "$ASSETS"
    [ "$status" -eq 0 ]
    echo "$output" | grep -q 'grappa_0.8.0_amd64.deb'
    echo "$output" | grep -q 'grappa-0.8.0-1.x86_64.rpm'
    echo "$output" | grep -q 'grappa-0.8.0-1-x86_64.pkg.tar.zst'
    echo "$output" | grep -q '/PKGBUILD$'
    echo "$output" | grep -q '/.SRCINFO$'
    echo "$output" | grep -q 'shottino_0.3.0_amd64.deb'
    echo "$output" | grep -q 'shottino-0.3.0-1.x86_64.rpm'
    echo "$output" | grep -q 'shottino-0.3.0-1-x86_64.pkg.tar.zst'
    echo "$output" | grep -q '/shottino.PKGBUILD$'
    echo "$output" | grep -q '/shottino.SRCINFO$'
    [ "$(echo "$output" | wc -l | tr -d ' ')" -eq 10 ]
}

@test "found: matches by NAME at any depth, not by a path-coupled glob (flat layout)" {
    # Regression guard for run 30399152630: download-artifact unpacked the
    # green artifact FLAT into assets/, so a path-coupled glob matched
    # nothing. Names, at any depth, must still be found.
    : > "$ASSETS/grappa_0.8.0_amd64.deb"
    run "$SCRIPT" found "$ASSETS"
    [ "$status" -eq 0 ]
    echo "$output" | grep -q 'grappa_0.8.0_amd64.deb'
}

@test "missing: a complete set reports nothing" {
    seed_complete
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "missing: a dropped .rpm is named (the #573 instance)" {
    seed_complete
    rm "$ASSETS/grappa-rpm/grappa-0.8.0-1.x86_64.rpm"
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    [ "$output" = "RPM package, bouncer (.rpm)" ]
}

@test "missing: a client package that did not build is named, not absorbed (#1447)" {
    # The whole reason the kinds are name-scoped. The bouncer's .deb is right
    # there, so an extension-only `*.deb` pattern would find it, call the kind
    # satisfied, and publish a release with no client — silently. A release
    # that loses an artifact it advertises must FAIL LOUDLY.
    seed_complete
    rm "$ASSETS/grappa-deb/shottino_0.3.0_amd64.deb"
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    [ "$output" = "Debian package, client (.deb)" ]
}

@test "missing: losing the client's whole leg names all three of its packages (#1447)" {
    seed_complete
    rm "$ASSETS/grappa-deb/shottino_0.3.0_amd64.deb"
    rm "$ASSETS/grappa-rpm/shottino-0.3.0-1.x86_64.rpm"
    rm "$ASSETS/grappa-arch/shottino-0.3.0-1-x86_64.pkg.tar.zst"
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    echo "$output" | grep -q 'Debian package, client (.deb)'
    echo "$output" | grep -q 'RPM package, client (.rpm)'
    echo "$output" | grep -q 'Arch package, client (.pkg.tar.zst)'
    [ "$(echo "$output" | wc -l | tr -d ' ')" -eq 3 ]
}

@test "missing: a dead Arch leg names all three of its outputs" {
    seed_complete
    rm "$ASSETS/grappa-arch/grappa-0.8.0-1-x86_64.pkg.tar.zst"
    rm "$ASSETS/grappa-arch/PKGBUILD"
    rm "$ASSETS/grappa-arch/.SRCINFO"
    rm "$ASSETS/grappa-arch/shottino-0.3.0-1-x86_64.pkg.tar.zst"
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    echo "$output" | grep -q 'Arch package, bouncer (.pkg.tar.zst)'
    echo "$output" | grep -q 'Arch package, client (.pkg.tar.zst)'
    echo "$output" | grep -q 'Arch PKGBUILD recipe, bouncer'
    echo "$output" | grep -q 'Arch .SRCINFO recipe, bouncer'
    [ "$(echo "$output" | wc -l | tr -d ' ')" -eq 4 ]
}

@test "missing: an empty assets tree names every expected kind" {
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | wc -l | tr -d ' ')" -eq 10 ]
}

@test "missing: the client's recipe is its own kind, not the bouncer's (#1447)" {
    # The two recipes are DIFFERENT files with different sentinels, staged
    # under different basenames precisely so one cannot stand in for the
    # other. An expected-kinds table that matched `PKGBUILD` alone would call
    # the pair complete with the client's recipe missing.
    seed_complete
    rm "$ASSETS/grappa-arch/shottino.PKGBUILD"
    rm "$ASSETS/grappa-arch/shottino.SRCINFO"
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    echo "$output" | grep -q 'Arch PKGBUILD recipe, client'
    echo "$output" | grep -q 'Arch .SRCINFO recipe, client'
    [ "$(echo "$output" | wc -l | tr -d ' ')" -eq 2 ]
}

@test "notice: a complete set produces no marker block" {
    seed_complete
    run "$SCRIPT" notice "$ASSETS"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "notice: a partial set emits a sentinel-delimited block naming the gap" {
    seed_complete
    rm "$ASSETS/grappa-rpm/grappa-0.8.0-1.x86_64.rpm"
    run "$SCRIPT" notice "$ASSETS"
    [ "$status" -eq 0 ]
    echo "$output" | grep -q '<!-- grappa:partial-release:start -->'
    echo "$output" | grep -q '<!-- grappa:partial-release:end -->'
    echo "$output" | grep -q 'RPM package, bouncer (.rpm)'
}

@test "apply-body: a partial set prepends the block, and is idempotent" {
    seed_complete
    rm "$ASSETS/grappa-rpm/grappa-0.8.0-1.x86_64.rpm"
    printf '## What'\''s Changed\n\n- a real changelog line\n' > "$BATS_TEST_TMPDIR/body.md"

    run bash -c "'$SCRIPT' apply-body '$ASSETS' < '$BATS_TEST_TMPDIR/body.md'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" > "$BATS_TEST_TMPDIR/body2.md"
    # block present exactly once, changelog preserved
    [ "$(grep -c 'grappa:partial-release:start' "$BATS_TEST_TMPDIR/body2.md")" -eq 1 ]
    grep -q 'a real changelog line' "$BATS_TEST_TMPDIR/body2.md"
    grep -q 'RPM package, bouncer (.rpm)' "$BATS_TEST_TMPDIR/body2.md"

    # Feeding the already-marked body back in must NOT double the block.
    run bash -c "'$SCRIPT' apply-body '$ASSETS' < '$BATS_TEST_TMPDIR/body2.md'"
    [ "$status" -eq 0 ]
    [ "$(printf '%s\n' "$output" | grep -c 'grappa:partial-release:start')" -eq 1 ]
}

@test "apply-body: a now-complete set strips a stale marker block (the repair converse)" {
    # A prior partial publish left a marker; the repair dispatch rebuilt the
    # missing leg, so the set is complete now — the marker must be removed.
    seed_complete
    {
        echo '<!-- grappa:partial-release:start -->'
        echo '> [!WARNING]'
        echo '> **Partial release.** Missing: RPM package (.rpm)'
        echo '<!-- grappa:partial-release:end -->'
        echo ''
        echo '## What'\''s Changed'
        echo ''
        echo '- a real changelog line'
    } > "$BATS_TEST_TMPDIR/body.md"

    run bash -c "'$SCRIPT' apply-body '$ASSETS' < '$BATS_TEST_TMPDIR/body.md'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -q 'a real changelog line'
    refute grep -q 'grappa:partial-release' <<<"$output"
}

# ── publishable: creating a release is irreversible, topping one up is not ──
#
# #1591. `publish` runs on `!cancelled()`, so a red package leg still reached
# `gh release create` and PUBLISHED — a partial release, marked as such, but
# public. #504/#573 chose that deliberately and for a good reason: a distro
# breakage must not withhold the artifacts that built green. The reason holds
# for a release that ALREADY EXISTS, where attaching what built is the only
# way to complete it. It does not hold for the first run of a fresh tag, where
# the same rule turns "one leg failed" into a public artefact that deleting
# the tag does not retract.
#
# So the axis is not completeness alone — it is completeness × whether the
# release object already exists. That decision lives here rather than in YAML
# because it is the SAME table the rest of this script owns, and because a
# two-variable rule inlined in a workflow step is exactly what #573 was filed
# about.

@test "publishable: a complete set may create a brand-new release" {
    seed_complete
    run "$SCRIPT" publishable "$ASSETS" absent
    [ "$status" -eq 0 ]
}

@test "publishable: a complete set may top up an existing release" {
    seed_complete
    run "$SCRIPT" publishable "$ASSETS" present
    [ "$status" -eq 0 ]
}

@test "publishable: a PARTIAL set must NOT create a new release (#1591)" {
    # The irreversible act. `gh release create` publishes; deleting the tag
    # afterwards does not retract what was published.
    seed_complete
    rm "$ASSETS/grappa-arch/grappa-0.8.0-1-x86_64.pkg.tar.zst"
    run "$SCRIPT" publishable "$ASSETS" absent
    [ "$status" -ne 0 ]
    # It must name the gap, not just refuse: the operator's next move is to
    # fix that leg and re-run, and a bare refusal makes them go find out which.
    grep -q 'Arch package, bouncer' <<<"$output"
}

@test "publishable: a PARTIAL set MAY still top up an existing release (#504/#573 preserved)" {
    # The converse, and the reason this is a two-variable rule rather than a
    # completeness check: the repair dispatch of #573 (b) exists precisely to
    # attach a leg that failed the first time, and it runs against a release
    # that is already public. Refusing here would break the repair path in the
    # name of protecting a publication that has already happened.
    seed_complete
    rm "$ASSETS/grappa-arch/grappa-0.8.0-1-x86_64.pkg.tar.zst"
    run "$SCRIPT" publishable "$ASSETS" present
    [ "$status" -eq 0 ]
}

@test "publishable: an unknown release state is refused, never read as 'present'" {
    # Fail closed on the permissive side. The workflow computes this from
    # `gh release view`, and a probe that errors for an unrelated reason (rate
    # limit, token scope) must not be silently read as "already public,
    # publish anyway".
    seed_complete
    rm "$ASSETS/grappa-arch/grappa-0.8.0-1-x86_64.pkg.tar.zst"
    for state in "" maybe yes PRESENT; do
        run "$SCRIPT" publishable "$ASSETS" "$state"
        [ "$status" -ne 0 ]
        # Named, so the refusal is distinguishable from the usage error an
        # absent subcommand produces — otherwise this case is green today,
        # against a script that has never heard of `publishable`.
        grep -qi 'release state' <<<"$output"
    done
}

@test "usage: an unknown subcommand fails loudly" {
    run "$SCRIPT" frobnicate "$ASSETS"
    [ "$status" -ne 0 ]
}
