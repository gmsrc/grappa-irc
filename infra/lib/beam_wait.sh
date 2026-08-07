# shellcheck shell=sh
# infra/lib/beam_wait.sh — shared BEAM shutdown / epmd name-release wait (#923).
#
# The SINGLE implementation of the stop/start race killer for defect #9
# (2026-06-11 prod outage: a `service grappa restart` started the new
# BEAM while the old node was still draining WS connections; the new
# node died at boot with "the name grappa@grappa seems to be in use by
# another Erlang node" and rc.d walked away silent).
#
# Extracted here for the same reason deploy_common.sh was (#503): it had
# been copy-pasted per substrate, and the copy had already begun to
# drift — infra/linux/grappa_beam_wait.sh described itself as a "trimmed
# port" and had lost the two escalation-safety comments that say WHY
# pkill'ing epmd is only safe once the BEAM is confirmed dead. One
# algorithm, one test suite, no second place to fix a bug in.
#
# This file is SOURCED, never executed. Strict POSIX sh — no bash
# arrays, no `[[ ]]`, no `local`. Consumers keep their own shebangs
# (jail = /bin/sh, linux = bash), set whatever substrate config they
# need (the jail pins the Erlang pkg bin dir onto PATH), then call
# `beam_wait_main "$@"`.
#
# Consumers:
#   - infra/freebsd/jail_beam_wait.sh   rc.d/grappa (stop + pre-start)
#                                       and deploy.sh's cold path
#   - infra/linux/grappa_beam_wait.sh   grappa.service ExecStartPre
#
# Verbs (all args required — no defaults):
#   wait-stopped <node> <timeout>    Block until beam.smp has exited
#                                    AND epmd no longer lists <node>.
#                                    Escalates: SIGKILL the BEAM after
#                                    <timeout>s; restart epmd if the
#                                    name is still listed <timeout>s
#                                    after the BEAM is gone (safe ONLY
#                                    then — pkill'ing epmd under a
#                                    live BEAM makes the BEAM respawn
#                                    it and re-races the registration,
#                                    live-repro 2026-05-31).
#   wait-name-free <node> <timeout>  Block until epmd no longer lists
#                                    <node>. NO escalation — used as
#                                    the pre-start guard, where the
#                                    registered name may belong to a
#                                    still-draining old node that must
#                                    not be shot.
#
# Exit codes: 0 condition met, 1 timeout (after escalation for
# wait-stopped), 64 usage.

# `epmd -names` exits non-zero when no epmd is running — no daemon, no
# registrations, name trivially free.
beam_wait_name_registered() {
	out=$(epmd -names 2>/dev/null) || return 1
	printf '%s\n' "${out}" | grep -q "^name $1 at "
}

# Single-tenant host: the only BEAM that ever runs on either substrate
# is grappa's, so matching on the emulator binary name is unambiguous
# (and survives pid file staleness, which a crashed run_erl leaves
# behind).
beam_wait_beam_alive() {
	pgrep -q beam.smp 2>/dev/null
}

beam_wait_stopped() {
	node="$1"
	timeout="$2"

	i=0
	while beam_wait_beam_alive; do
		if [ "${i}" -ge "${timeout}" ]; then
			echo "[beam-wait] WARNING: BEAM still alive ${timeout}s after stop — SIGKILL" >&2
			pkill -9 beam.smp 2>/dev/null || true
			sleep 1
			break
		fi
		i=$((i + 1))
		sleep 1
	done

	i=0
	while beam_wait_name_registered "${node}"; do
		if [ "${i}" -ge "${timeout}" ]; then
			# BEAM confirmed gone yet epmd still lists the name — a
			# stale registration. Restarting epmd is safe now: no BEAM
			# is alive to respawn it mid-kill, and the next release
			# start spawns a fresh one.
			echo "[beam-wait] WARNING: epmd still lists '${node}' ${timeout}s after BEAM exit — restarting epmd" >&2
			pkill epmd 2>/dev/null || true
			sleep 1
			break
		fi
		i=$((i + 1))
		sleep 1
	done

	if beam_wait_beam_alive || beam_wait_name_registered "${node}"; then
		echo "[beam-wait] ERROR: BEAM or epmd name '${node}' still present after escalation — manual intervention needed (pgrep beam.smp; epmd -names)" >&2
		return 1
	fi
}

beam_wait_name_free() {
	node="$1"
	timeout="$2"

	i=0
	while beam_wait_name_registered "${node}"; do
		if [ "${i}" -ge "${timeout}" ]; then
			echo "[beam-wait] ERROR: epmd name '${node}' still registered after ${timeout}s — an old node is still draining or stuck; wait for it (epmd -names) and retry" >&2
			return 1
		fi
		i=$((i + 1))
		sleep 1
	done
}

beam_wait_usage() {
	echo "usage: $0 wait-stopped|wait-name-free <node> <timeout-seconds>" >&2
	exit 64
}

# Entry point. Called by the consumer AFTER it has set up its substrate
# config — the epmd probe below must see the final PATH, which is why it
# lives here and not at source time (a lib that warns when merely sourced
# is a footgun).
beam_wait_main() {
	# If epmd is not on PATH every name_registered() check reads as
	# "free" — warn loudly rather than degrade the wait to BEAM-exit-only
	# without a trace.
	if ! command -v epmd >/dev/null 2>&1; then
		echo "[beam-wait] WARNING: epmd binary not found on PATH — name-release checks degraded to BEAM-exit only" >&2
	fi

	[ $# -eq 3 ] || beam_wait_usage

	case "$1" in
		wait-stopped) beam_wait_stopped "$2" "$3" ;;
		wait-name-free) beam_wait_name_free "$2" "$3" ;;
		*) beam_wait_usage ;;
	esac
}
