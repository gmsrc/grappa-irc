#!/bin/sh
# nfpm preremove — the .deb prerm AND the .rpm %preun scriptlet. The two
# managers pass DIFFERENT $1 conventions for "is this a real removal?":
#   dpkg:  $1 = remove | upgrade | deconfigure | failed-upgrade
#   rpm:   $1 = 0 (final uninstall) | 1 (upgrade — old pkg's %preun)
# Stop + disable the service ONLY on a real removal (dpkg remove/deconfigure,
# rpm 0); on upgrade the new package's postinstall leaves the operator to
# `systemctl restart grappa` (we never auto-restart, to keep the stop/start
# epmd-name race — FreeBSD defect #9 — off the upgrade path). POSIX /bin/sh.
set -e

case "${1:-remove}" in
0 | remove | deconfigure)
	if command -v systemctl >/dev/null 2>&1; then
		systemctl stop grappa.service || true
		systemctl disable grappa.service || true
	fi
	;;
esac
