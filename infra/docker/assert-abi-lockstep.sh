#!/bin/sh
#
# assert-abi-lockstep.sh — build-time ABI gate for the release image
# (Dockerfile.release). Fails the build unless the runtime stage can run the
# self-contained `mix release` the build stage linked: identical musl and
# openssl SONAME majors, and runtime musl/openssl no older than the build's.
# Version ordering defers to `apk version -t`.
# Why: docs/OPERATIONS.md § "The Docker deploy driver (infra/docker/)" (#503).
#
# usage: assert-abi-lockstep.sh \
#          BUILD_MUSL_SONAME BUILD_MUSL_VERSION BUILD_SSL_SONAME BUILD_SSL_VERSION \
#          RUN_MUSL_SONAME   RUN_MUSL_VERSION   RUN_SSL_SONAME   RUN_SSL_VERSION
#
# exit 0 = ABI lockstep holds; 1 = ABI drift (build would ship a mislinked
# image); 2 = usage/extraction failure (never a silent pass).
set -eu

if [ "$#" -ne 8 ]; then
    echo "assert-abi-lockstep: expected 8 args, got $#" >&2
    exit 2
fi

b_musl_so=$1
b_musl_v=$2
b_ssl_so=$3
b_ssl_v=$4
r_musl_so=$5
r_musl_v=$6
r_ssl_so=$7
r_ssl_v=$8

# An empty value means the upstream ls/apk extraction found nothing; a blank
# would compare equal, so fail loud.
for v in \
    "$b_musl_so" "$b_musl_v" "$b_ssl_so" "$b_ssl_v" \
    "$r_musl_so" "$r_musl_v" "$r_ssl_so" "$r_ssl_v"; do
    if [ -z "$v" ]; then
        echo "assert-abi-lockstep: empty ABI value — extraction failed upstream" >&2
        exit 2
    fi
done

fail() {
    echo "ABI DRIFT: $1" >&2
    exit 1
}

# 1 + 2: SONAME major equality (hard break in either direction).
[ "$b_musl_so" = "$r_musl_so" ] ||
    fail "musl SONAME major build=$b_musl_so runtime=$r_musl_so — the bundled ERTS links libc.musl-*.so.$b_musl_so"
[ "$b_ssl_so" = "$r_ssl_so" ] ||
    fail "openssl SONAME major build=$b_ssl_so runtime=$r_ssl_so — the crypto NIF links libcrypto.so.$b_ssl_so"

# 3: runtime musl NOT older than build.
if [ "$(apk version -t "$r_musl_v" "$b_musl_v")" = "<" ]; then
    fail "runtime musl $r_musl_v older than build musl $b_musl_v — musl has no symbol versioning, a newer-linked release can miss symbols on older musl"
fi

# 4: runtime openssl NOT older than build.
if [ "$(apk version -t "$r_ssl_v" "$b_ssl_v")" = "<" ]; then
    fail "runtime openssl $r_ssl_v older than build openssl $b_ssl_v"
fi

echo "abi lockstep OK: musl ${r_musl_v} (so.${r_musl_so}) >= build ${b_musl_v}; openssl ${r_ssl_v} (so.${r_ssl_so}) >= build ${b_ssl_v}"
