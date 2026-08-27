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
# This is that GET, plus the discovery, secret-persistence, account-bootstrap
# and credit-roll probes, against a container that was
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
# ⚠️ Probe 5 asserts a RELEASE build. An image from a plain
#    `docker build -f Dockerfile.release .` legitimately bakes the degraded
#    credit roll (`.git` is .dockerignore'd, #1834) and will fail it — pass
#    `--build-arg GRAPPA_CREDITS="$(infra/packaging/credits.sh)"` to build the
#    thing release.yml builds. That asymmetry is the point: the naked build
#    must keep DEGRADING, the shipped image must not.
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
                docker logs --tail 200 "$c" >&2 || true
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

say "installing via infra/docker/get.sh (release mode) from $GRAPPA_IMAGE"
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

# ---- probe 1: the SPA the box serves can actually boot ---------------------
#
# Three claims, three INDEPENDENT oracles — deliberately not a comparison
# between two reads of one file. Asking the node for Cic.Bundle.current_hash()
# and grepping the response for it looks like a cross-check and is not: both
# sides resolve Bundle.root() and open the same index.html, so they cannot
# disagree and the assertion can never fail. So the hash is parsed FROM THE
# HTTP RESPONSE, by shipping the received bytes back into the container and
# running the production parser (Cic.Bundle.parse_hash/1, exposed for exactly
# this) over them — no second copy of the Vite regex to drift.
#
#   (a) GET / is 2xx            — #1161's 404 SPA (a missing bundle is a 404;
#                                 the "not built" text rides WITH that status)
#   (b) the body parses to a hash — a shell served 200 that boots nothing
#   (c) the chunk it names arrives AS JAVASCRIPT — a shell pointing at bytes
#       nobody serves. Status alone is blind here, MEASURED: delete
#       cicchetto-dist/assets from the image and GET /assets/index-<hash>.js
#       still answers 200, because Plug.Static misses and the SPA history
#       fallback hands back the shell with content-type text/html. The
#       browser then loads the page, fetches the module, gets HTML, and
#       white-screens — the exact silent shape of #1161.
say "probe 1: the SPA served at / can boot"
body="$SMOKE_HOME/index.html"
curl -fsS --max-time 20 -o "$body" "http://$PUBLISH/" \
    || die "GET / did not return 2xx"

docker cp "$body" "$BOX:/tmp/smoke-index.html" >/dev/null
bundle_hash="$(docker exec "$BOX" bin/grappa rpc \
    'IO.puts("cic-hash=" <> to_string(Grappa.Cic.Bundle.parse_hash(File.read!("/tmp/smoke-index.html"))))' \
    | sed -n 's/^cic-hash=//p' | tail -n1 | tr -d '\r')"
[ -n "$bundle_hash" ] || {
    printf '\n----- GET / returned (first 300 bytes) -----\n' >&2
    head -c 300 "$body" >&2; printf '\n' >&2
    die "GET / returned 200 but carries no SPA bundle tag"
}

chunk_type="$(curl -fsS --max-time 20 -o /dev/null \
    -w '%{content_type}' "http://$PUBLISH/assets/index-${bundle_hash}.js")" \
    || die "the shell names /assets/index-${bundle_hash}.js and the box does not serve it"
case "$chunk_type" in
    *javascript*) ;;
    *) die "/assets/index-${bundle_hash}.js came back as '${chunk_type}', not JavaScript — the shell boots nothing" ;;
esac
pass "GET / serves a shell that boots index-${bundle_hash}.js (${chunk_type})"

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

# ---- probe 4: docker exec can bootstrap the first account ------------------
#
# The bare image generated secrets inside its entrypoint process. Docker does
# NOT add those exports to Config.Env, so a later `docker exec` starts without
# them — exactly the documented first-account door. The packaged CLI must
# re-enter the same safe, line-parsing entrypoint before runtime.exs loads.
# Feed the password on stdin: putting it behind --password would make this test
# teach operators to leak credentials through shell history + the process list.
say "probe 4: docker exec creates the first admin from a fresh-volume boot"
created="$(printf 'release-smoke-password\n' \
    | docker exec -i "$BARE" bin/grappa create-user release-smoke-admin --admin)" \
    || die "docker exec create-user failed after first-boot secrets were generated on /data"
grep -Fq 'created user release-smoke-admin' <<<"$created" \
    || die "docker exec create-user returned success without naming the created account: $created"
grep -Fq '[admin]' <<<"$created" \
    || die "docker exec create-user did not grant the requested admin flag: $created"
pass "docker exec created release-smoke-admin [admin] without a password argument"

# ---- probe 5: the shipped SPA carries the build's REAL credit roll ---------
#
# #1834. `.git` is .dockerignore'd for Dockerfile.release, so the credits.sh
# call INSIDE the image build can only reach its own no-repo guard and answer
# `{"sha":null,"date":null,"contributors":[]}` — which is what ghcr was
# shipping. release.yml now derives the payload on the runner (which HAS the
# history) and hands it in as a build arg. Nothing else in CI can see whether
# that arrived: the unit suite runs under a vitest config with no `define` at
# all, and the #1773 e2e spec builds its own bundle from a full checkout. This
# probe is the only oracle that reads the artifact that ships.
#
# The dist, not the wire: probe 1 already proved the shell and its entry chunk
# are SERVED. Which chunk the payload lands in is rolldown's business, and
# pinning it here would make this a code-splitting test — so this asks the
# container for every chunk it ships, resolving the root from the image's own
# CIC_DIST_ROOT rather than a second copy of the path.
#
# THREE outcomes, not two. "Populated" and "degraded" are the two that name a
# verdict; the third — neither shape present — means the payload's spelling
# moved and this probe went blind, and it FAILS rather than passing quietly.
# That is the anti-hollow-green guard, and it doubles as the positive control:
# the same greps that must reject the degraded roll must also be able to FIND
# one.
say "probe 5: the SPA the image ships carries a populated credit roll"
shipped_js="$SMOKE_HOME/shipped-chunks.js"
# `sed` folds the escaped spelling onto the bare one: the minifier picks the
# cheapest delimiter for the string literal it bakes the payload into —
# backticks in the build measured for #1834, which leaves the JSON's own
# quotes bare, but a `"` delimiter would escape every one of them. Neither
# assertion below should depend on that choice. `set -o pipefail` above is
# what keeps a failed `docker exec` from being masked by the sed.
docker exec "$BOX" sh -c 'cat "$CIC_DIST_ROOT"/assets/*.js' | sed 's/\\"/"/g' > "$shipped_js" \
    || die "could not read the shipped JS chunks out of $BOX"

# The exact payload credits.sh emits with no repo — canonical, because
# vite.config.ts re-serialises it through JSON.parse/stringify.
degraded_roll='{"sha":null,"date":null,"contributors":[]}'
# One contributor row. Absent from a degraded bundle and present once per
# credited author in a populated one — measured 0 vs 9 on the two dists #1834
# built to check exactly this.
contributor_row='\{"name":"[^"]*","commits":[0-9]+\}'
# The whole populated payload, head-anchored: a real sha, a real date, and at
# least one contributor. All three, because each degrades on its own — a roll
# that names the commit and credits nobody is still an empty roll.
populated_roll='\{"sha":"[0-9a-f]+","date":"[^"]+","contributors":\['"$contributor_row"

if grep -qF "$degraded_roll" "$shipped_js"; then
    die "the image bakes the DEGRADED credit roll ($degraded_roll) — the build ran credits.sh in a context with no .git and nothing passed GRAPPA_CREDITS in (#1834)"
fi

if ! grep -qE "$populated_roll" "$shipped_js"; then
    die "the shipped chunks carry NEITHER a populated credit roll nor the degraded one — the payload's spelling changed and this probe is now blind (#1834); check the vite define in cicchetto/vite.config.ts"
fi

roll_sha="$(grep -oE '\{"sha":"[0-9a-f]+"' "$shipped_js" | head -n1 | sed 's/.*"sha":"//; s/"$//')"
# `grep -c` counts LINES and the bundle is minified onto a handful of them, so
# it would report 1 for any roll of any size. Count MATCHES.
roll_people="$(grep -oE "$contributor_row" "$shipped_js" | wc -l | tr -d ' ')"
pass "the shipped bundle credits commit ${roll_sha} and ${roll_people} contributor row(s)"

say "release image $GRAPPA_IMAGE deployed and answered every probe 🎉"
