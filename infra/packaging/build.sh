#!/usr/bin/env bash
# build.sh — assemble the grappa .deb from a mix release + the cicchetto
# SPA dist, via nfpm.
#
# Runs in a Debian/glibc environment with the Elixir 1.19 / OTP 28
# toolchain + bun on PATH — i.e. the release CI runner (setup-beam), or,
# for a local isolated build, inside the official `elixir:1.19-otp-28`
# image (Debian-based; NOT the alpine dev image — alpine/musl ERTS will
# not run on a glibc target). See infra/packaging/README.md for the
# one-liner docker invocation.
#
# It deliberately does NOT use scripts/*.sh (the dev compose stack): those
# share the MAIN repo's _build via the ./:/app bind mount, so building
# here would contend with concurrent dev/CI compiles. This build wants its
# OWN, throwaway _build.
#
# Env knobs (all optional):
#   GRAPPA_VERSION    package version (default: @version from mix.exs)
#   GRAPPA_PKG_ARCH   deb-style arch (default: dpkg --print-architecture /
#                     uname map). nfpm translates it per format (amd64 ->
#                     x86_64 for rpm), so the SAME value drives both.
#   GRAPPA_PKG_FORMAT deb | rpm — the nfpm output format (default: deb; #438).
#                     The staging tree is format-agnostic; the ONLY constraint
#                     is that the bundled ERTS + shottino must link the TARGET
#                     distro's glibc/libssl — so rpm builds run in a Fedora
#                     container (release.yml `rpm` job), never on the Debian
#                     runner that builds the deb.
#   OUT_DIR           where the package lands (default: <repo>/dist)
#   NFPM_BIN          path to nfpm (default: on PATH, else downloaded pinned)
#   SKIP_RELEASE=1    reuse an existing _build/prod/rel/grappa
#   SKIP_CIC=1        reuse an existing staged cicchetto-dist

set -euo pipefail

NFPM_VERSION="2.43.0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PKG_DIR="${SCRIPT_DIR}"
STAGING="${PKG_DIR}/staging"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/dist}"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

# ── Version ────────────────────────────────────────────────────────────────
# Single source of truth: mix.exs @version, read via version.sh (#538). The
# env override stays for a one-off build of a pinned version.
if [ -z "${GRAPPA_VERSION:-}" ]; then
	GRAPPA_VERSION="$("${SCRIPT_DIR}/version.sh")" || die "could not read @version from mix.exs — set GRAPPA_VERSION"
fi
export GRAPPA_VERSION

# ── Architecture ───────────────────────────────────────────────────────────
if [ -z "${GRAPPA_PKG_ARCH:-}" ]; then
	if command -v dpkg >/dev/null 2>&1; then
		GRAPPA_PKG_ARCH="$(dpkg --print-architecture)"
	else
		case "$(uname -m)" in
		x86_64) GRAPPA_PKG_ARCH="amd64" ;;
		aarch64 | arm64) GRAPPA_PKG_ARCH="arm64" ;;
		*) die "unknown arch $(uname -m) — set GRAPPA_PKG_ARCH" ;;
		esac
	fi
fi
export GRAPPA_PKG_ARCH

# ── Package format ───────────────────────────────────────────────────────────
# deb (default) or rpm. Rejected at the boundary so a typo fails here, not
# with an opaque nfpm error. The value doubles as the output file extension.
GRAPPA_PKG_FORMAT="${GRAPPA_PKG_FORMAT:-deb}"
case "${GRAPPA_PKG_FORMAT}" in
deb | rpm) ;;
*) die "GRAPPA_PKG_FORMAT must be deb or rpm, got '${GRAPPA_PKG_FORMAT}'" ;;
esac

say "building grappa ${GRAPPA_VERSION} (${GRAPPA_PKG_ARCH}, ${GRAPPA_PKG_FORMAT})"

# ── mix release ────────────────────────────────────────────────────────────
if [ "${SKIP_RELEASE:-}" != "1" ]; then
	command -v mix >/dev/null 2>&1 || die "mix not on PATH — run inside the elixir:1.19-otp-28 image or a setup-beam runner"
	say "mix deps.get + release (MIX_ENV=prod)"
	(
		cd "${REPO_ROOT}"
		mix local.hex --force
		mix local.rebar --force
		mix deps.get --only prod
		MIX_ENV=prod mix compile --warnings-as-errors
		MIX_ENV=prod mix release --overwrite
	)
fi
REL_DIR="${REPO_ROOT}/_build/prod/rel/grappa"
[ -x "${REL_DIR}/bin/grappa" ] || die "release not found at ${REL_DIR} (SKIP_RELEASE without a prior build?)"

# ── cicchetto dist ─────────────────────────────────────────────────────────
DIST_STAGE="${STAGING}/usr/share/grappa/cicchetto-dist"
if [ "${SKIP_CIC:-}" != "1" ]; then
	command -v bun >/dev/null 2>&1 || die "bun not on PATH — needed for the cicchetto build"
	say "bun install + build (outDir=${DIST_STAGE})"
	rm -rf "${DIST_STAGE}"
	mkdir -p "${DIST_STAGE}"
	(
		cd "${REPO_ROOT}/cicchetto"
		bun install --frozen-lockfile
		bun run build -- --outDir "${DIST_STAGE}" --emptyOutDir
	)
fi
[ -f "${DIST_STAGE}/index.html" ] || die "cicchetto dist missing index.html at ${DIST_STAGE}"

# ── Stage the release ──────────────────────────────────────────────────────
say "staging release → ${STAGING}/usr/lib/grappa"
rm -rf "${STAGING}/usr/lib/grappa"
mkdir -p "${STAGING}/usr/lib/grappa"
cp -a "${REL_DIR}/." "${STAGING}/usr/lib/grappa/"

# ── shottino (terminal client) ─────────────────────────────────────────────
# The C client ships in the same package as the bouncer. Its runtime deps
# (ncursesw, libssl) are ALREADY in nfpm.yaml's `depends` — the bundled ERTS
# links the same two — so shipping it costs one ~180 KB binary and adds no
# new dependency.
#
# Built here rather than shipped prebuilt because it links the BUILD host's
# ncurses/openssl, exactly like the ERTS payload. That is the same
# constraint that makes this a valid .deb and not a valid .rpm.
#
# SKIP_SHOTTINO=1 opts out (mirrors SKIP_RELEASE / SKIP_CIC). Without the
# opt-out a build failure FAILS the package build: a package that silently
# ships without a binary it advertises is worse than one that refuses to
# build.
SHOTTINO_BIN="${STAGING}/usr/bin/shottino"
if [ "${SKIP_SHOTTINO:-}" != "1" ]; then
	say "building shottino → ${SHOTTINO_BIN}"
	# ./configure rewrites ${REPO_ROOT}/config.mk, which is a TRACKED file.
	# Leaving it modified makes `git status --porcelain` non-empty, and
	# Grappa.Version treats a dirty tree as unreleased — it appends
	# -<shortsha> instead of reporting the bare tag, which would fail the
	# release workflow's version proof. The mix release runs earlier so
	# the CURRENT step order happens to be safe, but silently depending on
	# that ordering is a trap for whoever reorders this next. Snapshot and
	# restore so the build leaves the tree exactly as it found it.
	cfg="${REPO_ROOT}/config.mk"
	cfg_backup=""
	if [ -f "${cfg}" ]; then
		cfg_backup="$(mktemp)"
		cp -a "${cfg}" "${cfg_backup}"
	fi
	restore_config_mk() {
		if [ -n "${cfg_backup}" ] && [ -f "${cfg_backup}" ]; then
			mv -f "${cfg_backup}" "${cfg}"
		fi
	}
	# Restore on ANY exit path, including a failed compile below.
	trap restore_config_mk EXIT
	(
		cd "${REPO_ROOT}"
		# configure probes ncursesw + openssl through pkg-config and writes
		# config.mk, which the Makefile reads. It fails loudly on a missing
		# dep rather than producing a half-linked binary.
		./configure --prefix=/usr
		make -C frontends/shottino clean
		make -C frontends/shottino
	)
	mkdir -p "${STAGING}/usr/bin"
	install -m 0755 "${REPO_ROOT}/frontends/shottino/shottino" "${SHOTTINO_BIN}"
	# Prove the staged artifact RUNS before packaging it. `--help` needs no
	# server, no terminal and no config, so it exercises the dynamic links
	# for real instead of just asserting the file exists.
	"${SHOTTINO_BIN}" --help >/dev/null 2>&1 || die "staged shottino does not run (link error?)"
	[ -x "${SHOTTINO_BIN}" ] || die "shottino missing at ${SHOTTINO_BIN}"
	# Put config.mk back now that the compile is done, and drop the trap so
	# it cannot fire twice.
	restore_config_mk
	trap - EXIT
fi

# ── nfpm ───────────────────────────────────────────────────────────────────
nfpm_bin="${NFPM_BIN:-}"
if [ -z "${nfpm_bin}" ]; then
	if command -v nfpm >/dev/null 2>&1; then
		nfpm_bin="nfpm"
	else
		say "nfpm not found — downloading pinned v${NFPM_VERSION}"
		tmp="$(mktemp -d)"
		trap 'rm -rf "${tmp}"' EXIT
		case "${GRAPPA_PKG_ARCH}" in
		amd64) nfpm_arch="x86_64" ;;
		arm64) nfpm_arch="arm64" ;;
		*) die "no nfpm download mapping for ${GRAPPA_PKG_ARCH}" ;;
		esac
		url="https://github.com/goreleaser/nfpm/releases/download/v${NFPM_VERSION}/nfpm_${NFPM_VERSION}_Linux_${nfpm_arch}.tar.gz"
		curl -fsSL "${url}" | tar -xz -C "${tmp}" nfpm
		nfpm_bin="${tmp}/nfpm"
	fi
fi

mkdir -p "${OUT_DIR}"
say "nfpm package (${GRAPPA_PKG_FORMAT}) → ${OUT_DIR}"
(
	cd "${PKG_DIR}"
	"${nfpm_bin}" package -f nfpm.yaml -p "${GRAPPA_PKG_FORMAT}" -t "${OUT_DIR}"
)

say "done — package(s) in ${OUT_DIR}:"
ls -la "${OUT_DIR}"/*."${GRAPPA_PKG_FORMAT}"
