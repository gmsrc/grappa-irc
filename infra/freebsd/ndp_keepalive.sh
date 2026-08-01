#!/bin/sh
#
# =============================================================================
# DEPRECATED (GH #628) — retired 2026-08-02, the VNET jail cutover.
# NO LONGER SHIPPED AS A SERVICE. Kept in the tree ON PURPOSE.
# =============================================================================
# jail_install_rcd.sh no longer installs or enables the keepalive, so this shim
# is out of every boot path. Left in place deliberately ("fa fico avere un
# sorcio in perl"). The routed-/64 VNET jail has no proxy-NDP to keep warm —
# full rationale (and how to resurrect it) lives in ndp_keepalive.pl.
# =============================================================================
#
# Thin shim — the NDP keepalive supervisor now lives in ndp_keepalive.pl
# (perl, event-driven SIGCHLD respawn of long-lived `ping -i` data-plane
# processes). The old spawn-per-tick shell loop churned process accounting and
# inflated loadavg; see ndp_keepalive.pl for the why.
#
# This wrapper exists only so the rc.d command (`/bin/sh <script>`) and the
# daemon(8) -r respawn layer stay unchanged. All GRAPPA_NDP_KEEPALIVE_* env
# vars exported by the rc.d precmd are inherited by the exec below.

set -u

DIR=$(dirname "$0")
exec /usr/local/bin/perl "${DIR}/ndp_keepalive.pl"
