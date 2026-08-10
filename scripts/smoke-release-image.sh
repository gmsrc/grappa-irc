#!/usr/bin/env bash
# smoke-release-image.sh — deploy the published release image FOR REAL, then
# ask it questions (#1162).
#
# test/infra/*.bats covers the deploy SCRIPTS with `docker` stubbed on PATH:
# every assertion there is about which file a verb writes and which flags it
# would pass. Nothing boots the image. #1161 is the bug class that costs:
# the container starts, the API answers, the env is well-formed, every script
# did its job — and the frontend is 404 because a variable pointed one
# directory to the left. No script-level assertion can see it; one HTTP GET
# can.
#
# This is that GET, plus three more probes, against a container that was
# brought up by the SAME infra/docker/get.sh -> deploy.sh path an operator
# runs (GRAPPA_RAW_BASE points get.sh at this checkout instead of GitHub raw,
# so the mirror step is exercised too — a file get.sh forgets to mirror is
# itself a shipped-deploy bug).
#
#   usage:  docker pull ghcr.io/vjt/grappa:vX.Y.Z
#           GRAPPA_IMAGE=ghcr.io/vjt/grappa:vX.Y.Z \
#           GRAPPA_SMOKE_VERSION=X.Y.Z \
#             scripts/smoke-release-image.sh
#
#   GRAPPA_IMAGE          (required) the image ref under test, already local.
#   GRAPPA_SMOKE_VERSION  (required) the version the running node must report.
#   GRAPPA_SMOKE_PUBLISH  host:port to publish on (default 127.0.0.1:14000).
#
# A MISSING IMAGE IS A FAILURE, NEVER A SKIP: a smoke test that quietly passes
# when it tested nothing is worse than no smoke test. Same for every probe —
# the first one that fails dumps the container log and exits non-zero.
#
# What this does NOT cover, deliberately:
#   * one arch only — whatever the host runs. The arm64 leg of a multi-arch
#     manifest is proven by the build, not by this.
#   * no IRC: no upstream connect, no SASL, no scrollback. Those are
#     scripts/integration.sh's job, against the SOURCE image.
#   * no TLS front door, no reverse proxy, no real PHX_HOST — the box is
#     probed on the published loopback port.
#   * `update` is not exercised, only `install` + a bare-run restart.

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/.." && pwd)"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }
pass() { printf '\033[1;32mok\033[0m  %s\n' "$*"; }

: "${GRAPPA_IMAGE:?set GRAPPA_IMAGE to the image ref under test}"
: "${GRAPPA_SMOKE_VERSION:?set GRAPPA_SMOKE_VERSION to the version the node must report}"
PUBLISH="${GRAPPA_SMOKE_PUBLISH:-127.0.0.1:14000}"

# Dedicated names, never the operator defaults (`grappa` / `grappa-data`): the
# teardown below force-removes them, and it must not be able to eat a real box.
BOX=grappa-smoke
BOX_VOLUME=grappa-smoke-data
BARE=grappa-smoke-bare
BARE_VOLUME=grappa-smoke-bare-data

command -v docker >/dev/null 2>&1 || die "docker not found."
docker image inspect "$GRAPPA_IMAGE" >/dev/null 2>&1 \
    || die "$GRAPPA_IMAGE is not present locally — 'docker pull' it first. An unavailable image fails this job; it never skips it."

SMOKE_HOME="$(mktemp -d "${TMPDIR:-/tmp}/grappa-smoke.XXXXXX")"

teardown() {
    status=$?
    if [ "$status" -ne 0 ]; then
        # The server half of the failure: a probe that failed on the HTTP side
        # says nothing about why. 200 lines, not 30.
        for c in "$BOX" "$BARE"; do
            if docker inspect "$c" >/dev/null 2>&1; then
                printf '\n----- docker logs %s (tail 200) -----\n' "$c" >&2
                docker logs --tail 200 "$c" >&2 2>&1 || true
            fi
        done
    fi
    docker rm -f "$BOX" "$BARE" >/dev/null 2>&1 || true
    docker volume rm "$BOX_VOLUME" "$BARE_VOLUME" >/dev/null 2>&1 || true
    rm -rf "$SMOKE_HOME"
    exit "$status"
}
trap teardown EXIT

# A crashed earlier run leaves the box behind, and `install` refuses to run
# onto an existing container. Clear the dedicated names before, not just after.
docker rm -f "$BOX" "$BARE" >/dev/null 2>&1 || true
docker volume rm "$BOX_VOLUME" "$BARE_VOLUME" >/dev/null 2>&1 || true

# wait_healthz CONTAINER — poll /healthz from INSIDE, so this works for the
# bare container too (no published port).
wait_healthz() {
    deadline=$((SECONDS + 300))
    until docker exec "$1" curl -fsS -o /dev/null http://localhost:4000/healthz 2>/dev/null; do
        [ "$SECONDS" -lt "$deadline" ] || die "$1 never answered /healthz"
        printf '.'; sleep 2
    done
    printf '\n'
}

say "ARM A — install via infra/docker/get.sh (release mode) from $GRAPPA_IMAGE"
# get.sh mirrors deploy_common.sh + gen-secrets.sh + deploy.sh into
# GRAPPA_HOME and execs deploy.sh, exactly as `curl … | bash` does; the
# file:// base is the only substitution, so the mirror list is under test.
GRAPPA_RAW_BASE="file://$REPO_ROOT" \
GRAPPA_HOME="$SMOKE_HOME" \
GRAPPA_CONTAINER="$BOX" \
GRAPPA_DATA_VOLUME="$BOX_VOLUME" \
GRAPPA_PUBLISH="$PUBLISH" \
GRAPPA_IMAGE="$GRAPPA_IMAGE" \
PHX_HOST=localhost \
    sh "$REPO_ROOT/infra/docker/get.sh" install

# ---- probe 1: GET / serves the SPA shell, not the not-built fallback -------
#
# The oracle is the RUNNING NODE's own answer: Grappa.Cic.Bundle.current_hash()
# parses the deployed index.html with the production regex, so this compares
# what the node believes it serves against what HTTP actually returned — no
# copy of the regex here to drift. #1161 fails BOTH halves at once (a wrong
# CIC_DIST_ROOT means a nil hash and a fallback body), which is why the empty
# hash is its own assertion rather than a silently-matching empty string.
say "probe 1: GET / carries the SPA shell"
body="$SMOKE_HOME/index.html"
curl -fsS --max-time 20 -o "$body" "http://$PUBLISH/" \
    || die "GET / did not return 2xx"

hash="$(docker exec "$BOX" bin/grappa rpc \
    'IO.puts("cic-hash=" <> to_string(Grappa.Cic.Bundle.current_hash()))' \
    | sed -n 's/^cic-hash=//p' | tail -n1 | tr -d '\r')"
[ -n "$hash" ] || {
    printf '\n----- GET / returned (first 300 bytes) -----\n' >&2
    head -c 300 "$body" >&2; printf '\n' >&2
    die "the running node reports NO cic bundle hash — it cannot read its own dist (CIC_DIST_ROOT?)"
}

grep -q "src=\"/assets/index-${hash}\.js\"" "$body" || {
    printf '\n----- GET / returned (first 300 bytes) -----\n' >&2
    head -c 300 "$body" >&2; printf '\n' >&2
    die "GET / does not carry the bundle the node reports (index-${hash}.js)"
}
pass "GET / serves index-${hash}.js"

# ---- probe 2: /api/config answers, and the node is the image under test ----
#
# One request, two claims: the unauthenticated discovery endpoint is reachable
# at all, and the version it reports is the one this image was built for. The
# version half is what catches "the tag you think you deployed is not the
# image that is running".
say "probe 2: GET /api/config is the discovery JSON for $GRAPPA_SMOKE_VERSION"
config="$(curl -fsS --max-time 20 "http://$PUBLISH/api/config")" \
    || die "GET /api/config did not return 2xx"
grep -Fq '"server":"grappa"' <<<"$config" \
    || die "GET /api/config is not grappa's discovery JSON: $config"
grep -Fq "\"version\":\"$GRAPPA_SMOKE_VERSION\"" <<<"$config" \
    || die "the running node does not report $GRAPPA_SMOKE_VERSION: $config"
pass "/api/config reports $GRAPPA_SMOKE_VERSION"

# ---- probe 3: a restart never rotates the generated secrets ----------------
#
# A SECOND container shape, and it has to be: under deploy.sh every secret
# rides in from the host env file, so the entrypoint's first-boot bootstrap
# (#862) never fires there. A bare `docker run` with only PHX_HOST set is the
# path that generates them onto /data — and rotating GRAPPA_ENCRYPTION_KEY on
# a restart is silent data loss (every stored credential stops decrypting),
# not a failed boot, so nothing louder than this would notice.
say "probe 3: bare 'docker run' bootstraps secrets, and a restart reuses them"
docker run -d --name "$BARE" -e PHX_HOST=localhost \
    -v "${BARE_VOLUME}:/data" "$GRAPPA_IMAGE" >/dev/null
wait_healthz "$BARE"
before="$(docker exec "$BARE" sha256sum /data/grappa.env | cut -d' ' -f1)"
[ -n "$before" ] || die "no /data/grappa.env after first boot — the bootstrap never ran"

docker restart "$BARE" >/dev/null
wait_healthz "$BARE"
after="$(docker exec "$BARE" sha256sum /data/grappa.env | cut -d' ' -f1)"
[ "$before" = "$after" ] \
    || die "the restart ROTATED /data/grappa.env ($before -> $after) — every stored credential is now undecryptable"
pass "/data/grappa.env survived the restart byte-for-byte ($before)"

say "release image $GRAPPA_IMAGE deployed and answered every probe 🎉"
