#!/usr/bin/env bash
# grappa — first-install orchestrator for a native Linux (systemd) host.
# Run as root. Idempotent — safe to re-run (e.g. after fixing an error
# partway through).
#
# Usage:
#   PHX_HOST=irc.example.org infra/linux/install.sh
#
# Required env:
#   PHX_HOST          public hostname (no default — fails loudly)
#
# Optional env (defaults shown):
#   REPO_ROOT=/home/grappa/grappa
#   GIT_REMOTE_URL=https://github.com/vjt/grappa-irc
#   PORT=4000
#   ENV_FILE=/etc/grappa/grappa.env
#   GRAPPA_USER=grappa
#   LISTEN_ADDR=0.0.0.0:80          (nginx, see install_nginx.sh)
#   TRUSTED_UPSTREAM_CIDR=          (nginx, see install_nginx.sh)
#
# See infra/linux/README.md for the full runbook (what each step does,
# what to do once this finishes, exposing beyond localhost).

set -euo pipefail

if [ -z "${PHX_HOST:-}" ]; then
	echo "[install] ERROR: PHX_HOST is required (e.g. PHX_HOST=irc.example.org $0)" >&2
	exit 1
fi

REPO_ROOT="${REPO_ROOT:-/home/grappa/grappa}"
GIT_REMOTE_URL="${GIT_REMOTE_URL:-https://github.com/vjt/grappa-irc}"
PORT="${PORT:-4000}"
ENV_FILE="${ENV_FILE:-/etc/grappa/grappa.env}"
GRAPPA_USER="${GRAPPA_USER:-grappa}"

export REPO_ROOT GRAPPA_USER ENV_FILE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

run_as_grappa() {
	sudo -u "${GRAPPA_USER}" -H bash -c "$1"
}

# $HOME is left unexpanded here: it resolves to grappa's own home once
# run_as_grappa's `sudo -u ... -H` has switched user.
# shellcheck disable=SC2016  # deferred expansion is the point (see above)
asdf_path_export='export PATH="$HOME/.local/bin:$HOME/.asdf/shims:$PATH"'

say "1/11 install_prereqs.sh"
"${SCRIPT_DIR}/install_prereqs.sh"

say "2/11 clone / update checkout at ${REPO_ROOT}"
if [ ! -d "${REPO_ROOT}/.git" ]; then
	# Create the checkout dir owned by the runtime user before cloning as
	# that user — its parent may be root-owned.
	install -d -o "${GRAPPA_USER}" -g "${GRAPPA_USER}" -m 0755 "${REPO_ROOT}"
	run_as_grappa "git clone '${GIT_REMOTE_URL}' '${REPO_ROOT}'"
else
	echo "[install] ${REPO_ROOT} already a git checkout, leaving as-is"
fi
chown -R "${GRAPPA_USER}:${GRAPPA_USER}" "${REPO_ROOT}"

say "3/11 install_toolchain.sh (erlang build from source — can take 10-20 min)"
"${SCRIPT_DIR}/install_toolchain.sh" "${REPO_ROOT}"

say "4/11 first build (mix deps.get / compile / release)"
# Full `mix deps.get`, NOT --only prod: step 5's secrets bootstrap runs
# mix tasks under MIX_ENV=dev, which need the dev-only deps on disk.
# Why: docs/OPERATIONS.md § "Native Linux and the cloud one-click box (infra/linux/, infra/cloud/)".
run_as_grappa "
	${asdf_path_export}
	cd '${REPO_ROOT}'
	mix local.hex --force
	mix local.rebar --force
	mix deps.get
	export MIX_ENV=prod
	mix compile --warnings-as-errors
	mix release --overwrite
"

say "5/11 secrets bootstrap (${ENV_FILE})"
if [ ! -f "${ENV_FILE}" ]; then
	install -o root -g "${GRAPPA_USER}" -m 0640 "${REPO_ROOT}/infra/linux/grappa.env.example" "${ENV_FILE}"
fi
chown "root:${GRAPPA_USER}" "${ENV_FILE}"
chmod 0640 "${ENV_FILE}"

set_env_if_blank() {
	local key="$1" val="$2"
	if grep -qE "^${key}=.+$" "${ENV_FILE}" 2>/dev/null && ! grep -qE "^${key}=REPLACE_ME$" "${ENV_FILE}"; then
		return 0
	fi
	if grep -qE "^${key}=" "${ENV_FILE}"; then
		grep -v "^${key}=" "${ENV_FILE}" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "${ENV_FILE}"
	fi
	printf '%s=%s\n' "${key}" "${val}" >> "${ENV_FILE}"
	# Re-lock: the grep -v >tmp && mv above births a fresh inode 0644
	# root:root under root's umask, world-readable secrets and all. Both
	# chown and chmod — the daemon reads this file via the group.
	chown "root:${GRAPPA_USER}" "${ENV_FILE}"
	chmod 0640 "${ENV_FILE}"
}

# Always overwrite, unlike the secrets above: these are config values that
# must reflect THIS invocation. grappa.env.example ships non-blank example
# values (PHX_HOST=grappa.example.org), which set_env_if_blank would read
# as "already set" and never replace with what the operator passed in.
force_set_env() {
	local key="$1" val="$2"
	if grep -qE "^${key}=" "${ENV_FILE}"; then
		grep -v "^${key}=" "${ENV_FILE}" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "${ENV_FILE}"
	fi
	printf '%s=%s\n' "${key}" "${val}" >> "${ENV_FILE}"
	# Re-lock after the tmp+mv rewrite (see set_env_if_blank). This runs
	# last, so it decides the permissions the env file is left with.
	chown "root:${GRAPPA_USER}" "${ENV_FILE}"
	chmod 0640 "${ENV_FILE}"
}

# Secrets are generated under MIX_ENV=dev on purpose: a prod-env mix task
# reads config/runtime.exs, which raises on the very secrets being created.
#
# gen_raw runs the task, prints the captured error and exits non-zero on
# failure, and strips `warning:` lines. `gen` additionally keeps only the
# LAST line — correct for the single-line generators, WRONG for any
# multi-line one (mix grappa.gen_vapid prints four lines), which must call
# gen_raw and grep each key out of the full output.
# Why: docs/OPERATIONS.md § "Native Linux and the cloud one-click box (infra/linux/, infra/cloud/)".
gen_raw() {
	local out
	if ! out="$(run_as_grappa "${asdf_path_export}; cd '${REPO_ROOT}'; MIX_ENV=dev $1" 2>&1)"; then
		echo "[install] ERROR: 'MIX_ENV=dev $1' failed:" >&2
		echo "${out}" >&2
		exit 1
	fi
	printf '%s' "${out}" | tr -d '\r' | grep -v '^warning:'
}

gen() {
	gen_raw "$1" | tail -n1
}

# Capture, CHECK, then write — never `set_env_if_blank KEY "$(gen ...)"`
# (#441). In argument position a generator's failure cannot stop this script,
# so the blank gets written and the install still exits 0. Assigning first
# makes the failure real; the emptiness check catches the other shape, a
# generator that exits 0 with nothing to say.
require_nonempty() {
	local key="$1" what="$2" value="$3"
	if [ -z "${value}" ]; then
		echo "[install] ERROR: '${what}' produced an empty ${key} — refusing to write a blank secret" >&2
		exit 1
	fi
}

if ! grep -qE "^SECRET_KEY_BASE=.+$" "${ENV_FILE}" || grep -qE "^SECRET_KEY_BASE=REPLACE_ME$" "${ENV_FILE}"; then
	secret_key_base="$(gen 'mix phx.gen.secret')"
	require_nonempty SECRET_KEY_BASE 'mix phx.gen.secret' "${secret_key_base}"
	set_env_if_blank SECRET_KEY_BASE "${secret_key_base}"
fi
if ! grep -qE "^SECRET_SIGNING_SALT=.+$" "${ENV_FILE}" || grep -qE "^SECRET_SIGNING_SALT=REPLACE_ME$" "${ENV_FILE}"; then
	signing_salt="$(gen 'mix phx.gen.secret 32')"
	require_nonempty SECRET_SIGNING_SALT 'mix phx.gen.secret 32' "${signing_salt}"
	set_env_if_blank SECRET_SIGNING_SALT "${signing_salt}"
fi
if ! grep -qE "^GRAPPA_ENCRYPTION_KEY=.+$" "${ENV_FILE}" || grep -qE "^GRAPPA_ENCRYPTION_KEY=REPLACE_ME$" "${ENV_FILE}"; then
	encryption_key="$(gen 'mix grappa.gen_encryption_key')"
	require_nonempty GRAPPA_ENCRYPTION_KEY 'mix grappa.gen_encryption_key' "${encryption_key}"
	set_env_if_blank GRAPPA_ENCRYPTION_KEY "${encryption_key}"
fi
# The trigger below checks BOTH keys: guarding on the public one alone
# would leave a public-set/private-blank pair permanently stuck, since this
# block never runs again once the public half looks fine.
vapid_key_needs_gen() {
	! grep -qE "^${1}=.+$" "${ENV_FILE}" || grep -qE "^${1}=REPLACE_ME$" "${ENV_FILE}"
}

if vapid_key_needs_gen VAPID_PUBLIC_KEY || vapid_key_needs_gen VAPID_PRIVATE_KEY; then
	vapid="$(gen_raw 'mix grappa.gen_vapid')"
	vapid_public="$(printf '%s\n' "${vapid}" | sed -n 's/^VAPID_PUBLIC_KEY=//p')"
	vapid_private="$(printf '%s\n' "${vapid}" | sed -n 's/^VAPID_PRIVATE_KEY=//p')"
	# gen_raw fails loud on a non-zero exit; this catches the other shape —
	# exit 0 with an output neither sed above matched.
	if [ -z "${vapid_public}" ] || [ -z "${vapid_private}" ]; then
		echo "[install] ERROR: 'mix grappa.gen_vapid' produced an empty key — raw output:" >&2
		echo "${vapid}" >&2
		exit 1
	fi
	# force_set_env, not set_env_if_blank: once regeneration is triggered
	# the fresh pair must land as a matched unit — set_env_if_blank would
	# keep an already-valid half paired with an unrelated new one.
	force_set_env VAPID_PUBLIC_KEY "${vapid_public}"
	force_set_env VAPID_PRIVATE_KEY "${vapid_private}"
fi
if ! grep -qE "^RELEASE_COOKIE=.+$" "${ENV_FILE}" || grep -qE "^RELEASE_COOKIE=REPLACE_ME$" "${ENV_FILE}"; then
	# Same capture-check-write shape as the mix generators above.
	release_cookie="$(openssl rand -hex 32)"
	require_nonempty RELEASE_COOKIE 'openssl rand -hex 32' "${release_cookie}"
	set_env_if_blank RELEASE_COOKIE "${release_cookie}"
fi
force_set_env DATABASE_PATH "${REPO_ROOT}/runtime/grappa_prod.db"
force_set_env UPLOADS_STORAGE_ROOT "${REPO_ROOT}/runtime/uploads"
force_set_env PHX_HOST "${PHX_HOST}"
force_set_env PORT "${PORT}"

mkdir -p "${REPO_ROOT}/runtime/uploads"
chown -R "${GRAPPA_USER}:${GRAPPA_USER}" "${REPO_ROOT}/runtime"

say "6/11 first migration"
# Plain `mix ecto.migrate`, NOT `release.sh eval 'Grappa.Release.migrate()'`:
# the packaged release's eval/remote/rpc boot path crashes the BEAM on this
# substrate (systemd's own `bin/grappa start` is unaffected). This host keeps
# the full mix toolchain, so nothing is lost by not using it.
# Why: docs/OPERATIONS.md § "Native Linux and the cloud one-click box (infra/linux/, infra/cloud/)".
run_as_grappa "
	${asdf_path_export}
	set -a; . '${ENV_FILE}'; set +a
	export MIX_ENV=prod
	cd '${REPO_ROOT}'
	mix ecto.migrate
"

say "7/11 seed built-in themes"
run_as_grappa "
	${asdf_path_export}
	set -a; . '${ENV_FILE}'; set +a
	cd '${REPO_ROOT}'
	MIX_ENV=prod mix grappa.seed_themes
"

say "8/11 cic_build.sh"
"${SCRIPT_DIR}/cic_build.sh" "${REPO_ROOT}"

say "9/11 install_systemd.sh"
"${SCRIPT_DIR}/install_systemd.sh"

say "10/11 install_nginx.sh"
LISTEN_ADDR="${LISTEN_ADDR:-0.0.0.0:80}" TRUSTED_UPSTREAM_CIDR="${TRUSTED_UPSTREAM_CIDR:-}" REPO_ROOT="${REPO_ROOT}" "${SCRIPT_DIR}/install_nginx.sh"

say "11/11 starting grappa + healthcheck"
systemctl start grappa

deadline=$((SECONDS + 120))
until curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/healthz" 2>/dev/null; do
	if [ "${SECONDS}" -ge "${deadline}" ]; then
		die "healthcheck timed out — inspect with: journalctl -u grappa -n 200"
	fi
	printf '.'
	sleep 2
done
printf '\n'

say "grappa is up and healthy"
cat <<EOF

  Health:   curl http://127.0.0.1:${PORT}/healthz
  Logs:     journalctl -u grappa -f
  Status:   systemctl status grappa

  IMPORTANT — back up ${ENV_FILE}'s GRAPPA_ENCRYPTION_KEY now, somewhere
  safe and separate. It encrypts stored IRC/NickServ passwords at rest —
  lose it and those credentials are unrecoverable.

  Phoenix binds 0.0.0.0:${PORT} (not env-configurable) — firewall
  ${PORT} to localhost-only before exposing this host publicly. Only
  nginx (127.0.0.1) and, at the network layer, the trusted upstream
  reverse-proxy box should be able to reach it.

  Create your first user (same mix task INSTALL.md uses for the Docker
  path — runs via the checkout's own toolchain, not the release, since
  it's a mix task rather than a Grappa.Release.* function):
    sudo -u ${GRAPPA_USER} -H bash -c '
      export PATH="\$HOME/.local/bin:\$HOME/.asdf/shims:\$PATH"
      set -a; . ${ENV_FILE}; set +a
      cd ${REPO_ROOT}
      MIX_ENV=prod mix grappa.create_user --name you --password "change-me"
    '

  Bind an IRC network: see README.md "Bind a network".
EOF
