#!/bin/sh
# release-entrypoint.sh — container entrypoint for the self-contained grappa
# RELEASE image (Dockerfile.release, #503 unit C).
#
# It mirrors bin/start.sh's BEAM resource caps — the DOCKER-specific fix — then
# execs the release. bin/start.sh cannot be reused verbatim: it self-heals hex
# + deps and `exec mix phx.server`, neither of which exists in a self-contained
# release (no mix, no source). This is the release twin of that same rationale.
#
# Why the caps: Docker on Linux 6.x inherits NOFILE = 2^30, so WITHOUT a `+Q`
# cap BEAM sizes its port table at min(ulimit -n, 2^27-1) = ~134M ports →
# ~1.5 GB ll_alloc carrier reserved at boot; `+SDio` defaults to a fixed 10
# dirty-IO scheduler threads regardless of CPU count. Same knobs, same ratios
# as bin/start.sh (see its header for the per-user derivation):
#   GRAPPA_MAX_USERS         (default 100) sizes +Q (ports) and +P (procs)
#   GRAPPA_DIRTY_SCHEDULERS  (default max(nproc, 10)) sizes +SDcpu and +SDio
#
# The flags travel via ERL_ZFLAGS — honored by erlexec for a `mix release`
# start — rather than a baked `rel/vm.args`: vm.args would ship inside the
# release and change the jail/.deb/.rpm consumers too, but these caps are THIS
# image's concern. ERL_ZFLAGS is APPENDED to (never clobbers) any operator
# value.

set -e

: "${GRAPPA_MAX_USERS:=100}"
default_schedulers="$(nproc)"
if [ "$default_schedulers" -lt 10 ]; then
    default_schedulers=10
fi
: "${GRAPPA_DIRTY_SCHEDULERS:=$default_schedulers}"

GRAPPA_MAX_PORTS=$((GRAPPA_MAX_USERS * 400))
GRAPPA_MAX_PROCS=$((GRAPPA_MAX_USERS * 100))

ERL_ZFLAGS="${ERL_ZFLAGS:+$ERL_ZFLAGS }+Q ${GRAPPA_MAX_PORTS} +P ${GRAPPA_MAX_PROCS} +SDcpu ${GRAPPA_DIRTY_SCHEDULERS} +SDio ${GRAPPA_DIRTY_SCHEDULERS}"
export ERL_ZFLAGS

# The sqlite DB parent + the uploads dir must exist and be writable before boot
# (exqlite opens but does NOT create the parent dir). On a fresh anonymous
# /data volume Docker inherits the image's grappa ownership, so this succeeds;
# a root-owned bind mount is the operator's to chown (unit D docs). Failing
# loud here beats a cryptic "unable to open database file" at first write.
mkdir -p "$(dirname "${DATABASE_PATH:-/data/grappa.db}")" "${UPLOADS_STORAGE_ROOT:-/data/uploads}"

exec bin/grappa "$@"
