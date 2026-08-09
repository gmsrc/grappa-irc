#!/usr/bin/env bats
#
# Bats suite for GH #425 — every shipped service definition that boots the
# release MUST pin a UTF-8 locale (`LANG=C.UTF-8`).
#
# Without one the BEAM boots with `native_name_encoding` = latin1 and Elixir
# warns on stderr ("the VM is running with native name encoding of latin1
# which may cause Elixir to malfunction"). That setting governs FILENAME
# handling, and grappa writes user-supplied names to disk (uploads), so a
# latin1 VM is a mis-decode waiting for the first non-ASCII filename.
#
# This is the drift GUARD, not the pin itself. It is deliberately BOTH:
#
#   * dynamic in the SET — it discovers service definitions from the tracked
#     tree (`*.service`, `*/rc.d/*`) filtered to the ones that actually launch
#     `bin/grappa`, so a fourth substrate added tomorrow is held to the pin
#     without anyone remembering to extend this file. The `bin/grappa` filter
#     is what keeps a non-BEAM unit (e.g. the certbot oneshot #665 writes at
#     first boot) out of the set — a locale pin there would be noise.
#
#   * static in the CURRENT set — the first case asserts the three shipped
#     paths verbatim. A discovery that silently returns nothing would make
#     every other case pass vacuously, which is the failure mode this suite
#     would otherwise be blind to. When a substrate is legitimately added,
#     that case fails loudly and the author must look.
#
# Dockerfile.release pins the same spelling twice (`ENV LANG=C.UTF-8`, builder
# and runtime) but is not in the set: a Dockerfile is not a service definition
# and the glob that would catch it also catches the e2e fixtures' images.
#
# Every RED case mutates a PRODUCTION copy of a shipped file — a synthetic
# unit would only prove the guard rejects a shape we do not ship.

load ../bats_helpers

REPO_SRC="$BATS_TEST_DIRNAME/../.."

# Tracked service definitions that boot the release, one relative path per
# line. The SET is read from the real repo (production truth); the pin is
# then checked against whichever root the caller passes.
service_definitions() {
    local rel
    git -C "$REPO_SRC" ls-files -- infra | while IFS= read -r rel; do
        case "$rel" in
            *.service | */rc.d/*) ;;
            *) continue ;;
        esac
        grep -q 'bin/grappa' "$REPO_SRC/$rel" || continue
        printf '%s\n' "$rel"
    done
}

# A commented-out pin is not a pin: strip comment lines before looking.
pins_utf8_locale() {
    grep -v '^[[:space:]]*#' "$1" | grep -q 'LANG=C\.UTF-8'
}

# Relative paths of the definitions that do NOT pin, under $1.
locale_pin_violations() {
    local root="$1" rel
    while IFS= read -r rel; do
        pins_utf8_locale "$root/$rel" || printf '%s\n' "$rel"
    done < <(service_definitions)
}

# Violations under $1 that the pristine sandbox did not already have — the
# DELTA a single mutation caused. Without it, one unpinned shipped file would
# turn every sensitivity case below red at once, and the suite would say
# "four things broke" when one did.
added_violations() {
    local root="$1" rel
    while IFS= read -r rel; do
        printf '%s\n' "$BASELINE_VIOLATIONS" | grep -qxF "$rel" || printf '%s\n' "$rel"
    done < <(locale_pin_violations "$root")
}

# Rewrite a sandbox file through a sed expression — one mutation per RED case.
# The pre-state is asserted first: mutating a pin out of a file that never had
# one is a no-op, and a no-op mutation proves nothing.
mutate_out_the_pin() {
    pins_utf8_locale "$1" || {
        printf 'mutate_out_the_pin: %s has no pin to remove — the mutation would be a no-op\n' "$1" >&2
        return 1
    }
    sed "$2" "$1" > "$1.mutated" && mv "$1.mutated" "$1"
    refute pins_utf8_locale "$1"
}

setup() {
    SANDBOX="$BATS_TEST_TMPDIR/repo"
    local rel
    while IFS= read -r rel; do
        mkdir -p "$SANDBOX/$(dirname "$rel")"
        cp "$REPO_SRC/$rel" "$SANDBOX/$rel"
    done < <(service_definitions)

    BASELINE_VIOLATIONS="$(locale_pin_violations "$SANDBOX")"
}

@test "discovery lists exactly the three shipped service definitions" {
    run service_definitions
    [ "$status" -eq 0 ]
    [ "$output" = "infra/freebsd/rc.d/grappa
infra/linux/systemd/grappa.service
infra/packaging/grappa.service" ]
}

@test "every shipped service definition pins LANG=C.UTF-8" {
    run locale_pin_violations "$REPO_SRC"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "dropping the pin from the linux systemd unit is a violation" {
    mutate_out_the_pin "$SANDBOX/infra/linux/systemd/grappa.service" '/LANG=C\.UTF-8/d'

    run added_violations "$SANDBOX"
    [ "$output" = "infra/linux/systemd/grappa.service" ]
}

@test "dropping the pin from the packaged systemd unit is a violation" {
    mutate_out_the_pin "$SANDBOX/infra/packaging/grappa.service" '/LANG=C\.UTF-8/d'

    run added_violations "$SANDBOX"
    [ "$output" = "infra/packaging/grappa.service" ]
}

@test "dropping the pin from the FreeBSD rc.d service is a violation" {
    mutate_out_the_pin "$SANDBOX/infra/freebsd/rc.d/grappa" '/LANG=C\.UTF-8/d'

    run added_violations "$SANDBOX"
    [ "$output" = "infra/freebsd/rc.d/grappa" ]
}

@test "a non-UTF-8 locale (LANG=C) does not satisfy the pin" {
    mutate_out_the_pin "$SANDBOX/infra/linux/systemd/grappa.service" 's/LANG=C\.UTF-8/LANG=C/'

    run added_violations "$SANDBOX"
    [ "$output" = "infra/linux/systemd/grappa.service" ]
}

@test "a commented-out pin does not satisfy the pin" {
    mutate_out_the_pin "$SANDBOX/infra/packaging/grappa.service" 's/^\(.*LANG=C\.UTF-8.*\)$/#\1/'

    run added_violations "$SANDBOX"
    [ "$output" = "infra/packaging/grappa.service" ]
}
