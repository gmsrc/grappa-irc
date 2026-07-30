#!/usr/bin/env bash
# grappa — update deploy for a native Linux (systemd) host. Run as root.
# Preflight-driven hot-vs-cold dispatcher.
#
# Thin consumer of the shared deploy algorithm in
# infra/lib/deploy_common.sh (#503) — the same lib that drives
# infra/freebsd/deploy.sh (jail) and scripts/deploy.sh (Docker), so the
# hot-vs-cold DECISION logic can no longer drift between substrates. This
# script sets config, flips the feature toggles this substrate has today
# (re-exec guard + last-deployed marker; NOT --force-* / nothing-to-do /
# prev-sha-carry — those arrive with #503's enrich step), and defines the
# systemd-specific hooks.
#
# Hot path (preflight returns HOT):
#   git pull -> mix release --overwrite -> POST /admin/reload
#   Sessions preserved (Erlang's 2-version code-loading guarantee).
#   No systemctl call at all.
#
# Cold path (preflight returns COLD):
#   git pull -> mix release --overwrite -> cic build -> migrate ->
#   refresh systemd unit -> systemctl stop/start -> healthcheck loop.
#   Sessions reset, ~seconds of downtime bounded by TimeoutStopSec.
#
# Usage: infra/linux/deploy.sh
#
# Env (same defaults as install.sh): REPO_ROOT, ENV_FILE, GRAPPA_USER, PORT

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/grappa/grappa}"
ENV_FILE="${ENV_FILE:-/etc/grappa/grappa.env}"
GRAPPA_USER="${GRAPPA_USER:-grappa}"
PORT="${PORT:-4000}"
HEALTHCHECK_RETRIES="${HEALTHCHECK_RETRIES:-30}"
HEALTHCHECK_SLEEP="${HEALTHCHECK_SLEEP:-2}"
RELOAD_URL="${RELOAD_URL:-http://127.0.0.1:${PORT}/admin/reload}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export REPO_ROOT ENV_FILE GRAPPA_USER

# ---- lib config + feature toggles -----------------------------------
DEPLOY_SELF_REL="infra/linux/deploy.sh"
DEPLOY_USAGE="[--force-hot|--force-cold]"
DEPLOY_FEATURE_FORCE_FLAGS=1
DEPLOY_FEATURE_DEFER=0
DEPLOY_FEATURE_NOTHING_TO_DO=1
DEPLOY_FEATURE_REEXEC=1
DEPLOY_FEATURE_MARKER=1
DEPLOY_FEATURE_PREV_SHA_CARRY=1

run_as_grappa() {
	sudo -u "${GRAPPA_USER}" -H bash -c "
		export PATH=\"\$HOME/.local/bin:\$HOME/.asdf/shims:\$PATH\"
		cd '${REPO_ROOT}'
		$1
	"
}

# ---- substrate hooks ------------------------------------------------

substrate_pull() {
	PREV_SHA=$(run_as_grappa 'git rev-parse HEAD' | tail -1)
	run_as_grappa 'git pull --ff-only && git log --oneline -3'
	NEW_SHA=$(run_as_grappa 'git rev-parse HEAD' | tail -1)
}

substrate_read_marker() {
	run_as_grappa "cat runtime/last-deployed-sha 2>/dev/null || true" | tail -1
}

substrate_write_marker() {
	# mkdir -p: the marker owns its dir (no-op on a checkout where runtime/
	# already holds the DB; required for any checkout-less reuse).
	run_as_grappa "mkdir -p runtime && printf '%s\n' '${NEW_SHA}' > runtime/last-deployed-sha"
}

substrate_commit_exists() {
	# Boolean predicate — the lib evaluates this inside `base=$(...)`, so
	# suppress stdout too (not just stderr) to keep the captured range base
	# clean of any run_as subshell noise.
	run_as_grappa "git cat-file -e '$1^{commit}'" >/dev/null 2>&1
}

substrate_changed_files() {
	run_as_grappa "git diff --name-only '$1..$2'"
}

substrate_preflight() {
	# `mix run --no-start` boots the BEAM without starting the app. The env
	# file is sourced first: config/runtime.exs raises on missing
	# DATABASE_PATH & co, and `sudo -u ... bash -c` does not inherit the
	# systemd unit's EnvironmentFile.
	#
	# deps.get runs BEFORE the oneshot (#541, Co-authored-by abonforti): a
	# pull that moved mix.exs/mix.lock leaves deps stale, and `mix run`
	# aborts on that — preflight would then exit 1 (a crash, not a 0/3
	# verdict) and the deploy would strand before ever reaching the build
	# step's own deps.get. `&&` so a deps.get failure surfaces as a
	# non-verdict abort rather than a silently-misclassified deploy;
	# idempotent + cheap when in sync, and build re-runs it so the
	# preflight-skipping --force-* paths still fetch before compile.
	run_as_grappa "
		set -a; . '${ENV_FILE}'; set +a
		export MIX_ENV=prod
		mix deps.get --only prod &&
		mix run --no-start -e 'Grappa.Deploy.Preflight.cli([\"$1\", \"$2\", \"linux\"])'
	"
}

substrate_build() {
	# MIX_ENV=prod required — without it mix defaults to :dev and compile
	# fails on missing dev-only deps that --only prod never fetched. mix
	# release --overwrite runs on BOTH paths: it writes fresh .beam into
	# the daemon's code path, which the hot reload POST then loads.
	deploy_log "mix deps.get --only prod / compile / release --overwrite"
	run_as_grappa '
		export MIX_ENV=prod
		mix deps.get --only prod
		mix compile --warnings-as-errors
		mix release --overwrite
	'
}

substrate_reload() {
	# Hot path: tell the live BEAM to md5-walk the release's ebin and
	# reload changed modules (Grappa.HotReload). No systemctl, no cic
	# rebuild, no migration — preflight only returns HOT when none of
	# those changed. The lib captures this hook's stdout as the reload
	# response body, so the pre-reload log goes to stderr (else it
	# pollutes the JSON the "failed":[] honesty glob inspects).
	deploy_log "POST ${RELOAD_URL}" >&2
	curl -fsS -X POST "${RELOAD_URL}"
}

substrate_cic() {
	deploy_log "cic_build.sh"
	"${SCRIPT_DIR}/cic_build.sh" "${REPO_ROOT}"
}

substrate_migrate() {
	# Plain `mix ecto.migrate`, not release eval — see install.sh's
	# matching comment: the packaged release's eval boot path crashes the
	# BEAM on this substrate (isolated to start_clean boot; systemd's own
	# `bin/grappa start` path is unaffected).
	deploy_log "migrate"
	run_as_grappa "
		set -a; . '${ENV_FILE}'; set +a
		export MIX_ENV=prod
		mix ecto.migrate
	"
}

substrate_restart() {
	deploy_log "refresh systemd unit + grappa_beam_wait.sh (safe before stop — daemon-reload doesn't touch the already-running unit)"
	"${SCRIPT_DIR}/install_systemd.sh"

	deploy_log "systemctl stop grappa (blocks natively under Type=exec — no wait-loop needed)"
	systemctl stop grappa

	deploy_log "systemctl start grappa"
	systemctl start grappa
}

substrate_healthcheck() {
	curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/healthz"
}

substrate_done_banner() {
	deploy_log "✓ ${MODE} deploy complete (${NEW_SHA}) after $1 retries"
}

# ---- run ------------------------------------------------------------
# shellcheck source=infra/lib/deploy_common.sh
. "${SCRIPT_DIR}/../lib/deploy_common.sh"

deploy_main "$@"
