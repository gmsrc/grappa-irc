#!/bin/sh
# nfpm preremove — maps to the .deb prerm. Debian arg convention:
# $1 = remove | upgrade | deconfigure | failed-upgrade. Stop + disable the
# service only on a real removal; on upgrade the new package's postinstall
# leaves the operator to `systemctl restart grappa` (we never auto-restart,
# to keep the stop/start epmd-name race — FreeBSD defect #9 — off the
# upgrade path). POSIX /bin/sh.
set -e

case "${1:-remove}" in
remove | deconfigure)
	if command -v systemctl >/dev/null 2>&1; then
		systemctl stop grappa.service || true
		systemctl disable grappa.service || true
	fi
	;;
esac
