#!/usr/bin/env bats
#
# Bats suite for GH #1636 — a release candidate must be PUBLISHED as a
# pre-release, and the marker must be derived from the tag rather than
# remembered by a human.
#
# `gh release create` was called with no pre-release flag at all, so every
# release the pipeline has ever cut was published as a full release. Measured
# on the repository's own release list (GitHub API, 2026-08-21):
#
#     v1.3.0-rc1   isPrerelease: true    <- set BY HAND after the run
#     v1.3.0-rc2   isPrerelease: false   <- nobody remembered; also fixed by hand
#
# The blast radius is bounded but real: GitHub picks "Latest" among the
# releases that are neither draft nor pre-release, so a green candidate run is
# the only thing between a release candidate and the repository's landing
# page. `GET /releases/latest` still answered `v1.2.0` when this was written —
# exposure, not damage.
#
# THE ORACLE IS SEMVER, and it was measured rather than argued. `elixir -e`
# on the pinned toolchain, `Version.parse/1`:
#
#     1.3.0          pre: []          <- release
#     1.3.0-rc1      pre: ["rc1"]     <- pre-release
#     1.3.0-rc.1     pre: ["rc", 1]   <- pre-release
#     1.3.0-rc-1     pre: ["rc-1"]    <- pre-release (the pre carries hyphens)
#     1.3.0-1        pre: [1]         <- pre-release (numeric identifier)
#     1.3.0+foo      pre: [],  build: "foo"
#     1.3.0+foo-bar  pre: [],  build: "foo-bar"   <- NOT a pre-release
#     1.3.0-rc1+foo  pre: ["rc1"], build: "foo"
#     1.3            :error
#     v1.3.0         :error           <- the `v` is the TAG's, not the version's
#
# A NON-EMPTY `pre` is exactly the condition for the flag. The `+foo-bar` row
# is the one that decides the implementation: build metadata comes AFTER the
# pre-release in semver, so a `+` seen before any `-` means the hyphen belongs
# to the build and there is no pre-release at all.
#
# WHY A NEW DERIVATION AND NOT ONE OF THE TWO MAPPERS ALREADY IN THIS
# DIRECTORY — falsified by measurement, not by taste. Both `aur/pkgver.sh` and
# the `pkgversion.sh` deb map are pre-release-AWARE, so "did the mapping change
# the string" looks like a free oracle. It is not:
#
#     aur/pkgver.sh 1.3.0-1        rc=2  — REFUSES a legal semver pre-release,
#                                          because `1.3.01` would outrank
#                                          `1.3.0` for pacman (#1591). As an
#                                          oracle it would KILL the publish
#                                          step instead of marking the release.
#     aur/pkgver.sh 1.3.0+foo-bar  -> 1.3.0+foobar   (changed, yet pre: [])
#     sed 's/-/~/'  1.3.0+foo-bar  -> 1.3.0+foo~bar  (changed, yet pre: [])
#
# Both would mark a stable release as a candidate. They answer "what does this
# packager stamp", which is a different question from "does semver call this a
# pre-release" — and a third writing of the rule is exactly the drift the
# issue warns about. So the rule is written ONCE, in this suite's subject:
# `infra/packaging/prerelease_flag.sh`.

load ../bats_helpers

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
    FLAG_SH="$REPO_ROOT/infra/packaging/prerelease_flag.sh"
    WORKFLOW="$REPO_ROOT/.github/workflows/release.yml"

    # The FLOOR. Without it every refusal case below is satisfied by a missing
    # script (127 is non-zero too) and the suite reports green against nothing.
    [ -x "$FLAG_SH" ]
}

# The `publish` job of release.yml, from its key to the next top-level job key.
# Read off the JOB: release.yml also builds deb, rpm, arch and docker, and a
# whole-file grep would be satisfied by any of their steps.
publish_job() {
    awk '/^  publish:/ { f = 1; next } f && /^  [a-z]/ { exit } f' "$WORKFLOW"
}

# The workflow with its comments stripped, so a gate about what the pipeline
# DOES is never satisfied — nor broken — by prose about what it does.
workflow_code() {
    sed 's/^[[:space:]]*#.*$//; s/[[:space:]]#[[:space:]].*$//' "$WORKFLOW"
}

# ── The derivation, row by row against the measured Version.parse/1 table ───

@test "#1636 a tag whose version carries a pre-release asks for the marker" {
    # Every row here has a non-empty `pre` in the measurement above — including
    # the two spellings the repo has actually cut (rc1, rc2), the dotted and
    # hyphenated pre-release identifiers, a numeric one, and one carrying build
    # metadata on top.
    for tag in v1.3.0-rc1 v1.3.0-rc2 v1.3.0-rc.1 v1.3.0-rc-1 v1.3.0-1 \
        v1.3.0-RC1 v1.3.0-0a v1.3.0-alpha.1 v1.3.0-rc1+foo v2.0.0-beta; do
        run "$FLAG_SH" "$tag"
        [ "$status" -eq 0 ]
        [ "$output" = "--prerelease=true" ]
    done
}

@test "#1636 a bare release tag asks NOT to be marked — explicitly, not by omission" {
    # The flag is spelled on BOTH sides on purpose. `gh release create` defaults
    # a missing `--prerelease` to false, so an empty answer would be
    # indistinguishable from the derivation having silently produced nothing —
    # which is the failure this whole suite exists to catch. Measured on
    # gh 2.93.0: `--prerelease=false` parses (`gh release create
    # --prerelease=false` errors with "tag required", not "unknown flag").
    for tag in v1.3.0 v0.4.0 v1.2.0 v0.9.11 v10.20.30; do
        run "$FLAG_SH" "$tag"
        [ "$status" -eq 0 ]
        [ "$output" = "--prerelease=false" ]
    done
}

@test "#1636 build metadata is not a pre-release, even when it carries a hyphen" {
    # THE row that decides the implementation. Semver orders the suffixes
    # pre-release-then-build, so in `1.3.0+foo-bar` the hyphen is INSIDE the
    # build metadata and `Version.parse/1` reports `pre: []` (measured). An
    # implementation that splits on the first hyphen without stripping the
    # build first marks this release as a candidate.
    for tag in v1.3.0+foo v1.3.0+foo-bar v1.2.0+deadbeef; do
        run "$FLAG_SH" "$tag"
        [ "$status" -eq 0 ]
        [ "$output" = "--prerelease=false" ]
    done
}

@test "#1636 the whole published corpus classifies, and only the candidates are marked" {
    # The positive control, with its cardinality COUNTED rather than eyeballed:
    # the twenty-three releases this repository has published, read off the
    # GitHub API on 2026-08-21. Twenty-one are bare and must stay eligible for
    # "Latest"; the two candidates are the only ones that must not. A
    # derivation that marked everything would satisfy the first case above and
    # be caught here.
    corpus=(v0.4.0 v0.4.1 v0.5.0 v0.6.0 v0.6.1 v0.7.0 v0.8.0 v0.9.0 v0.10.0
        v0.11.0 v0.12.0 v0.13.0 v0.13.1 v0.13.2 v0.13.3 v0.14.0 v0.15.0
        v0.16.0 v1.0.0 v1.1.0 v1.2.0 v1.3.0-rc1 v1.3.0-rc2)
    [ "${#corpus[@]}" -eq 23 ]

    marked=0
    plain=0
    for tag in "${corpus[@]}"; do
        run "$FLAG_SH" "$tag"
        [ "$status" -eq 0 ]
        case "$output" in
            --prerelease=true) marked=$((marked + 1)) ;;
            --prerelease=false) plain=$((plain + 1)) ;;
            *) return 1 ;;
        esac
    done

    [ "$marked" -eq 2 ]
    [ "$plain" -eq 21 ]
}

# ── It refuses rather than answering "stable" ───────────────────────────────

@test "#1636 a tag it cannot classify is REFUSED, never answered as a release" {
    # The permissive default is the one that publishes — the same posture
    # `release_assets.sh publishable` takes on an unknown release state. A
    # classifier that cannot parse its input must stop the step, not shrug and
    # let a candidate take the "Latest" slot.
    #
    # The refusal's OWN exit code, not merely non-zero: 127 (absent script)
    # would satisfy `-ne 0` while proving nothing. The setup floor guards that
    # too, belt and braces.
    for tag in "" 1.3.0 v vfoo v1.3 v1 v1.3.0.4 v1.3.0- v1.3.0+ "v 1.3.0"; do
        run "$FLAG_SH" "$tag"
        [ "$status" -eq 2 ]
        refute grep -qF -- '--prerelease' <<<"$output"
    done

    # And with no argument at all — a workflow_dispatch that forgot its `tag`
    # input reaches the publish job with RELEASE_TAG empty.
    run "$FLAG_SH"
    [ "$status" -eq 2 ]
    refute grep -qF -- '--prerelease' <<<"$output"

    # A tag carrying a NEWLINE. Worth its own row because it is the one shape
    # that separates a whole-string check from a line-anchored regexp: `grep
    # -E '^[0-9]+\.[0-9]+\.[0-9]+$'` is satisfied by the first line here and
    # would answer "release" for the rest of it.
    run "$FLAG_SH" "$(printf 'v1.3.0\nnot-a-tag')"
    [ "$status" -eq 2 ]
    refute grep -qF -- '--prerelease' <<<"$output"
}

# ── The pipeline actually uses it, and spells the rule nowhere else ─────────

@test "#1636 the publish job derives the marker from the tag it is publishing" {
    # The hole the issue names. `gh release create` carried no marker at all,
    # so the pipeline's answer was always "full release" and rc1's `true` was a
    # human's edit after the fact.
    job="$(publish_job)"
    [ -n "$job" ]
    grep -qF 'prerelease_flag.sh' <<<"$job"
    grep -qF '"${RELEASE_TAG}"' <<<"$job"

    # The refusal is not swallowed. The script exits non-zero on a tag it
    # cannot classify, and the permissive reading of that — carry on with an
    # empty flag — is exactly what publishes an unmarked candidate.
    grep -qF 'if ! prerelease_flag=' <<<"$job"

    # The derived value reaches the CREATE call, which is the irreversible one:
    # `gh release create` publishes, and deleting the tag afterwards does not
    # retract it (#1591).
    create="$(awk '/gh release create/ { f = 1 } f { print } f && /assets\[@\]/ { exit }' <<<"$job")"
    [ -n "$create" ]
    grep -qF 'prerelease_flag' <<<"$create"
}

@test "#1636 the workflow spells the marker nowhere — the rule has one writing" {
    # Anything that writes the rule twice will drift, which is what #1591 and
    # #1594 both were. A literal flag in the YAML is a second writing by
    # definition: it would be a constant where the derivation is a function of
    # the tag. Comments are stripped first, so the prose above the call may
    # name the flag while the code may not.
    refute grep -qF -- '--prerelease' <<<"$(workflow_code)"

    # The stripper must not have eaten the code it is supposed to be reading.
    grep -qF 'prerelease_flag.sh' <<<"$(workflow_code)"
    grep -qF 'gh release create' <<<"$(workflow_code)"
}

@test "#1636 the derivation is POSIX sh, like every sibling under infra/packaging" {
    # Not a style rule: `scripts/posix-parse.sh` derives its file set from line
    # 1, so the dialect declaration is what enrols this script in the parse
    # gate. A bash shebang would silently drop it out of that set.
    head -1 "$FLAG_SH" | grep -qE '^#!/bin/sh$'
    "$REPO_ROOT/scripts/posix-parse.sh" --list | grep -qxF 'infra/packaging/prerelease_flag.sh'
}
