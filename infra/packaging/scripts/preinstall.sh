#!/bin/sh
# nfpm preinstall — maps to the .deb preinst. Runs BEFORE files are
# unpacked, so postinstall can chown to this user. POSIX /bin/sh (dash on
# Debian): no bashisms.
#
# Debian arg convention: $1 = install | upgrade. Creating the system user
# is idempotent, so it is safe on both.
set -e

# shadow-utils (useradd/groupadd) ship on both the Debian and RHEL
# families. --system keeps grappa out of the login-user UID range.
if ! getent group grappa >/dev/null 2>&1; then
	groupadd --system grappa
fi

if ! getent passwd grappa >/dev/null 2>&1; then
	useradd --system --gid grappa \
		--home-dir /var/lib/grappa \
		--shell /usr/sbin/nologin \
		--comment "Grappa IRC bouncer" \
		grappa
fi
