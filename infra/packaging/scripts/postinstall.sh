#!/bin/sh
# nfpm postinstall — maps to the .deb postinst. Debian arg convention:
# $1 = configure (install/upgrade) | abort-* (rollback). We act only on
# configure. POSIX /bin/sh.
set -e

case "${1:-configure}" in
configure)
	# ── State + config dirs ────────────────────────────────────────────
	# /var/lib/grappa carries the sqlite DB + uploads (writable by the
	# daemon); /etc/grappa carries the secrets env file (root:grappa 0750).
	mkdir -p /var/lib/grappa/uploads
	chown -R grappa:grappa /var/lib/grappa
	chmod 0750 /var/lib/grappa
	mkdir -p /etc/grappa
	chown root:grappa /etc/grappa
	chmod 0750 /etc/grappa

	# ── Env file: created on FIRST install only, never clobbered ────────
	if [ ! -f /etc/grappa/grappa.env ]; then
		cp /usr/share/grappa/grappa.env.example /etc/grappa/grappa.env
		chown root:grappa /etc/grappa/grappa.env
		chmod 0640 /etc/grappa/grappa.env
	fi

	# ── Secrets: openssl-only, idempotent (fills REPLACE_ME) ───────────
	/usr/share/grappa/gen-secrets.sh

	# ── Migrate: the #419 packaged migrate path ────────────────────────
	# Reaches Ecto.Migrator through the release, no mix/toolchain. Runs on
	# every (re)configure — Ecto.Migrator applies only PENDING migrations,
	# so this keeps the schema current across upgrades too. FAIL LOUD: a
	# broken migrate must surface as a failed package configuration, not a
	# silently half-migrated install (CLAUDE.md "no silent-swallow").
	if ! /usr/bin/grappa migrate; then
		echo "grappa: database migration FAILED (see error above)." >&2
		echo "        The package is installed but the schema is not applied." >&2
		echo "        Fix the cause and re-run: sudo grappa migrate" >&2
		exit 1
	fi

	# ── systemd: enable, do NOT start ──────────────────────────────────
	# The operator must set a real PHX_HOST in /etc/grappa/grappa.env
	# before the service can boot, so we enable-on-boot but leave the
	# first start to them.
	if command -v systemctl >/dev/null 2>&1; then
		systemctl daemon-reload || true
		systemctl enable grappa.service || true
	fi

	cat <<'EOF'

grappa installed.

  1. Set the public hostname:
       sudoedit /etc/grappa/grappa.env      # set PHX_HOST=your.host
  2. Start it:
       sudo systemctl start grappa
  3. Create your first user (after it is running) — see the "First user"
     section of /usr/share/doc/grappa/README.md.

  Health:  curl http://127.0.0.1:4000/healthz
  Logs:    journalctl -u grappa -f

  Back up /etc/grappa/grappa.env's GRAPPA_ENCRYPTION_KEY now — it encrypts
  stored IRC credentials at rest; lose it and they are unrecoverable.

  nginx is recommended for TLS/static fronting but NOT required — the
  bouncer self-serves the cicchetto PWA on PORT (default 4000).
EOF
	;;
esac
