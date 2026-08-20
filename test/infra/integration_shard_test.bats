#!/usr/bin/env bats
#
# Bats suite for GH #1519 — the sharded `integration` workflow must not be
# able to report green while running fewer tests than the suite has.
#
# Sharding splits one 40-minute job into four that each run a QUARTER of the
# Playwright suite. The win is real and measured, but it moves the gate's
# honesty from "one job ran everything" to "four filters partition
# everything", and a partition can break in ways that are invisible from a
# green tick:
#
#   WRONG DENOMINATOR   `--shard=i/N` with N != the number of jobs. Too big
#                       and the tail of the suite is never run by anyone; too
#                       small and shards overlap. Playwright is happy either
#                       way — it filters, it does not audit.
#   NAME COLLISION      four jobs uploading the same artifact name. v4+ of
#                       upload-artifact REFUSES a duplicate, so the loser's
#                       step fails and the evidence for the red being triaged
#                       is the thing that goes missing.
#   CANCELLED SIBLINGS  `fail-fast` defaults to TRUE: one red shard cancels
#                       the other three, turning one failure into three
#                       unknowns and destroying the comparison the triage
#                       runbook is built on.
#   SKIPPED AGGREGATE   a `needs:` job without `if: always()` is SKIPPED when
#                       a dependency fails, and a skipped check reads as
#                       "nothing to see" rather than as a failure.
#
# Every check DERIVES its expectation from the workflow itself — the shard
# list is read, never transcribed — so raising the shard count is a one-line
# edit that this suite follows. A hardcoded 4 here would be a second copy of
# the number, i.e. the very drift being guarded against.
#
# The denominator is `${{ strategy.job-total }}` and that is why the
# single-dimension check below exists: job-total counts matrix LEGS, not
# `shard` values, so a second dimension (say an `os:` axis) would double the
# legs while the shard values stayed 1..4, and every test would run twice
# under a denominator nobody edited.

REPO_ROOT="$BATS_TEST_DIRNAME/../.."
WORKFLOW="$REPO_ROOT/.github/workflows/integration.yml"

# The `matrix:` block's keys, one per line. Two-space-deeper indent than
# `matrix:` itself, which under `jobs.<id>.strategy` is eight spaces.
matrix_keys() {
    awk '
        /^      matrix:$/ { inmatrix = 1; next }
        inmatrix && /^        [a-zA-Z_-]+:/ {
            key = $1; sub(/:$/, "", key); print key; next
        }
        inmatrix && /^ {0,7}[a-zA-Z_-]/ { inmatrix = 0 }
    ' "$WORKFLOW"
}

# The shard values as a whitespace-separated list, read off the matrix.
shard_values() {
    sed -n 's/^        shard: *\[\(.*\)\]$/\1/p' "$WORKFLOW" | tr -d ' ' | tr ',' ' '
}

# Artifact names: the `name:` that follows each `uses: actions/upload-artifact`.
artifact_names() {
    awk '
        /uses: actions\/upload-artifact/ { pending = 1; next }
        pending && /^ +name: / {
            line = $0; sub(/^ +name: /, "", line); print line; pending = 0
        }
    ' "$WORKFLOW"
}

@test "the shard matrix has exactly one dimension (#1519)" {
    keys="$(matrix_keys)"

    # Vacuity guard: a parser that matched nothing would compare "" to
    # "shard" and fail loudly, but one that matched everything would pass
    # this by accident. State the count.
    count="$(printf '%s\n' "$keys" | grep -c . || true)"
    [ "$count" -eq 1 ] || {
        printf 'expected exactly 1 matrix dimension, found %s:\n%s\n' "$count" "$keys" >&2
        printf 'the shard denominator is ${{ strategy.job-total }}, which counts LEGS.\n' >&2
        printf 'a second dimension multiplies the legs and the denominator goes stale.\n' >&2
        return 1
    }
    [ "$keys" = "shard" ] || {
        printf 'the single matrix dimension is %s, expected shard\n' "$keys" >&2
        return 1
    }
}

@test "the shard values are 1..N with no gap and no repeat (#1519)" {
    values="$(shard_values)"

    n="$(printf '%s\n' $values | grep -c . || true)"
    [ "$n" -ge 2 ] || {
        printf 'parsed %s shard value(s) from the matrix — the extractor is wrong or the suite is not sharded:\n%s\n' \
            "$n" "$values" >&2
        return 1
    }

    expected="$(seq 1 "$n" | tr '\n' ' ')"
    actual="$(printf '%s\n' $values | sort -n | tr '\n' ' ')"
    [ "$expected" = "$actual" ] || {
        printf 'shard values are [%s], expected the contiguous [%s]\n' "$actual" "$expected" >&2
        printf 'Playwright reads i/N positionally: a gap leaves a slice of the suite unrun,\n' >&2
        printf 'a repeat runs one twice, and both report green.\n' >&2
        return 1
    }
}

@test "the shard denominator is derived from the matrix, never a literal (#1519)" {
    invocation="$(grep -n -- '--shard=' "$WORKFLOW" || true)"

    [ -n "$invocation" ] || {
        echo "no --shard= invocation in the workflow at all" >&2
        return 1
    }

    printf '%s\n' "$invocation" \
        | grep -qF -- '--shard=${{ matrix.shard }}/${{ strategy.job-total }}' || {
        printf 'the --shard invocation does not derive its denominator:\n%s\n' "$invocation" >&2
        printf 'expected --shard=${{ matrix.shard }}/${{ strategy.job-total }} — a literal N is a\n' >&2
        printf 'second copy of the matrix length, free to drift away from it silently.\n' >&2
        return 1
    }
}

@test "every uploaded artifact name carries the shard (#1519)" {
    names="$(artifact_names)"

    count="$(printf '%s\n' "$names" | grep -c . || true)"
    [ "$count" -ge 4 ] || {
        printf 'parsed %s artifact name(s) — the extractor is wrong (the job uploads four):\n%s\n' \
            "$count" "$names" >&2
        return 1
    }

    violations="$(printf '%s\n' "$names" | grep -vF '${{ matrix.shard }}' || true)"
    [ -z "$violations" ] || {
        printf 'artifact name(s) shared by every shard:\n%s\n' "$violations" >&2
        printf 'upload-artifact v4+ rejects a duplicate name within a run, so three of the\n' >&2
        printf 'four uploads fail and the failure being triaged loses its evidence.\n' >&2
        return 1
    }
}

@test "one red shard does not cancel the others (#1519)" {
    grep -qE '^      fail-fast: false$' "$WORKFLOW" || {
        printf 'fail-fast is not explicitly false under strategy: — it defaults to TRUE,\n' >&2
        printf 'which cancels the surviving shards and replaces three results with three\n' >&2
        printf 'unknowns exactly when the comparison is needed.\n' >&2
        grep -n -A3 '^    strategy:$' "$WORKFLOW" >&2 || true
        return 1
    }
}

@test "the aggregate job runs even when a shard fails (#1519)" {
    # `needs:` alone makes the job SKIPPED on a failed dependency, and a
    # skipped check is not a red one. The pairing is what makes the single
    # stable check name honest.
    block="$(awk '/^  e2e-result:$/ { inblock = 1 } inblock { print } inblock && /^      - name: / { exit }' "$WORKFLOW")"

    [ -n "$block" ] || {
        echo "no e2e-result aggregate job in the workflow" >&2
        return 1
    }

    printf '%s\n' "$block" | grep -qE '^    if: always\(\)$' || {
        printf 'e2e-result lacks `if: always()`:\n%s\n' "$block" >&2
        return 1
    }
    printf '%s\n' "$block" | grep -qE '^    needs: e2e$' || {
        printf 'e2e-result does not depend on the shard job:\n%s\n' "$block" >&2
        return 1
    }
}
