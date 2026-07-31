#!/usr/bin/env bats
#
# Bats suite for infra/docker/assert-abi-lockstep.sh — the release-image
# build-time ABI gate (#503 unit C). The runtime alpine MINOR is cosmetic
# (3.23 and 3.24 both ship musl 1.x + openssl 3.x); the real contract the
# bundled `mix release` needs from its runtime base is:
#   1. identical musl    SONAME major (a musl major bump = hard link break)
#   2. identical openssl SONAME major (libcrypto/libssl SONAME bump = break)
#   3. runtime musl    NEVER older than build — musl has NO symbol versioning,
#      so a binary linked on newer musl may call symbols absent from older
#      musl (build-new/run-old breaks; run-new/build-old is safe)
#   4. runtime openssl NEVER older than build
#
# This is why the original minor-cut assertion was wrong on BOTH counts: it
# failed the build on a cosmetic 3.23-vs-3.24 minor diff (the per-arch elixir
# base carries different alpine minors — amd64 3.23, arm64 3.24) yet would
# have passed a genuinely dangerous older-runtime pairing that happened to
# share a minor.
#
# The script is a PURE decision function (8 args in, verdict out) so the gate
# logic is testable off-image on the host. Version ordering defers to the
# canonical `apk version -t` comparator, stubbed here via PATH — the
# production script never hand-rolls a version parse. The stub implements a
# real dotted+revision numeric compare so the tests exercise the script's
# BRANCHING on apk's verdict, not a canned answer.

setup() {
    ASSERT="$BATS_TEST_DIRNAME/../../infra/docker/assert-abi-lockstep.sh"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"

    # Stub `apk version -t A B` → prints < / = / > (a REL b), the only apk
    # subcommand the gate uses. Numeric compare over '.', '-', '_' fields,
    # stripping a leading 'r' from revision components (r23 -> 23).
    cat > "$FAKE_DIR/apk" <<'EOF'
#!/bin/sh
[ "$1" = "version" ] && [ "$2" = "-t" ] || { echo "fake apk: unsupported: $*" >&2; exit 2; }
awk -v a="$3" -v b="$4" 'BEGIN {
    na = split(a, aa, /[.\-_]/); nb = split(b, bb, /[.\-_]/);
    n = (na > nb) ? na : nb;
    for (i = 1; i <= n; i++) {
        x = aa[i]; y = bb[i];
        sub(/^r/, "", x); sub(/^r/, "", y);
        xn = x + 0; yn = y + 0;
        if (xn < yn) { print "<"; exit }
        if (xn > yn) { print ">"; exit }
    }
    print "=";
}'
EOF
    chmod +x "$FAKE_DIR/apk"
    export PATH="$FAKE_DIR:$PATH"
}

# args: b_musl_so b_musl_v b_ssl_so b_ssl_v r_musl_so r_musl_v r_ssl_so r_ssl_v
#
# Baseline: the real cross-arch pairing that must PASS —
#   amd64 build musl 1.2.5-r23 / ssl 3.5.7-r0  ->  runtime 1.2.6-r2 / 3.5.7-r0
#   arm64 build musl 1.2.6-r2  / ssl 3.5.7-r0  ->  runtime 1.2.6-r2 / 3.5.7-r0

@test "identical build and runtime ABI passes" {
    run "$ASSERT" 1 1.2.6-r2 3 3.5.7-r0 1 1.2.6-r2 3 3.5.7-r0
    [ "$status" -eq 0 ]
    [[ "$output" == *"abi lockstep OK"* ]]
}

@test "runtime newer than build passes (safe direction, real amd64 leg)" {
    run "$ASSERT" 1 1.2.5-r23 3 3.5.7-r0 1 1.2.6-r2 3 3.5.7-r0
    [ "$status" -eq 0 ]
    [[ "$output" == *"abi lockstep OK"* ]]
}

@test "runtime musl OLDER than build fails (musl has no symbol versioning)" {
    run "$ASSERT" 1 1.2.6-r2 3 3.5.7-r0 1 1.2.5-r23 3 3.5.7-r0
    [ "$status" -eq 1 ]
    [[ "$output" == *"ABI DRIFT"* ]]
    [[ "$output" == *"musl"* ]]
    [[ "$output" == *"symbol versioning"* ]]
}

@test "runtime openssl OLDER than build fails" {
    run "$ASSERT" 1 1.2.6-r2 3 3.5.8-r0 1 1.2.6-r2 3 3.5.7-r0
    [ "$status" -eq 1 ]
    [[ "$output" == *"ABI DRIFT"* ]]
    [[ "$output" == *"openssl"* ]]
}

@test "musl SONAME major drift fails" {
    run "$ASSERT" 1 1.2.6-r2 3 3.5.7-r0 2 1.2.6-r2 3 3.5.7-r0
    [ "$status" -eq 1 ]
    [[ "$output" == *"ABI DRIFT"* ]]
    [[ "$output" == *"musl SONAME major"* ]]
}

@test "openssl SONAME major drift fails (libcrypto so-major bump)" {
    run "$ASSERT" 1 1.2.6-r2 3 3.5.7-r0 1 1.2.6-r2 4 4.0.0-r0
    [ "$status" -eq 1 ]
    [[ "$output" == *"ABI DRIFT"* ]]
    [[ "$output" == *"openssl SONAME major"* ]]
}

@test "SONAME equality but older runtime still fails (not a rubber stamp)" {
    # Same major SONAMEs (1/3) yet the runtime musl is older — the exact
    # dangerous pairing a minor-cut or SONAME-only check would wave through.
    run "$ASSERT" 1 1.2.6-r5 3 3.5.7-r0 1 1.2.6-r2 3 3.5.7-r0
    [ "$status" -eq 1 ]
    [[ "$output" == *"ABI DRIFT"* ]]
}

@test "wrong argument count is a usage error (exit 2)" {
    run "$ASSERT" 1 1.2.6-r2 3 3.5.7-r0
    [ "$status" -eq 2 ]
}

@test "empty ABI value is an extraction failure (exit 2, not a silent pass)" {
    run "$ASSERT" 1 1.2.6-r2 3 3.5.7-r0 1 "" 3 3.5.7-r0
    [ "$status" -eq 2 ]
}
