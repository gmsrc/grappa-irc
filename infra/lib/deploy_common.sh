# shellcheck shell=sh
# infra/lib/deploy_common.sh — shared POSIX-sh deploy algorithm (#503).
#
# The SINGLE source of truth for the hot-vs-cold deploy ALGORITHM shared
# by every production substrate: infra/freebsd/deploy.sh (bastille jail),
# infra/linux/deploy.sh (systemd host), scripts/deploy.sh (operator
# Docker). Extracted to KILL copy-paste drift — the 2026-06-11 outage
# root cause was three near-identical deploy scripts drifting apart
# (defects #7/#8/#9, all "fixed in one script, still live in another").
#
# This file is SOURCED, never executed. It is strict POSIX sh — no bash
# arrays, no `[[ ]]`, no `local`. Consumers keep their own shebangs
# (jail = /bin/sh, linux/docker = bash) and may use bashisms in their
# OWN hooks; the shared algorithm below stays POSIX so `dash`/`sh` can
# run it on the jail.
#
# ── Contract ────────────────────────────────────────────────────────
# A consumer script:
#   1. sets config vars (REPO_ROOT, HEALTHCHECK_*, DEPLOY_SELF_REL, …)
#   2. flips the feature toggles it wants ON (see below)
#   3. defines the substrate hooks (see below)
#   4. sources this file
#   5. calls `deploy_main "$@"`
#
# The lib OWNS (substrate-independent): flag parse, DEPLOY_PREV_SHA carry
# across re-exec, the re-exec guard, the marker base-select + validate,
# the nothing-to-do predicate, the preflight verdict→mode mapping, the
# reload "failed":[] honesty check, the healthcheck loop, and the marker
# write. Every one of those is a documented invariant that previously
# lived — and drifted — per script.
#
# The consumer OWNS (substrate hooks — the 20% that genuinely differ):
#   substrate_pull            sets PREV_SHA + NEW_SHA globals (git pull)
#   substrate_read_marker     echoes runtime/last-deployed-sha (or empty)
#   substrate_write_marker    writes NEW_SHA to runtime/last-deployed-sha
#   substrate_commit_exists S returns 0 iff S names a commit in the repo
#   substrate_changed_files A B  echoes `git diff --name-only A..B`
#   substrate_preflight F T   runs the Preflight oneshot; exit 0=hot 3=cold
#   substrate_build           deps/compile/release, or image build
#   substrate_reconcile       install out-of-repo artifacts (both paths; opt-in
#                             via DEPLOY_FEATURE_RECONCILE; MUST be idempotent)
#   substrate_seed            materialise versioned built-in data into the DB
#                             (both paths; MUST be idempotent; non-fatal)
#   substrate_reload          echoes /admin/reload HTTP body; nonzero=POST failed
#   substrate_cic             cic bundle build (cold only)
#   substrate_migrate         ecto migrate (cold only)
#   substrate_restart         stop/start the daemon (cold only; may exit on defer)
#   substrate_healthcheck     one /healthz probe; 0=200, nonzero=not yet
#   substrate_done_banner N   print the success line (N = retries taken); the
#                             wording is substrate-specific (sessions preserved
#                             vs container recreated vs daemon respawned)
#
# ── Feature toggles (consumer sets to 1 to enable; default OFF) ──────
#   DEPLOY_FEATURE_FORCE_FLAGS    accept --force-hot / --force-cold
#   DEPLOY_FEATURE_DEFER          accept --defer-restart (cold-only)
#   DEPLOY_FEATURE_NOTHING_TO_DO  marker-gated nothing-to-do fast path
#   DEPLOY_FEATURE_REEXEC         self-modifying-script re-exec guard
#   DEPLOY_FEATURE_MARKER         read/write runtime/last-deployed-sha
#   DEPLOY_FEATURE_PREV_SHA_CARRY carry DEPLOY_PREV_SHA across re-exec
#   DEPLOY_FEATURE_RECONCILE      run substrate_reconcile on BOTH paths
#
# ── The one toggle that defaults ON ─────────────────────────────────
#   DEPLOY_FEATURE_SEED           run substrate_seed on BOTH paths (default 1)
#
# Every toggle above is a CAPABILITY — a substrate may legitimately have
# no marker, no --defer-restart, no re-exec guard — so they default OFF
# and the consumer opts in. Seeding is not a capability, it is a
# CORRECTNESS property every substrate needs (#440), so it defaults ON
# and a substrate would have to opt OUT. Defaulting it off would rebuild
# the very defect #440 reports: a substrate that silently forgets to
# seed. There is deliberately NO fallback substrate_seed — a consumer
# that fails to define the hook must break loudly in CI, not quietly
# seed nothing.
#
# ── Mode state exported to hooks ────────────────────────────────────
#   MODE      auto|hot|cold (resolved before any build/restart hook runs)
#   DEFER     0|1 (--defer-restart requested)
#   PREV_SHA  pre-pull HEAD (post-carry)
#   NEW_SHA   post-pull HEAD (or the token the consumer diffs `to`)

# ---- config defaults (consumer overrides before deploy_main) --------
: "${HEALTHCHECK_RETRIES:=30}"
: "${HEALTHCHECK_SLEEP:=2}"

# Per-mode healthcheck override (Docker's hot loop is fast/short, its
# cold loop long — jail/linux leave these unset and fall back to the
# shared defaults above). Resolved at loop time so a consumer only sets
# what actually diverges.
_deploy_hot_retries()  { printf '%s' "${HOT_HEALTHCHECK_RETRIES:-$HEALTHCHECK_RETRIES}"; }
_deploy_hot_sleep()    { printf '%s' "${HOT_HEALTHCHECK_SLEEP:-$HEALTHCHECK_SLEEP}"; }
_deploy_cold_retries() { printf '%s' "${COLD_HEALTHCHECK_RETRIES:-$HEALTHCHECK_RETRIES}"; }
_deploy_cold_sleep()   { printf '%s' "${COLD_HEALTHCHECK_SLEEP:-$HEALTHCHECK_SLEEP}"; }

: "${DEPLOY_FEATURE_FORCE_FLAGS:=0}"
: "${DEPLOY_FEATURE_DEFER:=0}"
: "${DEPLOY_FEATURE_NOTHING_TO_DO:=0}"
: "${DEPLOY_FEATURE_REEXEC:=0}"
: "${DEPLOY_FEATURE_MARKER:=0}"
: "${DEPLOY_FEATURE_PREV_SHA_CARRY:=0}"
: "${DEPLOY_FEATURE_RECONCILE:=0}"
: "${DEPLOY_FEATURE_SEED:=1}"

# Set by _deploy_seed when the seed hook failed, read by the post-banner
# re-assert. Not a toggle — deploy state.
DEPLOY_SEED_FAILED=0

# Path (repo-relative) of the consumer deploy script, for the re-exec
# guard's diff match and the `exec` target. The lib appends its OWN path
# so a change to the shared algorithm re-execs too (behavior-preserving:
# the extracted bytes must reload exactly as the inlined bytes did).
: "${DEPLOY_SELF_REL:=}"
DEPLOY_LIB_REL="infra/lib/deploy_common.sh"

# Argument(s) the re-exec guard must PREPEND when it re-invokes the
# consumer script. Empty for a verb-less consumer (jail/linux/operator
# docker: `deploy.sh --force-hot`), so re-exec replays the argv verbatim.
# A verb-dispatched consumer (infra/docker/deploy.sh `update …`) sets this
# to its verb so re-exec replays `deploy.sh update …` — else the guard
# would drop the verb and the re-exec'd run would fall through to a usage
# error. Word-split on purpose (a single verb token).
: "${DEPLOY_REEXEC_PREFIX:=}"

# ---- logging --------------------------------------------------------
deploy_log()   { printf '[deploy] %s\n' "$*"; }
deploy_error() { printf '[deploy] ERROR: %s\n' "$*" >&2; }

deploy_usage() {
	printf 'usage: %s %s\n' "$0" "${DEPLOY_USAGE:-[--force-hot|--force-cold]}" >&2
	exit 64
}

_deploy_defer_hot_error() {
	printf 'usage: --defer-restart is only valid on the cold path (not with a hot deploy)\n' >&2
	exit 64
}

# ---- flag parse -----------------------------------------------------
# Sets MODE + DEFER. Toggle-gated: a flag the consumer did not enable is
# an unknown flag → usage error, same as garbage.
_deploy_parse_flags() {
	MODE=auto
	DEFER=0
	while [ $# -gt 0 ]; do
		case "$1" in
			--force-hot)
				[ "$DEPLOY_FEATURE_FORCE_FLAGS" = 1 ] || deploy_usage
				MODE=hot
				;;
			--force-cold)
				[ "$DEPLOY_FEATURE_FORCE_FLAGS" = 1 ] || deploy_usage
				MODE=cold
				;;
			--defer-restart)
				[ "$DEPLOY_FEATURE_DEFER" = 1 ] || deploy_usage
				DEFER=1
				;;
			*) deploy_usage ;;
		esac
		shift
	done
}

# ---- marker validate (shape + real commit) --------------------------
_deploy_marker_valid() {
	m="$1"
	[ "${#m}" -eq 40 ] || return 1
	case "$m" in
		*[!0-9a-f]*) return 1 ;;
	esac
	substrate_commit_exists "$m"
}

# Echo the preflight range base: the marker when valid, else the pre-pull
# HEAD. A present-but-garbage marker aborts LOUDLY here — a silent
# fallback to prev_sha would re-open the range hole the marker closes
# (defect #7), and feeding garbage to `git diff` would crash the oneshot
# with an opaque exit 1 the verdict case-statement can't interpret.
_deploy_preflight_base() {
	base="$PREV_SHA"
	if [ "$DEPLOY_FEATURE_MARKER" = 1 ] && [ -n "$LAST_DEPLOYED" ]; then
		if _deploy_marker_valid "$LAST_DEPLOYED"; then
			base="$LAST_DEPLOYED"
		else
			deploy_error "runtime/last-deployed-sha contains '$LAST_DEPLOYED' — not a full sha of a commit in this repo"
			printf '[deploy]   fix the marker (write the last deployed sha) or rerun with an explicit --force-hot/--force-cold\n' >&2
			exit 1
		fi
	fi
	printf '%s' "$base"
}

# ---- nothing-to-do (marker-gated) -----------------------------------
# Exits 0 ONLY when auto + no new commits + the last deploy COMPLETED
# (marker == HEAD). "No new commits" alone lies when a prior deploy died
# mid-flight (defect #8), and an explicit --force-* is an operator order,
# not a heuristic input. Fast paths state what they OBSERVED.
_deploy_nothing_to_do() {
	if [ "$PREV_SHA" = "$NEW_SHA" ] && [ "$LAST_DEPLOYED" = "$NEW_SHA" ]; then
		if [ "$MODE" = auto ]; then
			deploy_log "same HEAD ($NEW_SHA) + completed-deploy marker match — nothing to do"
			exit 0
		fi
		deploy_log "same HEAD ($NEW_SHA) + completed-deploy marker match, but --force-$MODE overrides — proceeding"
	elif [ "$PREV_SHA" = "$NEW_SHA" ]; then
		deploy_log "HEAD unchanged ($NEW_SHA) but last COMPLETED server deploy is '${LAST_DEPLOYED:-none}' — driving the gap (a cic-only deploy advances HEAD without applying server changes; or a prior deploy died mid-flight)"
	fi
}

# ---- re-exec guard (self-modifying script) --------------------------
# git pull replaces files by rename, so the running interpreter keeps
# executing PRE-PULL bytes from the old inode — a fix to the deploy
# pipeline would silently no-op on the first deploy that ships it
# (live-repro 2026-05-31). Re-exec so the NEW bytes run downstream of
# the pull. Detection is by DIFF RANGE touching the consumer script OR
# this shared lib. Keyed on the PRE-PULL range (prev..new), NOT the
# marker range — this answers "did THIS pull change the bytes I am
# running?", to which the marker is irrelevant.
_deploy_reexec_guard() {
	[ -z "${DEPLOY_REEXECED:-}" ] || return 0
	changed=$(substrate_changed_files "$PREV_SHA" "$NEW_SHA")
	case "
$changed
" in
		*"
$DEPLOY_SELF_REL
"*|*"
$DEPLOY_LIB_REL
"*)
			deploy_log "deploy code changed in $PREV_SHA..$NEW_SHA — re-exec to load new bytes"
			DEPLOY_REEXECED=1
			export DEPLOY_REEXECED
			if [ "$DEPLOY_FEATURE_PREV_SHA_CARRY" = 1 ]; then
				DEPLOY_PREV_SHA="$PREV_SHA"
				export DEPLOY_PREV_SHA
			fi
			# shellcheck disable=SC2086  # DEPLOY_REEXEC_PREFIX is an intentional verb prefix (empty → verbatim replay)
			exec "$REPO_ROOT/$DEPLOY_SELF_REL" $DEPLOY_REEXEC_PREFIX "$@"
			;;
	esac
}

# ---- preflight verdict → mode ---------------------------------------
_deploy_resolve_mode() {
	if [ "$MODE" != auto ]; then
		deploy_log "--force-$MODE: skipping preflight"
		return 0
	fi
	base=$(_deploy_preflight_base)
	deploy_log "preflight: classifying $base..$NEW_SHA"
	rc=0
	substrate_preflight "$base" "$NEW_SHA" || rc=$?
	case "$rc" in
		0) MODE=hot ;;
		3) MODE=cold ;;
		*)
			# Not a verdict (mix crash 1, usage 2, …). Falling through to
			# cold silently converts a miswired call into "always restart";
			# to hot, into "never restart". Neither is a valid guess.
			deploy_error "preflight exited $rc (crash/usage, not a verdict) — aborting"
			exit "$rc"
			;;
	esac
}

# ---- healthcheck loop (owns marker write on first 200) --------------
# $1 retries, $2 sleep. Writes the completed-deploy marker on the first
# 200 (gated on the MARKER feature) — the marker is the "deploy fully
# applied" barrier, so it is written LAST, after the app answers.
_deploy_healthcheck_loop() {
	retries="$1"
	sleep_s="$2"
	deploy_log "healthcheck loop ($retries x ${sleep_s}s)"
	i=0
	while [ "$i" -lt "$retries" ]; do
		if substrate_healthcheck; then
			if [ "$DEPLOY_FEATURE_MARKER" = 1 ]; then
				substrate_write_marker
			fi
			# Substrate-specific success wording (sessions preserved vs
			# container recreated vs daemon respawned) — the consumer owns
			# it; $1 = retries taken.
			substrate_done_banner "$i"
			_deploy_seed_reassert
			exit 0
		fi
		i=$((i + 1))
		sleep "$sleep_s"
	done
	deploy_error "healthcheck never returned 200 after $((retries * sleep_s))s"
	exit 1
}

# ---- seed (versioned built-in data) ---------------------------------
# What the seed set IS, and why this runs every deploy (#440): the
# built-in gallery is versioned CODE materialised into the DB, but it was
# materialised ONCE, at install. Anything added to it later reached new
# installs only — "deploy.sh is missing a line" is the symptom, the
# once-only seeding is the defect. Adding a built-in touches a plain lib
# module, which Preflight classifies HOT, so seeding on the cold path
# alone would miss the very path that ships themes. Same reasoning as
# substrate_reconcile (#646), one layer down: classification sees changed
# PATHS, and no path tells it the seed set grew. The hook must therefore
# be idempotent — it runs on every deploy, forever.
#
# The label is shared (one seed set, substrate-independent); only the
# retry command differs per substrate, so only that is a consumer knob.
: "${DEPLOY_SEED_LABEL:=the built-in theme gallery}"
: "${DEPLOY_SEED_RETRY_HINT:=the grappa.seed_themes task on this substrate}"

# NON-FATAL, deliberately. The gallery is cosmetic; on the cold path this
# runs after the migration and before the restart, so aborting here would
# leave a migrated DB, the old daemon still up, and no restart — trading a
# stale gallery for a half-applied deploy. On an always-on bouncer that is
# the worse of the two by a wide margin. It is not a silent swallow
# either: the completed-deploy marker is written only after a 200, the
# upsert converges, so the NEXT deploy re-runs the seed and heals it.
_deploy_seed() {
	[ "$DEPLOY_FEATURE_SEED" = 1 ] || return 0
	deploy_log "seeding ${DEPLOY_SEED_LABEL} (idempotent)"
	if ! substrate_seed; then
		DEPLOY_SEED_FAILED=1
		deploy_error "seeding failed — ${DEPLOY_SEED_LABEL} was NOT materialised. The deploy continues (the box is healthy; the gallery may be missing or stale)."
		printf '[deploy]   retry with: %s\n' "${DEPLOY_SEED_RETRY_HINT}" >&2
	fi
}

# Re-assert after the ✓ banner. A warning 200 lines up a build log is a
# warning nobody reads, and the last thing on the operator's screen must
# not be an unqualified success line when something did not get applied.
# Gated on the OUTCOME: a warning that fires every run means nothing.
_deploy_seed_reassert() {
	[ "$DEPLOY_SEED_FAILED" = 1 ] || return 0
	deploy_error "reminder: ${DEPLOY_SEED_LABEL} was NOT seeded during this deploy — retry with: ${DEPLOY_SEED_RETRY_HINT}"
}

# ---- hot path -------------------------------------------------------
_deploy_hot() {
	if response=$(substrate_reload); then
		deploy_log "reload response: $response"
		# HTTP 200 is NOT success — the endpoint reports per-module
		# failures IN-BAND. Declaring "✓ complete" over a failed reload
		# leaves prod silently on stale code.
		case "$response" in
			*'"failed":[]'*) ;;
			*)
				deploy_error "reload reported per-module failures (see response above)"
				printf '[deploy]   old code in use? retry once processes settle, or run a cold deploy\n' >&2
				exit 1
				;;
		esac
	else
		# Every substrate_reload uses `curl -f`, which discards the
		# response body on a non-2xx — so this branch knows the POST
		# failed and NOTHING about why. State the two live causes rather
		# than assert the one we used to guess (#41 added the second).
		deploy_error "POST /admin/reload failed"
		printf '[deploy]   the daemon is down/unreachable, OR it refused the hot reload\n' >&2
		printf '[deploy]   (HTTP 409 = a pending migration is CONTRACT → run a cold deploy)\n' >&2
		exit 1
	fi

	# AFTER the reload, for the same schema-before-data reason the cold
	# path seeds after substrate_migrate: since #41 the hot path is not
	# migration-free — POST /admin/reload applies pending expand
	# migrations on the live pool and only THEN loads modules
	# (Grappa.HotReload.migrate_and_reload/0). A seed placed before the
	# reload would therefore run against the PRE-migration schema, which
	# is the very ordering this file rejects on the cold path.
	#
	# It also lands after the reload-honesty check on purpose: a refused
	# or partly-failed reload exits above, and seeding into a deploy that
	# did not take is work at best and confusing at worst.
	_deploy_seed

	_deploy_healthcheck_loop "$(_deploy_hot_retries)" "$(_deploy_hot_sleep)"
}

# ---- cold path ------------------------------------------------------
_deploy_cold() {
	substrate_cic
	substrate_migrate
	# AFTER the migrator: a built-in whose payload needs a column added in
	# the same deploy would crash a seed that ran ahead of the schema.
	# BEFORE the restart: --defer-restart stops in substrate_restart, and a
	# staged deploy must stage a seeded DB too.
	_deploy_seed
	# substrate_restart may `exit 0` on --defer-restart (staged, not
	# started) — in which case the marker is deliberately NOT written.
	substrate_restart
	_deploy_healthcheck_loop "$(_deploy_cold_retries)" "$(_deploy_cold_sleep)"
}

# ---- orchestrator ---------------------------------------------------
deploy_main() {
	_deploy_parse_flags "$@"

	# --defer-restart needs a stop; a hot deploy has none. Catch the
	# statically-known case (--force-hot) before any side effect; the
	# auto→hot case is caught again after preflight resolves the mode.
	if [ "$DEFER" = 1 ] && [ "$MODE" = hot ]; then
		_deploy_defer_hot_error
	fi

	deploy_log "git pull --ff-only"
	substrate_pull

	if [ "$DEPLOY_FEATURE_PREV_SHA_CARRY" = 1 ]; then
		# On re-exec the pre-pull SHA from the FIRST invocation rides in
		# via DEPLOY_PREV_SHA — the re-exec'd run re-pulls a no-op, so its
		# own prev==new and the nothing-to-do check would wrongly exit 0.
		PREV_SHA="${DEPLOY_PREV_SHA:-$PREV_SHA}"
	fi

	LAST_DEPLOYED=""
	if [ "$DEPLOY_FEATURE_MARKER" = 1 ]; then
		LAST_DEPLOYED=$(substrate_read_marker)
	fi

	if [ "$DEPLOY_FEATURE_NOTHING_TO_DO" = 1 ]; then
		_deploy_nothing_to_do
	fi

	if [ "$DEPLOY_FEATURE_REEXEC" = 1 ]; then
		_deploy_reexec_guard "$@"
	fi

	_deploy_resolve_mode

	# auto→hot + --defer-restart: same invariant as the top guard, now
	# that preflight has resolved the mode.
	if [ "$DEFER" = 1 ] && [ "$MODE" = hot ]; then
		_deploy_defer_hot_error
	fi

	echo
	deploy_log "==> mode: $MODE"
	echo

	substrate_build

	# Artifacts the substrate installs OUTSIDE the repo (privilege
	# wrappers and the config they read) drift from the checkout unless
	# something reconciles them. Classification cannot do it: it only sees
	# changed PATHS, so it misses a config rendered from the DB, and it
	# would charge a session-dropping cold restart just to copy a file
	# (#646 — shipping #610 left the old wrapper installed and disarmed
	# mode 2 in prod). So it runs on BOTH paths, after the build and
	# before either the reload or the restart, so the new code never meets
	# the old artifact. The hook must be idempotent: it runs every deploy.
	if [ "$DEPLOY_FEATURE_RECONCILE" = 1 ]; then
		substrate_reconcile
	fi

	if [ "$MODE" = hot ]; then
		_deploy_hot
	else
		_deploy_cold
	fi
}
