#!/usr/bin/env bash
# check-drift.sh — the CI drift-guard for the #665 shared-ground layout.
#
# The design deliberately does NOT generate the provider templates from one
# source (that would be CDK/cdktf — a Node toolchain + synthesized artifacts
# committed anyway, to save ~30 lines of resource graph). Instead the two
# doors are hand-written and a CHECK keeps them honest: every provider wrapper
# must (1) reference the shared bootstrap `first-boot.sh` and (2) expose the
# SAME knob names from infra/cloud/params.contract, marked `grappa-knob: <name>`.
#
# This is a guard, NOT a generator: it never edits a template, it only fails
# loud when the doors drift. It runs against whatever doors exist today
# (infra/aws/) and starts covering infra/terraform/ the day that lands — an
# absent provider directory is not drift, so it is tolerated silently.
#
# Exit 0 = every present door references first-boot.sh and exposes all knobs.
# Exit 1 = drift (a door missing the reference or a knob marker).
# Exit 2 = misuse / missing contract.
#
# Pure filesystem + grep, no network, no cloud CLI — so it lives under bats
# (test/infra/cloud_drift_guard_test.bats), which proves it goes RED on drift.
# bash, `set -euo pipefail`, shellcheck-clean.

set -euo pipefail

# Self-locate so CI can invoke it from any cwd. REPO_ROOT overridable for bats.
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${GRAPPA_REPO_ROOT:-$(cd "$SELF_DIR/../.." && pwd)}"
CONTRACT="${GRAPPA_PARAMS_CONTRACT:-$REPO_ROOT/infra/cloud/params.contract}"

# The bootstrap filename every door must reference (curl-at-ref + exec).
BOOTSTRAP_NAME='first-boot.sh'

# The provider doors. A glob that matches nothing (e.g. infra/terraform absent)
# contributes zero files — tolerated, not an error.
AWS_GLOB="$REPO_ROOT/infra/aws/*.yaml"
TF_GLOB="$REPO_ROOT/infra/terraform/*.tf"

say() { printf '[check-drift] %s\n' "$*"; }
fail() { printf '[check-drift] DRIFT: %s\n' "$*" >&2; drift=1; }

[ -f "$CONTRACT" ] || {
	printf '[check-drift] missing params contract: %s\n' "$CONTRACT" >&2
	exit 2
}

# Parse the canonical knob names from the KNOBS block (between the BEGIN/END
# markers), skipping blanks + comments.
read_knobs() {
	awk '
		/^# BEGIN KNOBS$/ { inb = 1; next }
		/^# END KNOBS$/   { inb = 0 }
		inb && $0 !~ /^#/ && NF { print $1 }
	' "$CONTRACT"
}

# Collect present door files across every provider glob (nullglob so an absent
# directory yields nothing rather than the literal glob string).
door_files() {
	shopt -s nullglob
	# shellcheck disable=SC2206  # word-splitting the glob into paths is intended
	local doors=($AWS_GLOB $TF_GLOB)
	shopt -u nullglob
	# Guard the empty case: `printf '%s\n' "${empty[@]}"` emits one blank line,
	# which mapfile would read as a phantom door.
	[ "${#doors[@]}" -gt 0 ] && printf '%s\n' "${doors[@]}"
}

mapfile -t KNOBS < <(read_knobs)
[ "${#KNOBS[@]}" -gt 0 ] || {
	printf '[check-drift] no knobs parsed from %s (empty KNOBS block?)\n' "$CONTRACT" >&2
	exit 2
}

mapfile -t DOORS < <(door_files)
if [ "${#DOORS[@]}" -eq 0 ]; then
	# No provider template exists yet — nothing to guard, not a failure.
	say "no provider doors found (infra/aws, infra/terraform) — nothing to check"
	exit 0
fi

drift=0
for door in "${DOORS[@]}"; do
	say "checking $door"

	# (1) references the shared bootstrap.
	grep -q "$BOOTSTRAP_NAME" "$door" \
		|| fail "$door does not reference $BOOTSTRAP_NAME (must curl+exec the shared bootstrap, not inline it)"

	# (2) exposes every knob via its grappa-knob marker.
	for knob in "${KNOBS[@]}"; do
		grep -qE "grappa-knob:[[:space:]]*${knob}([[:space:]]|$)" "$door" \
			|| fail "$door is missing knob marker 'grappa-knob: ${knob}'"
	done
done

if [ "$drift" -ne 0 ]; then
	printf '[check-drift] FAILED — the provider doors drifted from the shared contract.\n' >&2
	exit 1
fi

say "OK — all ${#DOORS[@]} door(s) reference $BOOTSTRAP_NAME and expose all ${#KNOBS[@]} knobs"
exit 0
