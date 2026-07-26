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
#   GRAPPA_VERSION   package version (default: @version from mix.exs)
#   GRAPPA_PKG_ARCH  deb arch (default: dpkg --print-architecture / uname map)
#   OUT_DIR          where the .deb lands (default: <repo>/dist)
#   NFPM_BIN         path to nfpm (default: on PATH, else downloaded pinned)
#   SKIP_RELEASE=1   reuse an existing _build/prod/rel/grappa
#   SKIP_CIC=1       reuse an existing staged cicchetto-dist

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
if [ -z "${GRAPPA_VERSION:-}" ]; then
	GRAPPA_VERSION="$(grep -oE '@version "[^"]+"' "${REPO_ROOT}/mix.exs" | head -1 | sed -E 's/@version "([^"]+)"/\1/')"
	[ -n "${GRAPPA_VERSION}" ] || die "could not read @version from mix.exs — set GRAPPA_VERSION"
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

say "building grappa ${GRAPPA_VERSION} (${GRAPPA_PKG_ARCH})"

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
say "nfpm package → ${OUT_DIR}"
(
	cd "${PKG_DIR}"
	"${nfpm_bin}" package -f nfpm.yaml -p deb -t "${OUT_DIR}"
)

say "done — package(s) in ${OUT_DIR}:"
ls -la "${OUT_DIR}"/*.deb
