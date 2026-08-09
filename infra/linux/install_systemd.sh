#!/usr/bin/env bash
# Install/refresh the grappa systemd unit + grappa_beam_wait.sh.
# Enables the unit but does NOT start it — starting is the caller's job
# (install.sh / deploy.sh), which keeps this reusable from both.
#
# Env overrides:
#   REPO_ROOT      default /home/grappa/grappa
#   RELEASE_ROOT   default ${REPO_ROOT}/_build/prod/rel/grappa
#   ENV_FILE       default /etc/grappa/grappa.env

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/grappa/grappa}"
RELEASE_ROOT="${RELEASE_ROOT:-${REPO_ROOT}/_build/prod/rel/grappa}"
ENV_FILE="${ENV_FILE:-/etc/grappa/grappa.env}"

# grappa.service's ExecStartPre runs grappa_beam_wait.sh from its
# checked-in repo path — nothing to copy, just re-assert the exec bit
# after a fresh clone/pull.
chmod 0755 "${REPO_ROOT}/infra/linux/grappa_beam_wait.sh"

echo "[install_systemd] rendering grappa.service (REPO_ROOT=${REPO_ROOT} RELEASE_ROOT=${RELEASE_ROOT} ENV_FILE=${ENV_FILE})"
tmp_unit="$(mktemp)"
trap 'rm -f "${tmp_unit}"' EXIT
sed \
	-e "s|@REPO_ROOT@|${REPO_ROOT}|g" \
	-e "s|@RELEASE_ROOT@|${RELEASE_ROOT}|g" \
	-e "s|@ENV_FILE@|${ENV_FILE}|g" \
	"${REPO_ROOT}/infra/linux/systemd/grappa.service" >"${tmp_unit}"

install -o root -g root -m 0644 "${tmp_unit}" /etc/systemd/system/grappa.service

echo "[install_systemd] daemon-reload + enable"
systemctl daemon-reload
systemctl enable grappa >/dev/null

echo "[install_systemd] done (not started — caller starts/restarts explicitly)"
