#!/usr/bin/env bash
# Idempotent apt package install + grappa system user provisioning for
# a native Linux (Debian/Ubuntu) grappa host. Run as root.
#
# Package notes:
#   - libimage-exiftool-perl is the Debian/Ubuntu name for exiftool
#     (p5-Image-ExifTool is the FreeBSD one).
#   - ca-certificates is the ENTIRE Linux upstream-TLS-trust story for
#     Grappa.IRC.Client.tls_connect_opts/1 — :public_key.cacerts_get/0
#     reads the OS CA store.
#   - autoconf/m4/libncurses-dev/libssl-dev/unzip/zlib1g-dev are Erlang
#     build deps for install_toolchain.sh's asdf-erlang source build.
#   - sudo is installed FIRST: every other script here runs its steps as
#     the grappa user, and a minimal Debian image does not ship it.

set -euo pipefail

GRAPPA_USER="${GRAPPA_USER:-grappa}"

echo "[install_prereqs] apt-get update"
apt-get update -qq

echo "[install_prereqs] installing sudo first (every other script here depends on it)"
DEBIAN_FRONTEND=noninteractive apt-get install -y sudo

echo "[install_prereqs] installing remaining packages"
DEBIAN_FRONTEND=noninteractive apt-get install -y \
	build-essential \
	git \
	curl \
	libsqlite3-dev \
	libimage-exiftool-perl \
	ffmpeg \
	ca-certificates \
	nginx \
	autoconf \
	m4 \
	libncurses-dev \
	libssl-dev \
	unzip \
	zlib1g-dev

if ! id "${GRAPPA_USER}" >/dev/null 2>&1; then
	echo "[install_prereqs] creating user ${GRAPPA_USER}"
	useradd --system --create-home --home-dir "/home/${GRAPPA_USER}" \
		--shell /usr/sbin/nologin "${GRAPPA_USER}"
else
	echo "[install_prereqs] user ${GRAPPA_USER} already exists"
fi

echo "[install_prereqs] provisioning /etc/grappa"
mkdir -p /etc/grappa
chown "root:${GRAPPA_USER}" /etc/grappa
chmod 0750 /etc/grappa

echo "[install_prereqs] done"
