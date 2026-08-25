#!/usr/bin/env bats
#
# Bats suite for GH #1686 — the mutable ghcr `:latest` pointer must land on
# the newest RELEASE, and never on a release candidate.
#
# THE DEFECT HAS TWO FACES AND THE ISSUE NAMES ONE. Both were read off the
# runs' own logs rather than derived:
#
#     2026-08-20T23:38:15Z  v1.3.0-rc2 is the highest tag — tagging :latest
#     2026-08-21T19:18:58Z  v1.3.0 is NOT the highest (v1.3.0-rc2) — NOT tagging :latest
#     2026-08-22T08:40:28Z  v1.3.1 is the highest tag — tagging :latest
#
# Face one is the reported one: a CANDIDATE took `:latest`. Face two is that
# the STABLE release which followed was then DENIED it — `:latest` skipped
# v1.3.0 entirely and stayed on the candidate until v1.3.1, so the exposure
# ran ~33h, not the ~20h the issue bounds it at. A cure measured against face
# one alone would leave a stable release unable to claim the tag operators
# actually pull.
#
# THE ROOT IS THE RANKING. `git tag -l 'v*' --sort=-v:refname` places a
# `-rcN` suffix ABOVE the bare version unless `versionsort.suffix` says
# otherwise, so the candidate outranks both its own release and the ranking's
# whole purpose.
#
# WHY NOT `versionsort.suffix` — falsified by measurement, not by taste. On a
# scratch repo holding the tag set as it stood at the rc2 push (v1.0.0 v1.1.0
# v1.2.0 v1.3.0-rc1 v1.3.0-rc2, with NO v1.3.0 yet):
#
#     git tag -l 'v*' --sort=-v:refname                    -> v1.3.0-rc2
#     git -c versionsort.suffix=- tag -l ... --sort=...    -> v1.3.0-rc2
#
# Identical. The suffix only orders a candidate against ITS OWN release, so it
# repairs face two and leaves the MEASURED face one exactly as it was. And on
# top of the cure below it is inert by construction: once pre-releases are out
# of the candidate set there is no suffix left to order. The issue proposes
# belt-and-braces; a second mechanism that does the first one's job is the
# drift #1591 / #1594 / #1636 all were, so this suite pins ONE.
#
# THE CLASSIFIER IS NOT WRITTEN TWICE. `infra/packaging/prerelease_flag.sh`
# (#1636) already answers "does semver call this a pre-release" and already
# REFUSES with exit 2 what it cannot classify. The gate reuses it; a second
# hand-rolled semver comparison is what leaves two `:latest` owners to drift.
#
# WHAT THIS SUITE DOES NOT COVER, stated so a green is not read wider than it
# is. It drives the gate's SHELL LOGIC against fabricated git repositories.
# It does not run GitHub Actions, does not exercise `docker/build-push-action`,
# and never contacts a registry — so "which tags the runner actually pushed"
# is asserted here only as the tag LIST the gate feeds that action, via the
# workflow text. The end-to-end fact is unreachable without cutting a release.

# `run --separate-stderr` is a 1.5.0 flag and the vendored bats is 1.9.0, but
# without this declaration bats emits BW02 once PER CALL — 26 lines of warning
# around this suite's assertions. Fourteen other suites in this tree pass flags
# to `run` without it and carry the same noise; that is the drifted spelling,
# not the one to copy.
bats_require_minimum_version 1.5.0

load ../bats_helpers

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
    GATE_SH="$REPO_ROOT/infra/packaging/latest_tag_gate.sh"
    FLAG_SH="$REPO_ROOT/infra/packaging/prerelease_flag.sh"
    WORKFLOW="$REPO_ROOT/.github/workflows/release.yml"

    # The FLOOR. Without it every refusal case below is satisfied by a missing
    # script (127 is non-zero too) and the suite reports green against nothing.
    [ -x "$GATE_SH" ]
    [ -x "$FLAG_SH" ]

    export GIT_CONFIG_GLOBAL="$BATS_TEST_TMPDIR/gitconfig"
    export GIT_AUTHOR_NAME=bats GIT_AUTHOR_EMAIL=bats@example.org
    export GIT_COMMITTER_NAME=bats GIT_COMMITTER_EMAIL=bats@example.org
}

# A throwaway repository carrying exactly the tags named. The gate reads the
# tag set from the CURRENT repository, so the fixture is the cwd — while the
# gate itself stays the real one in the real tree, reaching its classifier by
# its own dirname.
tagged_repo() {
    local dir="$BATS_TEST_TMPDIR/repo-$1"
    shift
    git init -q -b main "$dir"
    git -C "$dir" commit -q --allow-empty -m base
    local tag
    for tag in "$@"; do
        git -C "$dir" tag "$tag"
    done
    printf '%s\n' "$dir"
}

# The tag set as it stood when v1.3.0-rc2 was pushed: the candidate is the
# newest thing in the repository and its own release does not exist yet. This
# is the state the measured incident happened in, and the one
# `versionsort.suffix` does not fix.
at_rc2_push() {
    tagged_repo rc2 v1.0.0 v1.1.0 v1.2.0 v1.3.0-rc1 v1.3.0-rc2
}

# The same repository one tag later: the stable release now exists alongside
# the candidates that preceded it. This is face two.
at_stable_push() {
    tagged_repo stable v1.0.0 v1.1.0 v1.2.0 v1.3.0-rc1 v1.3.0-rc2 v1.3.0
}

# ── The two measured faces ──────────────────────────────────────────────────

@test "#1686 a release candidate does NOT take :latest, even when nothing outranks it" {
    # Face one, in the exact tag set that produced it. The candidate IS the
    # newest tag by every ordering git offers; eligibility is not a question
    # of ordering at all.
    cd "$(at_rc2_push)"

    run --separate-stderr "$GATE_SH" v1.3.0-rc2
    [ "$status" -eq 0 ]
    [ "$output" = "no" ]

    # And for every spelling of a candidate the classifier recognises, so the
    # gate cannot be passing on the literal string "rc2".
    local tag
    for tag in v1.3.0-rc1 v1.3.0-rc.1 v1.3.0-rc-1 v1.3.0-1 v1.3.0-alpha.1 v1.3.0-rc1+foo; do
        git tag "$tag" 2>/dev/null || true
        run --separate-stderr "$GATE_SH" "$tag"
        [ "$status" -eq 0 ]
        [ "$output" = "no" ]
    done
}

@test "#1686 the refusal says the tag is a pre-release — not that something outranks it" {
    # Log honesty. The old gate would have answered "v1.3.0-rc2 is NOT the
    # highest (v1.2.0)", which is FALSE: 1.3.0-rc2 is higher than 1.2.0 by
    # semver and by git's own sort. A fast path states what it OBSERVED.
    cd "$(at_rc2_push)"

    run --separate-stderr "$GATE_SH" v1.3.0-rc2
    [ "$status" -eq 0 ]
    grep -qF 'pre-release' <<<"$stderr"
    refute grep -qF 'v1.2.0' <<<"$stderr"
}

@test "#1686 the stable release that FOLLOWS a candidate does take :latest" {
    # Face two, the one the issue does not name. Measured:
    # `v1.3.0 is NOT the highest (v1.3.0-rc2)` — the release was denied the
    # pointer by its own candidate, and `:latest` skipped it entirely.
    cd "$(at_stable_push)"

    run --separate-stderr "$GATE_SH" v1.3.0
    [ "$status" -eq 0 ]
    [ "$output" = "yes" ]

    # The candidates it ranked PAST, named on the way. Without this the case
    # cannot tell "the scan skipped rc2" from "the scan never looked" — and
    # what the skip line reports is the evidence for the verdict above it.
    grep -qF 'ranking skips v1.3.0-rc2' <<<"$stderr"
}

@test "#1686 an ordinary release with no candidates around it takes :latest" {
    # The positive control. A cure that answered "no" to everything would
    # satisfy both refusal cases above and be caught here.
    cd "$(tagged_repo plain v1.0.0 v1.1.0 v1.2.0)"

    run --separate-stderr "$GATE_SH" v1.2.0
    [ "$status" -eq 0 ]
    [ "$output" = "yes" ]
}

# ── The exclusion that already worked must keep working ─────────────────────

@test "#1686 a backport tag is STILL excluded — the property the gate had" {
    # The hazard the gate was written for (v0.7.5 pushed after v0.8.0 must not
    # re-point `:latest` at an OLDER image). A cure for the pre-release hole
    # that dropped this would trade one wrong `:latest` for another.
    cd "$(tagged_repo backport v0.7.0 v0.8.0 v0.7.5)"

    run --separate-stderr "$GATE_SH" v0.7.5
    [ "$status" -eq 0 ]
    [ "$output" = "no" ]

    run --separate-stderr "$GATE_SH" v0.8.0
    [ "$status" -eq 0 ]
    [ "$output" = "yes" ]
}

@test "#1686 a backport is excluded even when the newest tag is a candidate" {
    # The two rules composed, which is where a gate that special-cased one of
    # them would come apart: the highest RELEASE is v0.8.0, so the backport
    # stays out and the candidate above it does not become the yardstick.
    cd "$(tagged_repo backport-rc v0.7.0 v0.8.0 v0.9.0-rc1 v0.7.5)"

    run --separate-stderr "$GATE_SH" v0.7.5
    [ "$status" -eq 0 ]
    [ "$output" = "no" ]

    run --separate-stderr "$GATE_SH" v0.8.0
    [ "$status" -eq 0 ]
    [ "$output" = "yes" ]

    run --separate-stderr "$GATE_SH" v0.9.0-rc1
    [ "$status" -eq 0 ]
    [ "$output" = "no" ]
}

@test "#1686 build metadata is not a candidate — the classifier's own decisive row" {
    # Semver orders the suffixes pre-release-then-build, so the hyphen in
    # `1.4.0+foo-bar` belongs to the build and `Version.parse/1` reports
    # `pre: []` (measured in #1636). A gate that filtered on "contains a
    # hyphen" — the second writing of the rule this reuse exists to avoid —
    # would answer "no" here and strand `:latest` on an older release.
    cd "$(tagged_repo build v1.3.0 'v1.4.0+foo-bar')"

    run --separate-stderr "$GATE_SH" 'v1.4.0+foo-bar'
    [ "$status" -eq 0 ]
    [ "$output" = "yes" ]
}

# ── Refusal, and what it does NOT take down with it ─────────────────────────

@test "#1686 a tag the classifier cannot read is REFUSED, never answered 'yes'" {
    # The permissive default is the one that publishes. The refusal's OWN exit
    # code, not merely non-zero: 127 (absent script) would satisfy `-ne 0`
    # while proving nothing, and the setup floor guards that too.
    cd "$(at_stable_push)"

    local tag
    for tag in "" 1.3.0 v vfoo v1.3 v1.3.0.4 "v 1.3.0"; do
        run --separate-stderr "$GATE_SH" "$tag"
        [ "$status" -eq 2 ]
        refute grep -qxE 'yes|no' <<<"$output"
    done

    run --separate-stderr "$GATE_SH"
    [ "$status" -eq 2 ]
    refute grep -qxE 'yes|no' <<<"$output"
}

@test "#1686 an unreadable tag ELSEWHERE in the repo does not block a release" {
    # A stray tag nobody cut a release from must not become a permanent veto
    # over every future release. It is skipped, out loud, and the scan carries
    # on to the highest tag that IS a release — the conservative direction,
    # since a tag the classifier refuses never had images published under it.
    #
    # THE STRAY MUST OUTRANK THE TAG UNDER TEST or this case proves nothing:
    # the scan stops at the first release it finds, so a stray BELOW the winner
    # is never reached and the assertion holds with the skip arm replaced by a
    # hard failure. Measured — that mutant SURVIVED against `v1.2` (which sorts
    # under v1.3.0) and is killed by `v9.9`, which sorts over it.
    #
    # `nightly-2026-08-01` rides along to pin the other half: the scan globs
    # `v*`, so a tag outside that shape never enters the ranking at all and it
    # is only the `v`-spelled stray that can reach the classifier.
    cd "$(tagged_repo stray v1.0.0 v1.1.0 v1.3.0 v9.9 nightly-2026-08-01)"

    run --separate-stderr "$GATE_SH" v1.3.0
    [ "$status" -eq 0 ]
    [ "$output" = "yes" ]
    grep -qF 'ranking skips v9.9' <<<"$stderr"
    refute grep -qF 'nightly-2026-08-01' <<<"$stderr"
}

@test "#1686 a repository with no release tags at all answers 'no', not 'yes'" {
    # The empty-set edge, in the direction that cannot move a pointer wrongly.
    cd "$(tagged_repo empty)"

    run --separate-stderr "$GATE_SH" v1.0.0
    [ "$status" -eq 0 ]
    [ "$output" = "no" ]
}

# ── The pipeline uses it, for BOTH images, and spells the rule nowhere else ──

# The `docker` job of release.yml, from its key to the next top-level job key.
# Read off the JOB: release.yml also builds deb, rpm and arch, and a whole-file
# grep would be satisfied by any of their steps.
docker_job() {
    awk '/^  docker:/ { f = 1; next } f && /^  [a-z]/ { exit } f' "$WORKFLOW"
}

# The workflow with its comments stripped, so a gate about what the pipeline
# DOES is never satisfied — nor broken — by prose about what it does.
workflow_code() {
    sed 's/^[[:space:]]*#.*$//; s/[[:space:]]#[[:space:]].*$//' "$WORKFLOW"
}

@test "#1686 the docker job derives :latest from the gate, and stops if it cannot" {
    job="$(docker_job)"
    [ -n "$job" ]
    grep -qF 'latest_tag_gate.sh' <<<"$job"

    # The refusal is not swallowed. The script exits 2 on a tag it cannot
    # classify, and the permissive reading of that — carry on with an empty
    # verdict — is what publishes `:latest` onto an unclassified tag.
    grep -qF 'if ! latest=' <<<"$job"
}

@test "#1686 the hand-rolled semver ranking is GONE — the rule has one writing" {
    # The defect itself, as a line of shell. `--sort=-v:refname` picking
    # `highest` is the ranking that put a candidate on top; leaving it in
    # place next to the gate would be two owners for one decision.
    refute grep -qF -- '-v:refname' <<<"$(workflow_code)"
    refute grep -qF -- 'versionsort.suffix' <<<"$(workflow_code)"

    # The stripper must not have eaten the code it is supposed to be reading.
    grep -qF 'latest_tag_gate.sh' <<<"$(workflow_code)"
}

@test "#1686 ONE gate feeds BOTH images — the bridge shares the bouncer's answer" {
    # `grappa-shottino` is cut from the same tag and published by the same job
    # (#1168). A cure that reached only the bouncer would leave the bridge's
    # `:latest` on a candidate — half a cure, and the half nobody looks at.
    job="$(docker_job)"

    # Both repositories go through the SAME emitter, and the emitter is what
    # consults the verdict. Asserted structurally rather than by counting
    # occurrences of `:latest`, which prose would satisfy.
    grep -qF 'emit_tags "${name}" tags' <<<"$job"
    grep -qF 'emit_tags "${shottino_name}" shottino_tags' <<<"$job"
    grep -qF '[ "${latest}" = yes ]' <<<"$job"

    # And the bridge's build step consumes the tag list that emitter produced.
    grep -qF 'steps.img.outputs.shottino_tags' <<<"$job"
}

@test "#1686 a repair dispatch can still reach the gate — an OLD tag's tree cannot" {
    # THE REGRESSION THIS CURE WOULD OTHERWISE HAVE CAUSED. The docker job
    # checks out `ref: REPAIR_TAG`, so on a #573 (b) image repair the tree is
    # the OLD TAG's. Measured: `git tag --contains d622616d` answers
    # `v1.3.0 v1.3.1` — every earlier tag predates prerelease_flag.sh, so a
    # naive call would exit 127 and kill a path that works today.
    #
    # The cure reuses the verb the job ALREADY has for "this comes from the
    # dispatched ref" — the scaffolding checkout — rather than inventing a
    # second one. Both scripts must be in that list: the gate and the
    # classifier it reaches.
    job="$(docker_job)"
    scaffolding="$(awk '/^[[:space:]]*git checkout "\$\{GITHUB_SHA\}" -- \\$/ { f = 1 }
                        f { print; if (!/\\$/) exit }' <<<"$job")"
    [ -n "$scaffolding" ]
    grep -qF 'infra/packaging/latest_tag_gate.sh' <<<"$scaffolding"
    grep -qF 'infra/packaging/prerelease_flag.sh' <<<"$scaffolding"

    # And the artefact is unchanged by that, which is the reason the list may
    # grow at all: Dockerfile.release COPYs a SMALL, enumerated set out of
    # infra/packaging, and neither of these two is in it. Measured, not
    # assumed — the moment one more joins, this assertion is the one that
    # notices, and the count stays a LITERAL for exactly that reason. Deriving
    # it from the file would make it pass by construction and buy nothing.
    #
    # It has fired once, as designed: #1773 added credits.sh (the credit
    # roll's git facts, on the same channel as version.sh), taking the count
    # 2 → 3. Reviewed at that point — credits.sh is neither the gate nor the
    # classifier, so the two refutes below still carry the property.
    run grep -c '^COPY.*infra/packaging/' "$REPO_ROOT/Dockerfile.release"
    [ "$output" = "3" ]
    refute grep -qF 'infra/packaging/latest_tag_gate.sh' "$REPO_ROOT/Dockerfile.release"
    refute grep -qF 'infra/packaging/prerelease_flag.sh' "$REPO_ROOT/Dockerfile.release"
}

@test "#1686 the gate is POSIX sh, like every sibling under infra/packaging" {
    # Not a style rule: `scripts/posix-parse.sh` derives its file set from line
    # 1, so the dialect declaration is what enrols this script in the parse
    # gate. A bash shebang would silently drop it out of that set.
    head -1 "$GATE_SH" | grep -qE '^#!/bin/sh$'
    "$REPO_ROOT/scripts/posix-parse.sh" --list | grep -qxF 'infra/packaging/latest_tag_gate.sh'
}
