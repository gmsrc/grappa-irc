#!/usr/bin/env bats
#
# Bats suite for GH #1408 D-S8 — the `integration` workflow's path filter
# must cover the files that decide what the suite boots.
#
# The filter states its own rule in prose (integration.yml, header): the
# root Dockerfile and compose.yaml are in scope because "they define the
# images the suite boots". Prose cannot fail a build. Three files that the
# rule covers were never listed, and a workflow that does not run is
# indistinguishable from one that passes.
#
# Every check DERIVES its expectation from the artefact that creates the
# dependency — `cicchetto/e2e/compose.yaml` for the build inputs, the
# orchestration script for the version carrier — so that moving the
# dependency moves the expectation with it. A hand-transcribed list here
# would be a second copy of the filter, drifting the same way the filter
# drifts from itself.
#
# NOT derived from `Grappa.Deploy.Preflight.docker_image?/1`, though it
# reads like the same list: preflight answers "does the deployed container
# need a COLD restart", this filter answers "can this change break the e2e
# suite". They diverge — `bin/start.sh` is the image CMD and so is
# preflight's business, but both services this suite builds from the repo
# root override `command:`, so the CMD never runs here.

load ../bats_helpers

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
    WORKFLOW="$REPO_ROOT/.github/workflows/integration.yml"
    E2E_COMPOSE="$REPO_ROOT/cicchetto/e2e/compose.yaml"
}

# The `paths:` entries under `on.<trigger>`, one per line, quotes stripped.
# A two-space key resets the trigger, so `jobs:`/`concurrency:` cannot leak
# a later `paths:` into a block that has already closed.
paths_for() {
    awk -v want="$1" '
        /^  [a-z_]+:$/ { trigger = substr($1, 1, length($1) - 1); inpaths = 0 }
        trigger == want && /^    paths:$/ { inpaths = 1; next }
        inpaths && /^      - / {
            entry = $0
            sub(/^      - /, "", entry)
            gsub(/"/, "", entry)
            print entry
            next
        }
        inpaths { inpaths = 0 }
    ' "$WORKFLOW"
}

# Fail unless `$2` is an exact entry of the filter list in `$1`.
assert_listed() {
    local paths="$1" wanted="$2" why="$3"
    printf '%s\n' "$paths" | grep -qxF "$wanted" && return 0

    printf 'MISSING from integration.yml paths: %s\n  reason: %s\n' "$wanted" "$why" >&2
    printf 'current filter:\n%s\n' "$paths" >&2
    return 1
}

@test "the push and pull_request path filters are identical (#1408)" {
    # GitHub Actions does not expand YAML anchors, so the 15-line block is
    # transcribed twice by necessity. This is the only thing that keeps the
    # two copies equal: an entry added to one and forgotten in the other
    # silently halves the filter's coverage, and the half that still runs
    # makes the gap look like it is not there.
    local push pr
    push="$(paths_for push)"
    pr="$(paths_for pull_request)"

    # Vacuity guard: a parser that matched nothing would compare "" to ""
    # and pass. Both blocks are well over ten entries today.
    local count
    count="$(printf '%s\n' "$push" | grep -c . || true)"
    [ "$count" -ge 10 ] || {
        printf 'parsed only %s push path entries — the awk extractor is broken:\n%s\n' \
            "$count" "$push" >&2
        return 1
    }

    [ "$push" = "$pr" ] || {
        printf 'push and pull_request path filters DIVERGE:\n' >&2
        diff <(printf '%s\n' "$push") <(printf '%s\n' "$pr") >&2 || true
        return 1
    }
}

@test "the repo-root build context's image inputs are in the filter (#1408)" {
    # Two e2e services build `grappa:e2e` with `context: ../..` — the repo
    # root, and therefore the root Dockerfile plus the `.dockerignore` that
    # decides what gets tarred into that context. The toolchain image has no
    # `COPY`, so `.dockerignore` never lands anything IN the image; it is in
    # scope because a bad exclude breaks the context transfer itself, which
    # is exactly what its own trailing entries (`.worktrees/`, the e2e
    # cert dir) were added to prevent.
    local root_builds
    root_builds="$(grep -cE '^ +context: \.\./\.\.$' "$E2E_COMPOSE" || true)"
    [ "$root_builds" -ge 1 ] || {
        printf 'no e2e service builds from the repo root — this assertion is vacuous\n' >&2
        return 1
    }

    local paths
    paths="$(paths_for push)"
    assert_listed "$paths" "Dockerfile" \
        "the image $root_builds e2e service(s) build from context ../.."
    assert_listed "$paths" ".dockerignore" \
        "it decides what enters that same build context"
}

@test "the GRAPPA_VERSION carriers the e2e stack reads are in the filter (#1408)" {
    # The cic build container mounts only ../../cicchetto, so it cannot read
    # the version itself; the orchestration script derives it and exports it
    # (e2e compose: `GRAPPA_VERSION: ${GRAPPA_VERSION:-}`, and an empty value
    # makes vite fail loud). Both ends of that channel are derived here: the
    # consumer from the compose file, the producer from the script.
    grep -qE '^ +GRAPPA_VERSION: ' "$E2E_COMPOSE" || {
        printf 'the e2e compose no longer consumes GRAPPA_VERSION — assertion vacuous\n' >&2
        return 1
    }

    local producer
    producer="$(grep -oE '\$SRC_ROOT/[A-Za-z0-9._/-]+/version\.sh' \
                    "$REPO_ROOT/scripts/integration.sh" \
                | sed -E 's|^\$SRC_ROOT/||' | sort -u)"
    [ "$(printf '%s\n' "$producer" | grep -c .)" -eq 1 ] || {
        printf 'expected exactly one version producer in scripts/integration.sh, got:\n%s\n' \
            "$producer" >&2
        return 1
    }

    local paths
    paths="$(paths_for push)"
    assert_listed "$paths" "$producer" \
        "scripts/integration.sh runs it to export GRAPPA_VERSION"

    # ...and whatever THAT script reads, which is the version's single source
    # of truth. Derived, not transcribed: if the producer ever grows a second
    # input, the second input is required here too.
    local sources
    sources="$(grep -oE '\$\{REPO_ROOT\}/[A-Za-z0-9._/-]+' "$REPO_ROOT/$producer" \
               | sed -E 's|^\$\{REPO_ROOT\}/||' | sort -u)"
    [ -n "$sources" ] || {
        printf '%s reads no ${REPO_ROOT}-rooted file — the derivation is broken\n' \
            "$producer" >&2
        return 1
    }

    local source_file
    while IFS= read -r source_file; do
        [ -n "$source_file" ] || continue
        assert_listed "$paths" "$source_file" \
            "$producer reads it to produce GRAPPA_VERSION"
    done <<<"$sources"
}
