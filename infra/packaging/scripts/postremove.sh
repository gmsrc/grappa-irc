#!/bin/sh
# nfpm postremove — the .deb postrm AND the .rpm %postun scriptlet. The two
# managers pass DIFFERENT $1 conventions:
#   dpkg:  $1 = remove | purge | upgrade | abort-*
#   rpm:   $1 = 0 (final uninstall) | 1 (upgrade)   [no "purge" concept]
# POSIX /bin/sh.
#
# Data preservation: NEVER auto-delete /var/lib/grappa (the sqlite DB +
# uploads) — losing it is unrecoverable. Only dpkg `purge` removes the
# generated config; rpm has no purge, so its plain uninstall (0) takes the
# same conservative "keep the secrets" path as dpkg `remove`. The grappa
# system user is left in place, so a reinstall re-adopts the same uid and
# /var/lib/grappa ownership stays consistent.
set -e

case "${1:-remove}" in
purge)
	# dpkg purge only — rpm cannot reach this. Remove the generated config;
	# state is left with a printed note.
	rm -f /etc/grappa/grappa.env
	rmdir /etc/grappa 2>/dev/null || true
	if command -v systemctl >/dev/null 2>&1; then
		systemctl daemon-reload || true
	fi
	echo "grappa: purged config. State left in /var/lib/grappa — remove it"
	echo "        manually for a clean slate: sudo rm -rf /var/lib/grappa"
	;;
0 | remove)
	# rpm final uninstall (0) | dpkg remove — reload systemd, keep config.
	if command -v systemctl >/dev/null 2>&1; then
		systemctl daemon-reload || true
	fi
	;;
esac
