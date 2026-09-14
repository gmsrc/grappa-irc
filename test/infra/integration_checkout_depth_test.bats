#!/usr/bin/env bats
#
# issue 1773 — the `integration` workflow must check out REAL history.
#
# `scripts/integration.sh` derives GRAPPA_CREDITS from `infra/packaging/
# credits.sh` and hands it to the cic build, and the #1773 e2e spec compares
# the rendered roll against that payload. The contributor half of the payload
# is an aggregate over history, so it is only as true as the checkout is deep
# — and `actions/checkout` defaults to `fetch-depth: 1` (its own action.yml,
# at the sha this repo pins: "Number of commits to fetch. 0 indicates all
# history"; `default: 1`).
#
# What that cost, measured before the fix: every green `integration` run baked
# a roll reading `[{"name":"Marcello Barnaba","commits":1}]` against a history
# where that author has 5667, and no assertion could see it, because a wrong
# roll and a right one have the same shape. The red that finally surfaced it
# was a DEPENDABOT pull request, where the one fetched commit is the PR's
# auto-merge commit authored by `dependabot[bot]`, which credits.sh's #1927
# bot filter then drops — leaving `contributors: []`, the one shape the spec
# does refuse.
#
# credits.sh now withholds the list on a shallow repo rather than guessing it
# (`credits_payload_test.bats`, the shallow case), which turns the silent lie
# into a loud red. This case is the other half: it keeps the workflow supplying
# the history that makes the roll derivable, so the loud red never has to fire
# here.
#
# `filter: blob:none` is deliberately NOT asserted. It is a cost choice, not a
# correctness one — measured on this repo, `fetch-depth: 0` alone pulls the
# 491M of historical blobs while the partial clone reaches the same 6293
# commits in 25M — and pinning a cost knob would fail a build for being slow.

load ../bats_helpers

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
    WORKFLOW="$REPO_ROOT/.github/workflows/integration.yml"
}

# The checkout step of the shard job: from its `- name:` line to the start of
# the next step at the same indent, with COMMENT lines dropped.
#
# 🔴 Dropping the comments is load-bearing, not tidiness, and it is here
# because the first version of this file did not do it and was measured to be
# worthless: the step explains its own reasoning in prose that spells
# `fetch-depth: 0`, so a substring match over the raw block passed on the
# COMMENT after the key itself had been deleted. The gate read the
# justification and reported on the configuration. A check that cannot fail
# when the thing it guards is removed is not a check.
checkout_with_keys() {
    awk '
        /^      - / {
            if (inblock) { exit }
            inblock = ($0 ~ /Checkout/)
        }
        inblock && $0 !~ /^[[:space:]]*#/ { print }
    ' "$WORKFLOW"
}

# THE predicate, named once so the case can aim it at something that must pass
# and at something that must fail. A matcher only ever asserted against the
# artefact it was written for cannot be shown to discriminate. Anchored on a
# real KEY line — `fetch-depth:` alone at its indent, value 0 — so no prose and
# no longer value (`10`) can satisfy it.
declares_full_history() {
    grep -qE '^[[:space:]]+fetch-depth:[[:space:]]*0[[:space:]]*$' <<< "$1"
}

@test "issue 1773 — the integration checkout fetches whole history, not one commit" {
    local step
    step="$(checkout_with_keys)"

    # POSITIVE CONTROL, and it is not ceremony: every assertion below is a
    # substring match, and every substring match against an empty string is a
    # silent pass. A renamed step or a reindented `steps:` block would hand
    # this case nothing to look at and it would report green.
    [[ "$step" == *"actions/checkout"* ]]
    [[ "$step" == *"submodules: recursive"* ]]

    # The requirement.
    declares_full_history "$step"

    # NEGATIVE CONTROL — the same predicate, aimed at the exact shape this
    # workflow carried when the defect shipped: a checkout that names no depth
    # and therefore takes the action's default of 1. If the predicate accepts
    # this, it accepts the bug, and its verdict on the real step means nothing.
    local defaulted
    defaulted="      - name: Checkout (with submodules)
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          submodules: recursive"
    # `refute`, never a bare `!`: an inverted command is not an assertion in a
    # bats body — it cannot fail the case — so the negative control would have
    # been decorative, which is worse than absent. This repo's own
    # `bats_assertion_style_test.bats` is what caught it here.
    refute declares_full_history "$defaulted"
}
