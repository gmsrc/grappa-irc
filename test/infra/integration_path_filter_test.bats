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
# The rule the version check enforces, stated once: A FILE BELONGS IN THE
# FILTER WHEN THE E2E STACK READS IT. Read is meant literally and is measured
# literally — the invocation `scripts/integration.sh` makes is re-run under a
# shell trace and the files it names are the requirement. That phrasing is
# load-bearing since #1447 gave the producer a second component: a file the
# producer can read for SOME argument is not a suite input, only the files it
# reads for the argument the suite passes are. The rule is never softened into
# an exclusion list — an exception named after a file is the drift this suite
# was written to catch, so the ONLY way a path leaves the requirement is by
# ceasing to be read.
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

# The repo-rooted regular files named anywhere in a `sh -x` trace, read from
# stdin. Deliberately an OVER-approximation of "reads": a path the run merely
# names, but never opens, still earns a filter entry. The failure this gate
# exists to prevent is a MISSING entry, so erring towards more is the safe
# direction — an over-wide filter runs a suite that did not need to run, an
# under-wide one lets a breaking change through without running it at all.
files_named_in_trace() {
    local token
    tr ' ' '\n' | while IFS= read -r token; do
        token="${token%\'}"
        token="${token#\'}"
        case "$token" in
        "$REPO_ROOT"/*)
            if [ -f "$token" ]; then printf '%s\n' "${token#"$REPO_ROOT"/}"; fi
            ;;
        esac
    done | sort -u
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

    # The producer AND the arguments the orchestration hands it, captured as
    # ONE invocation: since #1447 the producer answers a different component
    # per argument, so its path alone no longer says which files get read.
    local invocation
    invocation="$(grep -oE '"\$SRC_ROOT/[A-Za-z0-9._/-]+/version\.sh"[^)]*' \
                      "$REPO_ROOT/scripts/integration.sh" | sort -u)"
    [ "$(printf '%s\n' "$invocation" | grep -c .)" -eq 1 ] || {
        printf 'expected exactly one version invocation in scripts/integration.sh, got:\n%s\n' \
            "$invocation" >&2
        return 1
    }

    local producer args
    producer="$(printf '%s' "$invocation" | sed -E 's|^"\$SRC_ROOT/||; s|".*$||')"
    args="$(printf '%s' "$invocation" | sed -E 's|^"[^"]*"||; s|^ +||' | tr -d '"')"

    local paths
    paths="$(paths_for push)"
    assert_listed "$paths" "$producer" \
        "scripts/integration.sh runs it to export GRAPPA_VERSION"

    # ...and whatever THAT INVOCATION reads. The rule is a property, never a
    # list and never an exclusion: a file belongs in the filter when the e2e
    # stack's own run of the producer touches it — the same reason `VERSION`
    # is in there. So the read set is OBSERVED rather than parsed out of the
    # producer's source: the very invocation above is re-run under a shell
    # trace, with the same argument, and the repo-rooted files it names are
    # required. A producer that grows a second input for THIS component grows
    # the requirement with it; one that reads a file only for some OTHER
    # component the e2e stack never asks for was never a suite input, and
    # naming it here would assert a dependency that does not exist.
    #
    # Limit, stated rather than papered over: a trace observes the branch
    # this host takes. A producer that reads a different file per platform
    # would need every platform traced, and this sees one.
    local trace rc=0
    # shellcheck disable=SC2086  # $args is the argument LIST — splitting is the point
    trace="$(cd "$REPO_ROOT" && sh -x "$REPO_ROOT/$producer" $args 2>&1 >/dev/null)" || rc=$?
    [ "$rc" -eq 0 ] || {
        printf 'the e2e invocation `%s %s` failed (rc=%s) — cannot derive its reads:\n%s\n' \
            "$producer" "$args" "$rc" "$trace" >&2
        return 1
    }

    local sources
    sources="$(printf '%s\n' "$trace" | files_named_in_trace)"
    [ -n "$sources" ] || {
        printf 'tracing `%s %s` named no file under %s — the derivation is broken:\n%s\n' \
            "$producer" "$args" "$REPO_ROOT" "$trace" >&2
        return 1
    }

    local source_file
    while IFS= read -r source_file; do
        [ -n "$source_file" ] || continue
        assert_listed "$paths" "$source_file" \
            "the e2e stack's own \`$producer $args\` run reads it to produce GRAPPA_VERSION"
    done <<<"$sources"
}
