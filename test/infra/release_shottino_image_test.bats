#!/usr/bin/env bats
#
# Bats suite for GH #1168 — the `shottino --ircd` bridge image is PUBLISHED.
#
# Before this, `release.yml` pushed exactly ONE image (`ghcr.io/<owner>/grappa`)
# and `Dockerfile.shottino`'s only consumer was compose, as a local `build:`.
# So every operator who switched the bridge on compiled C against
# ncursesw/openssl themselves — the one distribution channel where the client
# was missing, while deb / Arch / rpm all shipped it.
#
# The publish step itself cannot be exercised here, or anywhere else a
# contributor can reach: the `docker` job runs only on a `v*` TAG PUSH or an
# explicit `docker_validation` dispatch. What CAN be held still is the shape
# of the two builds, and that is what this suite pins — because every way this
# breaks is silent at author time and loud only on a real release:
#
#   * the bridge ships amd64-only, so the arm64 operator still compiles —
#     the problem #1168 exists to remove, closed for half the audience;
#   * the bridge's `push:` drifts off the bouncer's event gate, and a
#     `docker_validation` DRY RUN publishes to ghcr;
#   * the two builds resolve to the same repository or the same tag list, and
#     the bridge OVERWRITES the bouncer image at `:latest`;
#   * the `:latest` semver gate gets hand-copied, and a backport moves one
#     `:latest` pointer without the other.
#
# Every check DERIVES both sides and compares them (CLAUDE.md: derive, don't
# duplicate) — the platform list, the event gate and the label set are never
# re-typed here, so they stay correct when the bouncer's change. A derivation
# that matched nothing would pass vacuously, so each one carries a floor.

load ../bats_helpers

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
    WORKFLOW="$REPO_ROOT/.github/workflows/release.yml"
}

# The `docker` job ONLY. Job headers sit at two spaces and everything inside
# is deeper, so the next two-space key ends the job. The scoping is not
# cosmetic: `push:` is also a top-level `on:` trigger, and the job's own prose
# says "push:false" repeatedly.
docker_job() {
    awk '/^  docker:/ { f = 1; print; next } f && /^  [a-z_-]+:/ { exit } f' "$WORKFLOW"
}

# Values of a `with:` key across the job's build steps, in file order.
# Anchored at the key's exact column so a COMMENT can never match: at that
# column a comment has `#`, not the key.
with_values() {
    docker_job | sed -n "s/^          $1: //p"
}

# The `smoke` job only (#1162), by the same two-space boundary rule.
smoke_job() {
    awk '/^  smoke:/ { f = 1; print; next } f && /^  [a-z_-]+:/ { exit } f' "$WORKFLOW"
}

# The gha cache scope WRITTEN by the docker-job build step that builds the
# named Dockerfile. Per-step: `hit` is armed by that step's `file:` key and
# disarmed at the next step boundary, so the scope printed is that step's own.
scope_written_for() {
    docker_job | awk -v want="          file: $1" '
        /^      - / { hit = 0 }
        $0 == want { hit = 1 }
        hit && /^          cache-to: .*,scope=/ {
            s = $0; sub(/^.*,scope=/, "", s); print s
        }
    '
}

# How many lines the argument holds (0 for the empty string, which `wc -l`
# would otherwise also call 0 — hence the explicit empty case).
line_count() {
    [ -n "$1" ] || { echo 0; return 0; }
    printf '%s\n' "$1" | wc -l | tr -d ' '
}

@test "the docker job builds exactly two images — bouncer and bridge (#1168)" {
    files="$(with_values file)"
    [ "$(line_count "$files")" -eq 2 ] || {
        echo "expected exactly 2 build-push steps in the docker job, got:" >&2
        printf '%s\n' "$files" >&2
        return 1
    }

    # Only the BRIDGE is named here. The bouncer's own path is covered by the
    # exists-check below, and naming it in both places would mean one typo
    # reddened two tests and neither told you which layer broke.
    printf '%s\n' "$files" | grep -qx 'Dockerfile.shottino' || {
        echo "the bridge image build is gone — #1168 is undone:" >&2
        printf '%s\n' "$files" >&2
        return 1
    }
}

@test "every Dockerfile the docker job names is a real file (#1168)" {
    # A typo'd `file:` fails only on a real tag push, where the release is
    # already half-published. Catch it as a unit failure instead.
    files="$(with_values file)"
    [ -n "$files" ]

    missing=""
    while IFS= read -r f; do
        [ -f "$REPO_ROOT/$f" ] || missing="${missing}${f}"$'\n'
    done <<<"$files"

    [ -z "$missing" ] || {
        echo "the docker job names Dockerfile(s) that do not exist:" >&2
        printf '%s' "$missing" >&2
        return 1
    }
}

@test "the bridge is built for the SAME platform matrix as the bouncer (#1168)" {
    # The ruling behind #1168: an arm64 operator who still has to compile the
    # bridge is the very problem the issue closes. Derived, never re-typed —
    # widen the bouncer's matrix tomorrow and the bridge must follow.
    platforms="$(with_values platforms)"
    [ "$(line_count "$platforms")" -eq 2 ] || {
        echo "expected a platforms: list on both build steps, got:" >&2
        printf '%s\n' "$platforms" >&2
        return 1
    }

    distinct="$(printf '%s\n' "$platforms" | sort -u | wc -l | tr -d ' ')"
    [ "$distinct" -eq 1 ] || {
        echo "the two images are built for DIFFERENT platform matrices:" >&2
        printf '%s\n' "$platforms" >&2
        return 1
    }
}

@test "the bridge publishes on exactly the bouncer's event gate (#1168)" {
    # `push: ${{ github.event_name == 'push' }}` is what makes a
    # docker_validation dispatch a ZERO-PUBLICATION dry run. A bridge step that
    # hardcodes `push: true` would publish from a dry run — the one thing that
    # gate exists to make impossible.
    pushes="$(with_values push)"
    [ "$(line_count "$pushes")" -eq 2 ] || {
        echo "expected a push: gate on both build steps, got:" >&2
        printf '%s\n' "$pushes" >&2
        return 1
    }

    distinct="$(printf '%s\n' "$pushes" | sort -u | wc -l | tr -d ' ')"
    [ "$distinct" -eq 1 ] || {
        echo "the two images do NOT share one publish gate:" >&2
        printf '%s\n' "$pushes" >&2
        return 1
    }
}

@test "the two images push to DIFFERENT repositories (#1168)" {
    # Same repository for both and the bridge's manifest REPLACES the
    # bouncer's at the same tag — a release that silently ships a 5 MB IRC
    # client where the server should be.
    # `sed -E`, not a BRE `\|`: BSD sed has no alternation in a basic regex,
    # so the BRE spelling matched nothing here and the check passed on GNU
    # while failing on darwin.
    names="$(docker_job | sed -nE 's/^ {10}(shottino_name|name)="(.*)"$/\2/p')"
    [ "$(line_count "$names")" -eq 2 ] || {
        echo "expected two image-name assignments in the tag step, got:" >&2
        printf '%s\n' "$names" >&2
        return 1
    }

    distinct="$(printf '%s\n' "$names" | sort -u | wc -l | tr -d ' ')"
    [ "$distinct" -eq 2 ] || {
        echo "both images resolve to the SAME ghcr repository:" >&2
        printf '%s\n' "$names" >&2
        return 1
    }
}

@test "the two build steps consume DIFFERENT tag lists (#1168)" {
    # The sibling of the check above, one layer down: distinct repositories
    # bought nothing if the bridge step is wired to the bouncer's tag output.
    tags="$(with_values tags)"
    [ "$(line_count "$tags")" -eq 2 ] || {
        echo "expected a tags: list on both build steps, got:" >&2
        printf '%s\n' "$tags" >&2
        return 1
    }

    distinct="$(printf '%s\n' "$tags" | sort -u | wc -l | tr -d ' ')"
    [ "$distinct" -eq 2 ] || {
        echo "both build steps push the SAME tag list:" >&2
        printf '%s\n' "$tags" >&2
        return 1
    }
}

@test "ONE semver gate decides :latest for both images (#1168)" {
    # Bouncer and bridge are cut from the same tag, so a backport that must
    # not move `:latest` must not move EITHER. A second hand-copied comparison
    # is how the two pointers end up on different releases.
    gates="$(docker_job | grep -c -- '--sort=-v:refname' || true)"
    [ "$gates" -eq 1 ] || {
        echo "expected exactly ONE highest-semver comparison, found ${gates}" >&2
        docker_job | grep -n -- '--sort=-v:refname' >&2 || true
        return 1
    }

    # ...and that one gate must actually be applied to both tag lists.
    emits="$(docker_job | grep -c '^          emit_tags ' || true)"
    [ "$emits" -eq 2 ] || {
        echo "expected the shared tag emitter to run for both images, found ${emits}" >&2
        return 1
    }
}

@test "both images carry the same three OCI labels (#1168)" {
    # The labels are what make a ghcr package page link back to the source and
    # the exact commit. The bridge landing without them is invisible until
    # somebody needs to know what they pulled.
    for key in source version revision; do
        n="$(docker_job | grep -c "^            org\.opencontainers\.image\.${key}=" || true)"
        [ "$n" -eq 2 ] || {
            echo "OCI label '${key}' is on ${n} image(s), expected 2" >&2
            docker_job | grep -n 'org\.opencontainers\.image\.' >&2 || true
            return 1
        }
    done
}

@test "the two builds do not share a gha cache scope (#1168)" {
    # One job, two builds, one gha cache backend: unscoped they land in the
    # same bucket and each release evicts the other's layers. Slow, never
    # wrong, and therefore never noticed.
    scopes="$(docker_job | sed -n 's/^          cache-to: .*,scope=\(.*\)$/\1/p')"
    [ "$(line_count "$scopes")" -eq 2 ] || {
        echo "expected an explicit cache scope on both build steps, got:" >&2
        printf '%s\n' "$scopes" >&2
        return 1
    }

    distinct="$(printf '%s\n' "$scopes" | sort -u | wc -l | tr -d ' ')"
    [ "$distinct" -eq 2 ] || {
        echo "both builds write the SAME gha cache scope:" >&2
        printf '%s\n' "$scopes" >&2
        return 1
    }
}

@test "the smoke job reads the scope the bouncer build writes (#1168, #1162)" {
    # #1162's dry-run leg re-exports the release image from layers the docker
    # job wrote moments earlier. Naming a scope for the BRIDGE's sake (above)
    # moves that write out of the default bucket, so an unscoped read here
    # finds nothing and rebuilds the whole image instead. The failure is slow
    # and CORRECT, which is exactly why nobody would notice it.
    #
    # Both sides are derived, from different regions of the file: the write
    # from the docker job's own Dockerfile.release step, the read from the
    # smoke job.
    written="$(scope_written_for Dockerfile.release)"
    [ "$(line_count "$written")" -eq 1 ] || {
        echo "could not derive the bouncer build's cache-to scope, got:" >&2
        printf '%s\n' "$written" >&2
        return 1
    }

    read_scope="$(smoke_job | sed -nE 's/^ {10}cache-from: .*,scope=(.+)$/\1/p')"
    [ "$(line_count "$read_scope")" -eq 1 ] || {
        echo "the smoke job has no scoped cache-from, got:" >&2
        printf '%s\n' "$read_scope" >&2
        return 1
    }

    [ "$written" = "$read_scope" ] || {
        echo "smoke reads scope '${read_scope}' but the bouncer writes '${written}'" >&2
        return 1
    }
}
