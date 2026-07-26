#!/usr/bin/env bash
# /usr/bin/grappa — operator CLI for the packaged Grappa install.
#
# Thin wrapper over the mix-release boot script
# (/usr/lib/grappa/bin/grappa): sources the env file so release
# subcommands see DATABASE_PATH / GRAPPA_ENCRYPTION_KEY / RELEASE_COOKIE,
# and drops privileges to the grappa system user so anything it writes
# (the sqlite DB on first migrate) lands grappa-owned.
#
# Usage:
#   sudo grappa migrate          run pending Ecto migrations (no mix needed)
#   sudo grappa gen-secrets      (re)generate missing secrets in the env file
#   sudo grappa remote           attach an IEx remote shell to the running node
#   sudo grappa version          print the release version
#   sudo grappa eval '<expr>'    evaluate an Elixir expression in release ctx
#
# `migrate` is sugar for `eval 'Grappa.Release.migrate()'` — the same
# Ecto.Migrator the FreeBSD/Docker deploy paths call, reachable WITHOUT a
# dev toolchain. That is the #419 "migrate command": a packaged host has
# only the compiled release + boot scripts, no mix, no project source.

set -euo pipefail

RELEASE_BIN="/usr/lib/grappa/bin/grappa"
ENV_FILE="/etc/grappa/grappa.env"
GEN_SECRETS="/usr/share/grappa/gen-secrets.sh"
RUN_USER="grappa"

die() { printf 'grappa: %s\n' "$*" >&2; exit 1; }

[ -x "$RELEASE_BIN" ] || die "release not found at $RELEASE_BIN — is the package installed?"

cmd="${1:-}"

# gen-secrets writes /etc/grappa (root-owned) — stays root, never drops.
if [ "$cmd" = "gen-secrets" ]; then
	[ "$(id -u)" -eq 0 ] || die "gen-secrets must run as root (writes $ENV_FILE)"
	[ -x "$GEN_SECRETS" ] || die "$GEN_SECRETS not found"
	exec "$GEN_SECRETS"
fi

# `migrate` → eval the release migrator (the #419 packaged migrate path).
if [ "$cmd" = "migrate" ]; then
	set -- eval 'Grappa.Release.migrate()'
fi

[ -r "$ENV_FILE" ] || die "env file $ENV_FILE not readable (run as root, or join the grappa group)"

# Source the env INSIDE the target-user shell so secrets live only in
# that process's environment, then exec the release bin with our argv.
run_payload='set -a; . '"$ENV_FILE"'; set +a; exec '"$RELEASE_BIN"' "$@"'

if [ "$(id -u)" -eq 0 ]; then
	# Drop to the grappa user. runuser ships in util-linux on both the
	# Debian and RHEL families, so it is a safe common dependency.
	command -v runuser >/dev/null 2>&1 || die "runuser (util-linux) not found — cannot drop to $RUN_USER"
	exec runuser -u "$RUN_USER" -- bash -c "$run_payload" bash "$@"
fi

# Already unprivileged (e.g. invoked AS the grappa user) — source + exec.
exec bash -c "$run_payload" bash "$@"
