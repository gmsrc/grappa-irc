#!/bin/sh
# nfpm postremove — maps to the .deb postrm. Debian arg convention:
# $1 = remove | purge | upgrade | abort-* . POSIX /bin/sh.
#
# Data preservation: NEVER auto-delete /var/lib/grappa (the sqlite DB +
# uploads) — losing it is unrecoverable, and CLAUDE.md's delete-discipline
# says look before you destroy. purge removes only the generated config;
# state is left with a printed note. The grappa system user is left in
# place (harmless, and re-adopting the same uid on reinstall keeps
# /var/lib/grappa ownership consistent).
set -e

case "${1:-remove}" in
purge)
	rm -f /etc/grappa/grappa.env
	rmdir /etc/grappa 2>/dev/null || true
	if command -v systemctl >/dev/null 2>&1; then
		systemctl daemon-reload || true
	fi
	echo "grappa: purged config. State left in /var/lib/grappa — remove it"
	echo "        manually for a clean slate: sudo rm -rf /var/lib/grappa"
	;;
remove)
	if command -v systemctl >/dev/null 2>&1; then
		systemctl daemon-reload || true
	fi
	;;
esac
