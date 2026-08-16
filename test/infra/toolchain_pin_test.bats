#!/usr/bin/env bats
#
# Bats suite for GH #1408 D-S10 — `.tool-versions` is the toolchain pin,
# and every other carrier must derive from it or agree with it.
#
# `docs/OPERATIONS.md` § "The toolchain pin is the repo's pin, never the
# distro's" argues that a drifted OTP "silently diverges from what CI
# (`erlef/setup-beam`, reading the same file) and the FreeBSD jail
# actually run", and concludes there is "no second hand-maintained pin to
# drift". At the time that was written CI did not read the file: both
# workflows carried their own `ELIXIR_VERSION` / `OTP_VERSION` literals,
# and the Dockerfiles carry a third spelling. Four carriers, three of
# them hand-maintained, and the sentence saying otherwise is the one a
# future editor trusts.
#
# The workflows now pass `version-file: .tool-versions`, which makes the
# sentence true; these checks are what keep it true. `version-type:
# strict` is REQUIRED, not decorative — setup-beam throws
# "you have to set version-type=strict if you're using version-file"
# before it reads anything (src/setup-beam.js, main()).
#
# The Dockerfile stays a separate carrier: it needs a published image
# tag, and `elixir:1.19.5-otp-28-alpine` is a different pin from an asdf
# version string. What is checked is AGREEMENT, and only as far as the
# tag goes — `elixir:1.19-otp-28-alpine` pins the minor line and the OTP
# major, so the Elixir PATCH floats there while `.tool-versions` names
# 1.19.5 exactly. That gap is real and deliberate; a MINOR or OTP-major
# divergence is not, and is what fails here.

load ../bats_helpers

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
    TOOL_VERSIONS="$REPO_ROOT/.tool-versions"

    # asdf format: `<app> <version>`, one per line.
    ELIXIR_PIN="$(awk '$1 == "elixir" { print $2 }' "$TOOL_VERSIONS")"
    ERLANG_PIN="$(awk '$1 == "erlang" { print $2 }' "$TOOL_VERSIONS")"
}

workflow_files() {
    local f
    WORKFLOWS=()
    while IFS= read -r f; do WORKFLOWS+=("$f"); done \
        < <(find "$REPO_ROOT/.github/workflows" -name '*.yml' -type f | sort)
}

@test ".tool-versions names both toolchain pins (#1408)" {
    # Every other check derives from these two strings; an empty one would
    # make all of them hold vacuously.
    [[ "$ELIXIR_PIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+-otp-[0-9]+$ ]] || {
        printf 'unexpected elixir pin in .tool-versions: %s\n' "$ELIXIR_PIN" >&2
        return 1
    }
    [[ "$ERLANG_PIN" =~ ^[0-9]+\.[0-9]+ ]] || {
        printf 'unexpected erlang pin in .tool-versions: %s\n' "$ERLANG_PIN" >&2
        return 1
    }
}

@test "every setup-beam step installs from .tool-versions (#1408)" {
    workflow_files

    local sites=0 f n block
    for f in "${WORKFLOWS[@]}"; do
        while IFS= read -r n; do
            sites=$((sites + 1))
            # The step's `with:` block: setup-beam takes at most a handful
            # of inputs, and every site here is followed by its own block.
            block="$(sed -n "$((n + 1)),$((n + 8))p" "$f")"

            printf '%s' "$block" | grep -q 'version-file: .tool-versions' || {
                printf '%s:%s — setup-beam does not read .tool-versions:\n%s\n' \
                    "$f" "$n" "$block" >&2
                return 1
            }

            # Without this setup-beam refuses to start; a version-file with
            # no strict flag is a red run, not a loose one.
            printf '%s' "$block" | grep -q 'version-type: strict' || {
                printf '%s:%s — version-file without `version-type: strict`:\n%s\n' \
                    "$f" "$n" "$block" >&2
                return 1
            }
        done < <(grep -n 'uses: erlef/setup-beam' "$f" | cut -d: -f1)
    done

    [ "$sites" -ge 3 ] || {
        printf 'found only %s setup-beam step(s) — the scan is broken\n' "$sites" >&2
        return 1
    }
}

@test "no workflow re-transcribes a .tool-versions pin (#1408)" {
    # Derived from the pins themselves, so this catches a re-transcription
    # anywhere in a workflow — an `env:` block, an inline input, a matrix
    # entry — not just the two spellings that existed when it was written.
    # Comments are stripped first: prose may legitimately name a version.
    workflow_files

    # Three spellings, because a workflow transcribes the version WITHOUT
    # the `-otp-N` suffix that asdf needs — which is exactly the literal
    # this gate exists to remove.
    local offenders="" f hits pin
    for f in "${WORKFLOWS[@]}"; do
        for pin in "$ELIXIR_PIN" "${ELIXIR_PIN%-otp-*}" "$ERLANG_PIN"; do
            hits="$(sed 's/#.*$//' "$f" | grep -nF -- "$pin" || true)"
            [ -n "$hits" ] && offenders="${offenders}${f}: ${pin}
$(printf '%s\n' "$hits" | sed 's/^/    /')
"
        done
    done

    [ -z "$offenders" ] || {
        printf 'a workflow hardcodes a version that .tool-versions already pins:\n%s' \
            "$offenders" >&2
        printf 'Use `version-file: .tool-versions` (and setup-beam outputs for cache keys).\n' >&2
        return 1
    }
}

@test "the elixir base image tag agrees with .tool-versions (#1408)" {
    # `elixir:<v>-otp-<n>-alpine` — the tag pins the minor line and the OTP
    # major. Assert exactly that much: the tag's version must be a
    # dot-boundary PREFIX of the .tool-versions elixir version, and the OTP
    # major must match. A patch bump in .tool-versions is allowed to leave
    # the tag alone; a minor or OTP-major bump is not.
    local want_version="${ELIXIR_PIN%-otp-*}"
    local want_otp="${ELIXIR_PIN##*-otp-}"

    # git grep prefixes a line number even with -h when `grep.lineNumber` is
    # set, which it is in this repo — so the git grep anchors the match to
    # the start of the LINE, and the extracting grep must not re-anchor
    # against the prefixed OUTPUT. Same trap the sibling digest-pin suite
    # documents for `git grep -o`.
    local tags
    tags="$(git -C "$REPO_ROOT" grep -hE '^FROM elixir:' -- '*Dockerfile*' \
            | grep -oE 'FROM elixir:[A-Za-z0-9._-]+' \
            | sed 's/^FROM elixir://' | sort -u)"

    local count
    count="$(printf '%s\n' "$tags" | grep -c . || true)"
    [ "$count" -ge 1 ] || {
        printf 'no `FROM elixir:` line found — the scan is broken\n' >&2
        return 1
    }

    local tag tag_version tag_otp
    while IFS= read -r tag; do
        [ -n "$tag" ] || continue
        tag_version="${tag%%-otp-*}"
        tag_otp="${tag#*-otp-}"
        tag_otp="${tag_otp%%-*}"

        [ "$tag_otp" = "$want_otp" ] || {
            printf 'elixir:%s pins OTP %s, .tool-versions says %s\n' \
                "$tag" "$tag_otp" "$want_otp" >&2
            return 1
        }

        case "$want_version." in
            "$tag_version".*) ;;
            *)
                printf 'elixir:%s is not on the .tool-versions line (%s)\n' \
                    "$tag" "$ELIXIR_PIN" >&2
                return 1
                ;;
        esac
    done <<<"$tags"
}
