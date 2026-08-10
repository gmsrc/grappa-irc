#!/usr/bin/env bats
#
# Bats suite for GH #1160 — the minimal compose for the PUBLISHED image.
#
# The fastest documented path that does not compile from source is
# `curl -fsSL …/infra/docker/get.sh | bash`. Operators who will not pipe a
# remote script into a shell had nowhere to go: no copy-pasteable compose for
# `ghcr.io/vjt/grappa`. `compose.release.yaml` is that file, and it is
# deliberately BORING — the image, a named volume at /data, a published port,
# and PHX_HOST.
#
# What is actually worth guarding is not the YAML's prettiness but the two
# claims the file makes by existing:
#
#   1. It is NOT the dev stack. No build context, no profiles, no bind mounts,
#      and `compose.yaml` never learns to reference the published image. Two
#      files, two jobs — merging them recreates the confusion #1160 is about.
#   2. PHX_HOST is the ONLY prod-mandatory variable the image cannot supply
#      for itself. That is a claim about THREE other files, and nothing
#      enforced it: `config/runtime.exs` raises for eight variables in prod,
#      `Dockerfile.release` bakes some as ENV, and
#      `infra/docker/release-entrypoint.sh` generates the rest onto /data on
#      first boot (#862). The residue is what a compose file must carry. Add a
#      ninth mandatory variable tomorrow and this compose silently ships a
#      container that dies at boot — unless this pin fails first.
#
# The env sets are DERIVED from those three files, never re-typed here
# (CLAUDE.md: derive, don't duplicate). A derivation that silently matches
# nothing would pass vacuously, so each one carries a floor — and the floors
# are not decoration: the first draft of the `missing_secret.(` pattern missed
# GRAPPA_ENCRYPTION_KEY, whose call site wraps across two lines.

REPO_ROOT="$BATS_TEST_DIRNAME/../.."
RELEASE_COMPOSE="$REPO_ROOT/compose.release.yaml"
DEV_COMPOSE="$REPO_ROOT/compose.yaml"
RUNTIME_EXS="$REPO_ROOT/config/runtime.exs"
RELEASE_DOCKERFILE="$REPO_ROOT/Dockerfile.release"
ENTRYPOINT="$REPO_ROOT/infra/docker/release-entrypoint.sh"

# Every env var config/runtime.exs REFUSES TO BOOT without under MIX_ENV=prod.
# Two shapes reach the raise: a literal `raise "environment variable X is
# missing"`, and the two shared raisers `missing_secret.("X", …)` /
# `missing_vapid.("X")`. The call sites of the latter wrap across lines, so
# the file is flattened before matching — a line-wise grep loses one of them.
prod_mandatory_vars() {
    {
        grep -oE 'environment variable [A-Z][A-Z0-9_]* is missing' "$RUNTIME_EXS" \
            | awk '{print $3}'
        tr '\n' ' ' < "$RUNTIME_EXS" \
            | grep -oE 'missing_(secret|vapid)\.\( *"[A-Z][A-Z0-9_]*"' \
            | grep -oE '"[A-Z_]*"' | tr -d '"'
    } | sort -u
}

# Vars the release image bakes into its own environment (Dockerfile.release
# `ENV`), so the operator never supplies them. Comment lines cannot match:
# the name must sit at the start of a continuation line or after `ENV`.
image_baked_vars() {
    grep -E '^[[:space:]]*(ENV[[:space:]]+)?[A-Z][A-Z0-9_]*=' "$RELEASE_DOCKERFILE" \
        | sed -E 's/^[[:space:]]*(ENV[[:space:]]+)?([A-Z][A-Z0-9_]*)=.*/\2/' \
        | sort -u
}

# Vars the entrypoint generates onto /data on first boot (#862) — the `for key
# in …` list it loops over to find the blanks. `tr -c` splits on anything that
# is not an uppercase name character, which strips the trailing `; do`.
entrypoint_generated_vars() {
    sed -n '/^for key in /,/do$/p' "$ENTRYPOINT" \
        | tr -c 'A-Z0-9_\n' '\n' \
        | grep -E '^[A-Z][A-Z0-9_]{2,}$' \
        | sort -u
}

# The `environment:` keys the release compose sets, by indentation: the block
# ends at the first non-blank line indented no deeper than `environment:`.
release_compose_env_keys() {
    awk '
        /^[[:space:]]*environment:[[:space:]]*$/ {
            in_env = 1; env_indent = match($0, /[^ ]/); next
        }
        in_env {
            if ($0 ~ /^[[:space:]]*$/) next
            if (match($0, /[^ ]/) <= env_indent) { in_env = 0; next }
            if ($0 ~ /^[[:space:]]*#/) next
            line = $0
            sub(/^[[:space:]]*/, "", line)
            sub(/[:=].*/, "", line)
            print line
        }
    ' "$RELEASE_COMPOSE" | sort -u
}

@test "compose.release.yaml exists (#1160)" {
    [ -f "$RELEASE_COMPOSE" ]
}

@test "it pulls the published ghcr image (#1160)" {
    # An `image:` key, resolving to the published repository with a tag.
    images="$(grep -E '^[[:space:]]*image:' "$RELEASE_COMPOSE" || true)"
    [ -n "$images" ]

    foreign="$(printf '%s\n' "$images" | grep -vE 'ghcr\.io/vjt/grappa:[A-Za-z0-9._-]+' || true)"
    [ -z "$foreign" ] || {
        echo "release compose references an image that is not the published one:" >&2
        printf '%s\n' "$foreign" >&2
        return 1
    }
}

@test "it has no build context — pull, never compile (#1160)" {
    offenders="$(grep -nE '^[[:space:]]*build:' "$RELEASE_COMPOSE" || true)"
    [ -z "$offenders" ] || {
        echo "a build: key turns the release compose back into the dev stack:" >&2
        printf '%s\n' "$offenders" >&2
        return 1
    }
}

@test "it has no profiles — one file, one service, no hidden modes (#1160)" {
    offenders="$(grep -nE '^[[:space:]]*profiles:' "$RELEASE_COMPOSE" || true)"
    [ -z "$offenders" ] || {
        echo "a profiles: key means the operator must know which mode to ask for:" >&2
        printf '%s\n' "$offenders" >&2
        return 1
    }
}

@test "it has no bind mounts — state lives on a named volume (#1160)" {
    # A bind mount's source is a host path: it starts with `.`, `/` or `~`.
    # A named volume's source is a plain identifier. Published ports are
    # unaffected — `127.0.0.1:4000:4000` starts with a digit.
    offenders="$(grep -nE '^[[:space:]]*-[[:space:]]*"?[.~/]' "$RELEASE_COMPOSE" || true)"
    [ -z "$offenders" ] || {
        echo "a bind mount ties the release compose to a checkout layout:" >&2
        printf '%s\n' "$offenders" >&2
        return 1
    }
}

@test "the named volume is mounted at /data (#1160)" {
    # /data is where Dockerfile.release puts the DB, the uploads root and the
    # generated grappa.env — mount anything else and first boot regenerates
    # secrets on every recreate.
    grep -qE '^[[:space:]]*-[[:space:]]*"?[A-Za-z0-9_-]+:/data"?[[:space:]]*$' "$RELEASE_COMPOSE"
}

@test "the compose project name is pinned to the file, not the directory (#1160)" {
    # Without a top-level `name:`, compose derives the project from the
    # CONTAINING DIRECTORY, and the volume is named after the project. Rename
    # or move the folder and the same file resolves to a DIFFERENT volume: an
    # empty database, freshly generated secrets, and an operator who believes
    # they lost their data. A file that detaches state when you move it does
    # not keep this issue's promise.
    grep -qE '^name:[[:space:]]*[A-Za-z0-9][A-Za-z0-9_.-]*[[:space:]]*$' "$RELEASE_COMPOSE"
}

@test "it says updates on this path are COLD, and gives the command (#1160)" {
    # The release image has no Phoenix.CodeReloader: pull + recreate is the
    # only correct update, and a compose file invites the hot-edit loop unless
    # it says otherwise.
    grep -qi 'cold' "$RELEASE_COMPOSE"
    grep -q 'docker compose -f compose.release.yaml pull' "$RELEASE_COMPOSE"
}

@test "it notes that :latest can be pinned (#1160)" {
    # `latest` is what a newcomer wants; a pin is what an operator wants. The
    # sample ships the former and must name the latter.
    grep -q 'latest' "$RELEASE_COMPOSE"
    grep -qi 'pin' "$RELEASE_COMPOSE"
}

@test "compose.yaml stays the DEV stack — it never names the published image (#1160)" {
    offenders="$(grep -n 'ghcr.io/vjt/grappa' "$DEV_COMPOSE" || true)"
    [ -z "$offenders" ] || {
        echo "compose.yaml took over the release-image path — that is the merge #1160 refuses:" >&2
        printf '%s\n' "$offenders" >&2
        return 1
    }
}

@test "the env derivations are not vacuous (#1160)" {
    # Floors, not counts: they fail when a pattern stops matching, which is
    # how a derived pin dies quietly. Raise them only alongside a real change
    # to the files they read.
    required="$(prod_mandatory_vars | grep -c . || true)"
    [ "$required" -ge 8 ] || {
        echo "expected >=8 prod-mandatory vars in config/runtime.exs, derived $required" >&2
        prod_mandatory_vars >&2
        return 1
    }

    generated="$(entrypoint_generated_vars | grep -c . || true)"
    [ "$generated" -ge 6 ] || {
        echo "expected >=6 first-boot generated vars in the entrypoint, derived $generated" >&2
        entrypoint_generated_vars >&2
        return 1
    }

    # PHX_HOST is the one the whole file exists for. A derivation that loses
    # it would leave an empty residue and pass every check below.
    prod_mandatory_vars | grep -qx 'PHX_HOST'
}

@test "the compose supplies EXACTLY the mandatory vars the image cannot (#1160)" {
    # residue = mandatory - baked into the image - generated on first boot.
    # Measured on cbe6cb9a: {PHX_HOST}. Not asserted as that literal — the
    # point is that the compose tracks the residue, whatever it becomes.
    residue="$(comm -23 \
        <(comm -23 <(prod_mandatory_vars) <(image_baked_vars)) \
        <(entrypoint_generated_vars))"

    supplied="$(release_compose_env_keys)"

    uncovered="$(comm -23 <(printf '%s\n' "$residue") <(printf '%s\n' "$supplied"))"
    [ -z "$uncovered" ] || {
        echo "config/runtime.exs raises for these in prod and nothing on the image" >&2
        echo "path supplies them — compose.release.yaml boots a container that dies:" >&2
        printf '%s\n' "$uncovered" >&2
        return 1
    }

    # The other direction: a var the image already provides does not belong in
    # a file whose whole selling point is that it is short.
    redundant="$(comm -13 <(printf '%s\n' "$residue") <(printf '%s\n' "$supplied"))"
    [ -z "$redundant" ] || {
        echo "compose.release.yaml sets vars the image already supplies:" >&2
        printf '%s\n' "$redundant" >&2
        return 1
    }
}
