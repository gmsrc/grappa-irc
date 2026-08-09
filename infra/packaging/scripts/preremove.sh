#!/bin/sh
# nfpm preremove — the .deb prerm AND the .rpm %preun scriptlet. The two
# managers pass DIFFERENT $1 conventions for "is this a real removal?":
#   dpkg:  $1 = remove | upgrade | deconfigure | failed-upgrade
#   rpm:   $1 = 0 (final uninstall) | 1 (upgrade — old pkg's %preun)
# Stop + disable the service ONLY on a real removal (dpkg remove/deconfigure,
# rpm 0). An upgrade never auto-restarts — that keeps the stop/start
# epmd-name race off the upgrade path; the operator restarts. POSIX /bin/sh.
# Why: docs/OPERATIONS.md § "Packaging (infra/packaging/)".
set -e

case "${1:-remove}" in
0 | remove | deconfigure)
	if command -v systemctl >/dev/null 2>&1; then
		systemctl stop grappa.service || true
		systemctl disable grappa.service || true
	fi
	;;
esac
