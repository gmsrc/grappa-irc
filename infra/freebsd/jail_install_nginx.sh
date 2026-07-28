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

echo "[install_nginx] copying config + snippet"
install -o root -g wheel -m 0644 "${REPO_ROOT}/infra/freebsd/nginx.conf" "${NGINX_ETC}/nginx.conf"
mkdir -p "${NGINX_ETC}/snippets"
install -o root -g wheel -m 0644 "${REPO_ROOT}/infra/snippets/locations-api.conf" "${NGINX_ETC}/snippets/locations-api.conf"

echo "[install_nginx] nginx -t"
nginx -t

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
curl -fsS -w "HTTP %{http_code}\n" http://10.66.6.7/healthz -o /dev/null || true
