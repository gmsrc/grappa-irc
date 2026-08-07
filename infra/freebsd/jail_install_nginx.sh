#!/bin/sh
# Install nginx config + snippet in the jail, enable + start service.
#
# Invoke from m42 host:
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_install_nginx.sh
#
# Idempotent — re-run after `git pull` to refresh nginx config.
#
# #485 made this jail nginx a DUMB reverse proxy: the BEAM self-serves the
# SPA + static + PWA manifest and OWNS all security headers, so there is no
# SPA symlink to maintain and no security-headers snippet to install — only
# the substrate-agnostic proxy snippet.
#
# COORDINATION (#485): the security headers move from nginx into the BEAM in
# ONE deploy. Run this in the SAME cold deploy as the release that ships
# GrappaWeb.Plugs.SecurityHeaders — shipping the release first double-emits
# the CSP (intersection footgun), shipping this first leaves a no-headers
# window.

set -eu

REPO_ROOT="/home/grappa/grappa"
NGINX_ETC="/usr/local/etc/nginx"

# Test-before-arm. An invalid config must never be LEFT on disk: the running
# nginx keeps serving whatever it parsed at start, so a broken file is
# invisible until the next reload or jail restart. That is how a stale
# address literal turned a config error into an armed mine instead of a clean
# deploy failure (#599) — `nginx -t` failed, the deploy moved on, and the site
# stayed up on the in-memory config with an unloadable file underneath it.
#
# Validate in PLACE and roll back on failure, rather than staging elsewhere
# and testing with `-c`/`-p`: `nginx -t` resolves relative includes, log paths
# and temp paths against the prefix, so only an in-place test exercises the
# exact bytes and paths nginx will actually load.
BACKUP="$(mktemp -d)"
trap 'rm -rf "${BACKUP}"' EXIT

restore_previous() {
	restored=0
	if [ -f "${BACKUP}/nginx.conf" ]; then
		install -o root -g wheel -m 0644 "${BACKUP}/nginx.conf" "${NGINX_ETC}/nginx.conf"
		restored=1
	fi
	if [ -f "${BACKUP}/locations-api.conf" ]; then
		install -o root -g wheel -m 0644 "${BACKUP}/locations-api.conf" "${NGINX_ETC}/snippets/locations-api.conf"
		restored=1
	fi
	if [ "$restored" -eq 1 ]; then
		echo "[install_nginx] previous config restored; nginx was NOT reloaded and still serves it"
	else
		echo "[install_nginx] no previous config existed — the invalid file is still in place, nginx will not start from it"
	fi
}

echo "[install_nginx] copying config + snippet"
if [ -f "${NGINX_ETC}/nginx.conf" ]; then
	cp -p "${NGINX_ETC}/nginx.conf" "${BACKUP}/nginx.conf"
fi
if [ -f "${NGINX_ETC}/snippets/locations-api.conf" ]; then
	cp -p "${NGINX_ETC}/snippets/locations-api.conf" "${BACKUP}/locations-api.conf"
fi

install -o root -g wheel -m 0644 "${REPO_ROOT}/infra/freebsd/nginx.conf" "${NGINX_ETC}/nginx.conf"
mkdir -p "${NGINX_ETC}/snippets"
install -o root -g wheel -m 0644 "${REPO_ROOT}/infra/snippets/locations-api.conf" "${NGINX_ETC}/snippets/locations-api.conf"

echo "[install_nginx] nginx -t"
if ! nginx -t; then
	echo "[install_nginx] nginx -t FAILED on the new config — rolling back"
	restore_previous
	exit 1
fi

echo "[install_nginx] sysrc nginx_enable=YES"
sysrc nginx_enable=YES

if service nginx status >/dev/null 2>&1; then
	echo "[install_nginx] reloading nginx"
	service nginx reload
else
	echo "[install_nginx] starting nginx"
	service nginx start
fi

echo "[install_nginx] done. probe:"
# Probe over the jail's own loopback, never a literal external address: the
# jail renumbers and a hardcoded address turns this probe into a permanent
# false negative that nobody reads (the #599 ruling). This runs INSIDE the
# jail, and nginx now listens wildcard, so 127.0.0.1 is always the right
# door regardless of which addresses the jail currently holds.
curl -fsS -w "HTTP %{http_code}\n" http://127.0.0.1/healthz -o /dev/null || true
