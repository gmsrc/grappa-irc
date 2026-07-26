#!/usr/bin/env bash
# gen-secrets.sh — fill the packaged env file's REPLACE_ME secrets using
# openssl ONLY. A packaged host (.deb/.rpm) has no mix / release
# toolchain, so the from-source secret bootstrap (infra/linux/install.sh,
# which shells out to `mix phx.gen.secret` etc.) cannot run. Every secret
# grappa needs is either raw random bytes or an EC-P256 keypair — both
# openssl can produce with no BEAM involved. That keeps first-boot secret
# generation OFF the release `eval` path, which is exactly the path #419
# still has to prove works on the packaged ERTS (see infra/linux/install.sh
# for the native-Linux `bin/grappa eval` boot crash this sidesteps).
#
# Installed to /usr/share/grappa/gen-secrets.sh; invoked by postinstall on
# first install, and re-runnable by an operator via `sudo grappa gen-secrets`.
#
# IDEMPOTENT: only fills keys that are missing, blank, or literal
# REPLACE_ME. Existing real values are never touched (rotate by resetting
# the key to REPLACE_ME first). Mirrors install.sh's set_env_if_blank /
# force_set_env discipline, including the re-lock-after-rewrite: a
# tmp+mv rewrite is born under root's umask (0644 root:root), which would
# drop the 0640 root:grappa lock and leak every secret — so re-lock after
# each write.

set -euo pipefail

ENV_FILE="${GRAPPA_ENV_FILE:-/etc/grappa/grappa.env}"
GRAPPA_USER="${GRAPPA_USER:-grappa}"

die() { printf 'gen-secrets: %s\n' "$*" >&2; exit 1; }

command -v openssl >/dev/null 2>&1 || die "openssl not found on PATH"
[ -f "$ENV_FILE" ] || die "env file $ENV_FILE does not exist"

# Re-lock to 0640 root:<grappa>. group-read lets the daemon read it; not
# world-readable. Tolerant if the group does not exist yet (chown falls
# back to root:root — postinstall runs preinstall's user creation first,
# so in the package flow the group always exists).
relock() {
	chown "root:${GRAPPA_USER}" "$ENV_FILE" 2>/dev/null || chown root:root "$ENV_FILE"
	chmod 0640 "$ENV_FILE"
}

# True when KEY is absent, empty, or the literal REPLACE_ME sentinel.
needs_gen() {
	local key="$1"
	! grep -qE "^${key}=.+$" "$ENV_FILE" || grep -qE "^${key}=REPLACE_ME$" "$ENV_FILE"
}

# Replace (or append) KEY=VALUE, then re-lock. VALUE is written verbatim
# (systemd env-file syntax: no quoting).
set_env() {
	local key="$1" val="$2" tmp
	tmp="$(mktemp)"
	grep -vE "^${key}=" "$ENV_FILE" >"$tmp" || true
	printf '%s=%s\n' "$key" "$val" >>"$tmp"
	cat "$tmp" >"$ENV_FILE"
	rm -f "$tmp"
	relock
}

# Raw-random secrets — no BEAM needed, matches the mix generators' shapes:
#   SECRET_KEY_BASE     ~64 chars base64 (phx.gen.secret is 64 random bytes)
#   SECRET_SIGNING_SALT ~32 chars base64 (phx.gen.secret 32)
#   RELEASE_COOKIE      64 hex chars (openssl rand -hex 32, per env.example)
#   GRAPPA_ENCRYPTION_KEY = Base.encode64(:crypto.strong_rand_bytes(32))
#                           ≡ openssl rand -base64 32 (44 chars, Cloak
#                           Base.decode64!'s exactly this)
rand_b64() { openssl rand -base64 "$1" | tr -d '\n'; }
rand_hex() { openssl rand -hex "$1" | tr -d '\n'; }

# VAPID ECDSA P-256 keypair (RFC 8292), byte-for-byte the shape
# Mix.Tasks.Grappa.GenVapid emits: public = base64url(uncompressed point
# 0x04||X||Y, 65 bytes), private = base64url(32-byte big-endian scalar),
# both unpadded. openssl produces an EQUIVALENT keypair in that exact
# encoding, so web_push_elixir (which reads the same raw shapes) accepts
# it without a BEAM in the loop.
gen_vapid() {
	local pem pub hex
	pem="$(mktemp)"
	# shellcheck disable=SC2064  # expand pem now — it is a fixed temp path
	trap "rm -f '$pem'" RETURN
	openssl ecparam -name prime256v1 -genkey -noout -out "$pem" 2>/dev/null

	# Public: the uncompressed EC point is ALWAYS the last 65 bytes of the
	# P-256 SubjectPublicKeyInfo DER (91 bytes). Piped straight to base64
	# so the raw bytes never pass through command substitution.
	pub="$(openssl pkey -in "$pem" -pubout -outform DER 2>/dev/null | tail -c 65 | base64 | tr '+/' '-_' | tr -d '=\n')"

	# Private: the scalar hex from the -text dump. tr -cd keeps only hex
	# from the priv: block (colon-agnostic, so the last byte is not
	# dropped), then left-pad to 32 bytes (64 hex) — a scalar with a
	# leading zero byte would otherwise be short, and RFC 7518 requires
	# the fixed 32-byte length.
	hex="$(openssl pkey -in "$pem" -text -noout 2>/dev/null \
		| sed -n '/priv:/,/pub:/p' | grep -vE 'priv:|pub:' | tr -cd '0-9a-f')"
	hex="$(printf '%064s' "$hex" | tr ' ' '0')"
	[ "${#hex}" -eq 64 ] || die "VAPID private scalar is ${#hex} hex chars, expected 64 — openssl output shape unexpected, refusing to write a malformed key"

	# hex -> raw bytes -> base64url, ALL in-pipe: a leading 0x00 byte in
	# the scalar survives (command substitution would strip NULs).
	local priv
	priv="$(printf '%b' "$(printf '%s' "$hex" | sed 's/../\\x&/g')" | base64 | tr '+/' '-_' | tr -d '=\n')"

	printf '%s\n%s\n' "$pub" "$priv"
}

changed=0

if needs_gen SECRET_KEY_BASE; then set_env SECRET_KEY_BASE "$(rand_b64 48)"; changed=1; fi
if needs_gen SECRET_SIGNING_SALT; then set_env SECRET_SIGNING_SALT "$(rand_b64 32)"; changed=1; fi
if needs_gen RELEASE_COOKIE; then set_env RELEASE_COOKIE "$(rand_hex 32)"; changed=1; fi
if needs_gen GRAPPA_ENCRYPTION_KEY; then set_env GRAPPA_ENCRYPTION_KEY "$(rand_b64 32)"; changed=1; fi

# VAPID is a matched pair: if EITHER half needs generating, regenerate
# BOTH (a public/private mismatch is unusable, worse than either blank).
if needs_gen VAPID_PUBLIC_KEY || needs_gen VAPID_PRIVATE_KEY; then
	pair="$(gen_vapid)"
	vpub="$(printf '%s' "$pair" | sed -n '1p')"
	vpriv="$(printf '%s' "$pair" | sed -n '2p')"
	[ -n "$vpub" ] && [ -n "$vpriv" ] || die "VAPID generation produced an empty key"
	set_env VAPID_PUBLIC_KEY "$vpub"
	set_env VAPID_PRIVATE_KEY "$vpriv"
	changed=1
fi

if [ "$changed" -eq 1 ]; then
	printf 'gen-secrets: secrets written to %s (0640 root:%s)\n' "$ENV_FILE" "$GRAPPA_USER"
else
	printf 'gen-secrets: all secrets already set in %s — nothing to do\n' "$ENV_FILE"
fi
