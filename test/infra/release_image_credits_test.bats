#!/usr/bin/env bats
#
# #1834 — the release image's credit roll arrives from OUTSIDE the build
# context, and the naked build keeps degrading honestly.
#
# `.git` is .dockerignore'd for `Dockerfile.release`, by design, so
# `infra/packaging/credits.sh` running INSIDE stage 1 can only ever answer
# `{"sha":null,"date":null,"contributors":[]}` — measured on the built dist,
# not inferred. The machine that builds the image HAS the history, so
# release.yml derives the payload on the runner and hands it in as a build
# arg; the in-context call stays as the fallback, which is what keeps a plain
# `docker build` from a source checkout working exactly as it did.
#
# THREE claims, because removing any one of them is a different defect and
# none of the three is visible from the others:
#
#   * Dockerfile.release DECLARES the arg  — without `ARG GRAPPA_CREDITS` in
#     the `cic` stage, `--build-arg` is accepted, warned about, and silently
#     ignored: the image builds green and ships the degraded roll, which is
#     the exact bug this closes wearing a fixed face.
#   * Dockerfile.release KEEPS the fallback — without it, a naked `docker
#     build` (no arg) bakes an empty `GRAPPA_CREDITS`, and vite.config.ts
#     THROWS on unset. That turns today's honest degradation into a broken
#     build, which is the one thing this change must not do.
#   * release.yml SUPPLIES it — the plumbing is worthless if the shipping job
#     stops deriving it, and that job runs only on a tag, where a regression
#     is discovered by shipping.
#
# This guard reads the recipe. The claim it CANNOT make is that the payload
# reaches the bundle — that is asserted on the artifact by probe 5 of
# `scripts/smoke-release-image.sh`, in release.yml's `smoke` job, and the two
# are complementary on purpose: this one runs on every PR and costs nothing,
# that one runs where a real image exists.

setup() {
    REPO_SRC="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    DOCKERFILE="$REPO_SRC/Dockerfile.release"
    WORKFLOW="$REPO_SRC/.github/workflows/release.yml"
}

# The `cic` stage only — an `ARG` is scoped to the stage that declares it, so
# one declared next to the `mix release` stage would look compliant to a
# whole-file grep and reach the vite build as nothing at all. Stage 1 runs
# from its `FROM ... AS cic` to the next `FROM`.
cic_stage() {
    awk '/^FROM .* AS cic$/ { inside = 1; next } /^FROM / { inside = 0 } inside' "$1"
}

declares_credits_arg() {
    grep -qE '^ARG GRAPPA_CREDITS$' <<< "$(cic_stage "$1")"
}

# The fallback, spelled as the parameter expansion that only RUNS the deriver
# when the arg is absent or empty. Matched on the pair rather than on
# `credits.sh` alone: the in-context call surviving with no `:-` in front of
# it would mean the build arg is derived, passed, declared — and overwritten.
falls_back_to_credits_sh() {
    grep -qF '${GRAPPA_CREDITS:-$(sh infra/packaging/credits.sh)}' <<< "$(cic_stage "$1")"
}

# The workflow half: the docker job derives the payload with the same script
# every other substrate uses, and hands it to the build as GRAPPA_CREDITS.
# Two greps, because either half alone passes while the channel is cut.
workflow_derives_credits() {
    grep -qF 'infra/packaging/credits.sh' "$1"
}

workflow_passes_build_arg() {
    grep -qE '^ +GRAPPA_CREDITS=\$\{\{ steps\.[a-z_]+\.outputs\.credits \}\}$' "$1"
}

@test "#1834 — Dockerfile.release's cic stage declares the GRAPPA_CREDITS build arg" {
    declares_credits_arg "$DOCKERFILE" || {
        printf 'the cic stage does not declare `ARG GRAPPA_CREDITS`; a --build-arg\n' >&2
        printf 'would be ignored and the release image would ship the degraded roll:\n' >&2
        cic_stage "$DOCKERFILE" >&2
        return 1
    }
}

@test "#1834 — Dockerfile.release still derives the credits in-context when no arg is passed" {
    falls_back_to_credits_sh "$DOCKERFILE" || {
        printf 'the cic stage lost its `${GRAPPA_CREDITS:-$(sh infra/packaging/credits.sh)}`\n' >&2
        printf 'fallback. A naked `docker build` would hand vite an EMPTY GRAPPA_CREDITS,\n' >&2
        printf 'which vite.config.ts throws on — an honest degradation turned into a\n' >&2
        printf 'broken build:\n' >&2
        cic_stage "$DOCKERFILE" >&2
        return 1
    }
}

@test "#1834 — release.yml derives the credits on the runner and passes them as a build arg" {
    workflow_derives_credits "$WORKFLOW" || {
        printf 'release.yml no longer calls infra/packaging/credits.sh — the runner has\n' >&2
        printf 'the history and the build context does not, so nothing else can derive it.\n' >&2
        return 1
    }
    workflow_passes_build_arg "$WORKFLOW" || {
        printf 'release.yml does not pass GRAPPA_CREDITS as a build arg to the image\n' >&2
        printf 'build. Deriving it and not handing it over ships the degraded roll.\n' >&2
        grep -n 'build-args' -A 4 "$WORKFLOW" >&2 || true
        return 1
    }
}

@test "#1834 — RED: an ARG declared outside the cic stage does not satisfy the guard" {
    local fake="$BATS_TEST_TMPDIR/Dockerfile.release"
    cat > "$fake" <<'EOF'
FROM oven/bun:1-alpine AS cic
RUN GRAPPA_CREDITS="${GRAPPA_CREDITS:-$(sh infra/packaging/credits.sh)}" \
    && bun run build

FROM elixir:1.19-otp-28-alpine AS build
ARG GRAPPA_CREDITS
RUN mix release
EOF
    run declares_credits_arg "$fake"
    [ "$status" -ne 0 ]

    # POSITIVE control: the same predicate MUST accept the declaration once it
    # sits in the stage that runs the vite build. Without this, a predicate
    # broken into always-false would report the RED above as a pass.
    local ok="$BATS_TEST_TMPDIR/Dockerfile.ok"
    cat > "$ok" <<'EOF'
FROM oven/bun:1-alpine AS cic
ARG GRAPPA_CREDITS
RUN bun run build

FROM elixir:1.19-otp-28-alpine AS build
RUN mix release
EOF
    run declares_credits_arg "$ok"
    [ "$status" -eq 0 ]
}

@test "#1834 — RED: an unconditional in-context derive does not satisfy the fallback guard" {
    # The pre-#1834 shape. It builds, it is green, and it overwrites whatever
    # the build arg carried — the failure mode the `:-` spelling exists to
    # make unrepresentable.
    local fake="$BATS_TEST_TMPDIR/Dockerfile.overwrite"
    cat > "$fake" <<'EOF'
FROM oven/bun:1-alpine AS cic
ARG GRAPPA_CREDITS
RUN GRAPPA_CREDITS="$(sh infra/packaging/credits.sh)" \
    && export GRAPPA_CREDITS \
    && bun run build
EOF
    run falls_back_to_credits_sh "$fake"
    [ "$status" -ne 0 ]

    # POSITIVE control, same reason as above.
    local ok="$BATS_TEST_TMPDIR/Dockerfile.fallback"
    cat > "$ok" <<'EOF'
FROM oven/bun:1-alpine AS cic
ARG GRAPPA_CREDITS
RUN GRAPPA_CREDITS="${GRAPPA_CREDITS:-$(sh infra/packaging/credits.sh)}" \
    && export GRAPPA_CREDITS \
    && bun run build
EOF
    run falls_back_to_credits_sh "$ok"
    [ "$status" -eq 0 ]
}
