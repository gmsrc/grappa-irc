#!/usr/bin/env bash
# scripts/testnet.sh — bring up / tear down / probe the integration
# testnet stack on its own (without running the Playwright suite).
#
# Wraps `cicchetto/e2e/compose.yaml` for iterative debugging: unlike
# integration.sh, it leaves the stack up so S2S linkup, conf rendering and
# peer behaviour can be inspected interactively.
#
# Usage:
#   scripts/testnet.sh up         # build + start hub + leaves + services + grappa-test + nginx (no runner, no auto-tear-down)
#   scripts/testnet.sh down       # tear down (compose down -v --remove-orphans + wipe runtime/e2e)
#   scripts/testnet.sh status     # docker compose ps
#   scripts/testnet.sh logs <svc> # tail logs for one service
#   scripts/testnet.sh probe      # raw IRC client connect to leaf4 + /links + /stats l (oper-up auto)
#   scripts/testnet.sh shell <svc>  # exec sh inside one of the running containers
#
# Worktree-aware via _lib.sh (REPO_ROOT / SRC_ROOT), same as integration.sh.
#
# Canonical "which test runner do I use?" + e2e cascade-vs-flake triage
# runbook: docs/TESTING.md.

set -euo pipefail

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

E2E_DIR="$SRC_ROOT/cicchetto/e2e"

# Derive the single-source version here (SRC_ROOT has it) and export it, so
# every `docker compose` below passes it through to the cic build.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)" (#538).
GRAPPA_VERSION="$("$SRC_ROOT/infra/packaging/version.sh")"
export GRAPPA_VERSION
# #1773 — the credit roll's git facts, same channel, same reason.
GRAPPA_CREDITS="$("$SRC_ROOT/infra/packaging/credits.sh")"
export GRAPPA_CREDITS

if [ ! -f "$E2E_DIR/compose.yaml" ]; then
    die "missing $E2E_DIR/compose.yaml"
fi
if [ ! -d "$E2E_DIR/infra/bahamut" ]; then
    # Git worktrees do NOT inherit the parent checkout's submodules — auto-init
    # (idempotent, a no-op once present). `-c protocol.file.allow=always` is
    # REQUIRED, not cosmetic.
    # Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)" (#592).
    echo "testnet: azzurra-testnet submodule empty (fresh worktree?) — initialising…" >&2
    git -C "$SRC_ROOT" -c protocol.file.allow=always submodule update --init cicchetto/e2e/infra >&2 \
        || die "submodule auto-init failed — run: git -C '$SRC_ROOT' -c protocol.file.allow=always submodule update --init cicchetto/e2e/infra"
    [ -d "$E2E_DIR/infra/bahamut" ] \
        || die "azzurra-testnet submodule still empty after init — check $E2E_DIR/infra"
fi
if [ ! -f "$E2E_DIR/infra/.env" ]; then
    cp "$E2E_DIR/infra/.env.example" "$E2E_DIR/infra/.env"
fi

cmd="${1:-}"
shift || true

case "$cmd" in
    up)
        # Same UID/GID handling + bind-mount mkdir as integration.sh — without
        # these the bahamut / grappa-test sqlite / cicchetto-dist writes hit
        # AccessDenied under the dropped UID.
        e2e_export_uid
        mkdir -p \
            "$REPO_ROOT/runtime/bun-cache" \
            "$SRC_ROOT/runtime/e2e/cicchetto-dist" \
            "$SRC_ROOT/runtime/e2e/grappa-runtime"

        cd "$E2E_DIR"
        # Tear down first so the bring-up inherits a clean slate: a leftover
        # testnet still holds ports / DB locks / sqlite WAL state. `down -v`
        # wipes named volumes, but those are all e2e-only caches.
        docker compose down -v --remove-orphans 2>&1 | tail -5 || true
        # e2e_force_rm, not plain rm — a prior run can leave these root-owned
        # (see _lib.sh).
        e2e_force_rm "$SRC_ROOT/runtime/e2e/grappa-runtime" "$SRC_ROOT/runtime/e2e/cicchetto-dist"
        mkdir -p \
            "$SRC_ROOT/runtime/e2e/cicchetto-dist" \
            "$SRC_ROOT/runtime/e2e/grappa-runtime"

        # Phase 1: seeder oneshot, booted alone and via `compose run --rm`
        # (NOT `up --wait`).
        # Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)".
        docker compose build grappa-e2e-seeder
        docker compose run --rm grappa-e2e-seeder
        # Phase 2: long-running services, NO runner (that is what separates
        # this script from integration.sh). `--build` so the bahamut hub +
        # leaves pick up conf.{hub,leaf4,leaf6}.tmpl edits. `solanum-test2` is
        # the second-network ircd; `mailpit` the mailcatcher the
        # registration-wizard e2e polls for the NickServ AUTH code.
        docker compose up --build --wait hub leaf-v4 leaf-v6 services solanum-test2 grappa-test nginx-test mailpit
        echo
        echo "testnet up. ports: nginx=http://nginx-test, irc=bahamut-test:6667 (in-network only)"
        echo "tear down: scripts/testnet.sh down"
        ;;
    down)
        cd "$E2E_DIR"
        docker compose down -v --remove-orphans
        e2e_force_rm "$SRC_ROOT/runtime/e2e/grappa-runtime" "$SRC_ROOT/runtime/e2e/cicchetto-dist"
        ;;
    status)
        cd "$E2E_DIR"
        docker compose ps
        ;;
    logs)
        cd "$E2E_DIR"
        docker compose logs -f "${1:-}"
        ;;
    probe)
        # Raw IRC connect from inside the docker network, using nginx-test as
        # the netcat host (alpine, already on the grappa-e2e bridge).
        # Auto-opers so /links + /stats l show real link state; output is raw
        # IRC wire.
        docker exec grappa-e2e-nginx sh -c '{
            echo "NICK probe-$$";
            echo "USER probe 0 * :probe";
            sleep 1;
            echo "OPER azzurra azzt3st";
            sleep 1;
            echo "LINKS";
            sleep 1;
            echo "STATS l";
            sleep 1;
            echo "QUIT :bye";
            sleep 0.5;
        } | nc bahamut-test 6667'
        ;;
    shell)
        svc="${1:?usage: scripts/testnet.sh shell <service-name>}"
        cd "$E2E_DIR"
        docker compose exec "$svc" sh
        ;;
    *)
        die "usage: scripts/testnet.sh {up|down|status|logs <svc>|probe|shell <svc>}"
        ;;
esac
