#!/usr/bin/env bats
#
# Bats suite for infra/freebsd/bin/grappa-source-alias — the sudoers-scoped
# ifconfig wrapper (#543 INC-5). `ifconfig` is stubbed via PATH so no real
# alias is touched; the test asserts the load-bearing security properties:
#
#   * the interface (lo0) + mask (/128) are hard-coded — argv never lets the
#     caller pick them;
#   * an address OUTSIDE the configured prefix is REFUSED without ever running
#     ifconfig (the privilege-scope invariant — a bare `sudo ifconfig` hole is
#     exactly what this wrapper exists to close);
#   * `check` is a no-op probe (used by the adapter's arm_check);
#   * unknown subcommands / bad argc are usage errors.

setup() {
	WRAP="$BATS_TEST_DIRNAME/../../infra/freebsd/bin/grappa-source-alias"

	FAKE_DIR="$BATS_TEST_TMPDIR/fake"
	mkdir -p "$FAKE_DIR"
	IFCONFIG_LOG="$BATS_TEST_TMPDIR/ifconfig.log"
	: >"$IFCONFIG_LOG"
	export IFCONFIG_LOG

	cat >"$FAKE_DIR/ifconfig" <<'EOF'
#!/bin/sh
printf 'ifconfig %s\n' "$*" >> "$IFCONFIG_LOG"
exit 0
EOF
	chmod +x "$FAKE_DIR/ifconfig"
	export PATH="$FAKE_DIR:$PATH"
}

@test "check is a no-op probe returning 0 without touching ifconfig" {
	run "$WRAP" check
	[ "$status" -eq 0 ]
	[ ! -s "$IFCONFIG_LOG" ]
}

@test "add runs ifconfig lo0 inet6 <addr>/128 alias for an in-prefix address" {
	run "$WRAP" add 2a03:4000:20:2d3:cb::1
	[ "$status" -eq 0 ]
	grep -q "ifconfig lo0 inet6 2a03:4000:20:2d3:cb::1/128 alias" "$IFCONFIG_LOG"
}

@test "del runs ifconfig lo0 inet6 <addr>/128 -alias" {
	run "$WRAP" del 2a03:4000:20:2d3:cb::dead
	[ "$status" -eq 0 ]
	grep -q "ifconfig lo0 inet6 2a03:4000:20:2d3:cb::dead/128 -alias" "$IFCONFIG_LOG"
}

@test "add REFUSES an address outside the prefix without running ifconfig" {
	run "$WRAP" add 2a03:4000:20:2d3:ffff::1
	[ "$status" -eq 65 ]
	[ ! -s "$IFCONFIG_LOG" ]
	[[ "$output" == *"not inside"* ]]
}

@test "add REFUSES a non-IPv6 / unparseable address" {
	run "$WRAP" add not-an-address
	[ "$status" -eq 65 ]
	[ ! -s "$IFCONFIG_LOG" ]
}

@test "add REFUSES an IPv4 address (v6-only block)" {
	run "$WRAP" add 192.0.2.1
	[ "$status" -eq 65 ]
	[ ! -s "$IFCONFIG_LOG" ]
}

@test "a custom GRAPPA_SOURCE_ALIAS_PREFIX changes the accepted range" {
	GRAPPA_SOURCE_ALIAS_PREFIX="2001:db8:abcd::/48" run "$WRAP" add 2001:db8:abcd:1::9
	[ "$status" -eq 0 ]
	grep -q "ifconfig lo0 inet6 2001:db8:abcd:1::9/128 alias" "$IFCONFIG_LOG"
}

@test "unknown subcommand is a usage error (64)" {
	run "$WRAP" frobnicate 2a03:4000:20:2d3:cb::1
	[ "$status" -eq 64 ]
	[ ! -s "$IFCONFIG_LOG" ]
}

@test "add with no address is a usage error (64)" {
	run "$WRAP" add
	[ "$status" -eq 64 ]
	[ ! -s "$IFCONFIG_LOG" ]
}

@test "no subcommand is a usage error (64)" {
	run "$WRAP"
	[ "$status" -eq 64 ]
}
