#!/usr/bin/env bats
#
# infra/packaging/credits.sh — the build's git credits payload (#1773).
#
# The credits modal needs three facts the browser cannot have: the commit sha,
# its date, and the contributor list with per-author commit counts. They are
# git facts, and the cic build runs in containers that mount ONLY ./cicchetto
# (cicchetto/vite.config.ts:30-39), so the repo root is out of reach there.
# The payload is therefore derived OUTSIDE the container by the same wrappers
# that already derive GRAPPA_VERSION, and handed in on an env var.
#
# What these cases pin, and why each one exists:
#
#   1. the PAYLOAD is exact — a wrong count or a dropped author is a lie the
#      modal would render as fact, so the assertion is a byte-for-byte compare
#      against a sandbox repo whose history this file wrote;
#   2. merges are EXCLUDED — `--no-merges`, so a merge-heavy branch does not
#      credit the merger for other people's work;
#   3. a name carrying `"` or `\` stays PARSEABLE — the payload is JSON that
#      vite parses at build time, and one unescaped quote turns the whole roll
#      into a build failure (or, worse, a truncated roll);
#   4. NO GIT is not an error — the AUR recipe builds from a release tarball
#      and Dockerfile.release .dockerignore's `.git`, so on the two RELEASE
#      substrates there is no repo to read. The script must exit 0 with an
#      honestly empty payload there, exactly as `Grappa.Version` reports the
#      bare base on its no-git path. Failing loud here would break precisely
#      the two builds that ship;
#   5. ONE LINE of output — every wrapper captures it with `$(...)` into an
#      env var, and a multi-line payload would arrive mangled.
#
# The sandbox repos are built here rather than measured against this checkout:
# the real history changes every commit, so a case reading it could only
# assert a shape, and a shape assertion cannot tell a correct roll from an
# empty one.

load ../bats_helpers

setup() {
    SCRIPT="$BATS_TEST_DIRNAME/../../infra/packaging/credits.sh"

    REPO="$BATS_TEST_TMPDIR/repo"
    # `credits.sh` derives the repo root as SCRIPT_DIR/../.. (the layout
    # version.sh already expects), so the sandbox gets its own copy at the
    # same relative depth and reads the sandbox, not this checkout.
    mkdir -p "$REPO/infra/packaging"
    cp "$SCRIPT" "$REPO/infra/packaging/credits.sh"
    chmod +x "$REPO/infra/packaging/credits.sh"
    SANDBOX_SCRIPT="$REPO/infra/packaging/credits.sh"

    seq=0
}

# Commit as a named author, touching a file nobody else touches — the merge
# case needs two branches that can actually merge without a conflict.
commit_as() {
    local name="$1" email="$2" message="$3"
    seq=$((seq + 1))
    printf '%s\n' "$message" > "$REPO/file-$seq.txt"
    git -C "$REPO" add "file-$seq.txt"
    GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" \
        GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" \
        git -C "$REPO" commit -q -m "$message"
}

init_repo() {
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name "sandbox"
    git -C "$REPO" config user.email "sandbox@example.invalid"
    # No mailmap: `git shortlog` therefore groups by the author name verbatim
    # and the expected counts below are the literal ones.
}

@test "the payload names every contributor with the count of their non-merge commits" {
    init_repo
    commit_as "Ada Lovelace" "ada@example.invalid" "one"
    commit_as "Ada Lovelace" "ada@example.invalid" "two"
    commit_as "Ada Lovelace" "ada@example.invalid" "three"
    commit_as "Grace Hopper" "grace@example.invalid" "four"

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    # Descending by count, which is what `shortlog -sn` orders by and what a
    # credit roll wants — the exact string, so a re-ordering fails too.
    [[ "$output" == *'"contributors":[{"name":"Ada Lovelace","commits":3},{"name":"Grace Hopper","commits":1}]'* ]]
}

@test "the sha and the date are the ones HEAD actually carries" {
    init_repo
    commit_as "Ada Lovelace" "ada@example.invalid" "one"

    local sha date
    sha="$(git -C "$REPO" rev-parse --short HEAD)"
    date="$(git -C "$REPO" log -1 --format=%cI)"

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    [[ "$output" == "{\"sha\":\"$sha\",\"date\":\"$date\","* ]]
}

@test "a merge commit credits nobody — the roll counts authored work" {
    init_repo
    commit_as "Ada Lovelace" "ada@example.invalid" "base"
    git -C "$REPO" checkout -q -b side
    commit_as "Grace Hopper" "grace@example.invalid" "side work"
    git -C "$REPO" checkout -q main
    commit_as "Ada Lovelace" "ada@example.invalid" "main work"
    # --no-ff forces a merge COMMIT, which is the thing under test; the merger
    # is a third name, so a leak shows up as that name appearing at all.
    GIT_AUTHOR_NAME="Mergebot" GIT_AUTHOR_EMAIL="bot@example.invalid" \
        GIT_COMMITTER_NAME="Mergebot" GIT_COMMITTER_EMAIL="bot@example.invalid" \
        git -C "$REPO" merge -q --no-ff -m "merge side" side

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    refute grep -q 'Mergebot' <<< "$output"
    [[ "$output" == *'{"name":"Ada Lovelace","commits":2}'* ]]
    [[ "$output" == *'{"name":"Grace Hopper","commits":1}'* ]]
}

@test "a name carrying a quote or a backslash is escaped, not emitted raw" {
    init_repo
    # Both JSON metacharacters in one name: raw, the quote closes the string
    # early and the rest of the payload becomes syntax. vite PARSES this
    # payload at build time, so an unescaped name is a broken build — or, if
    # it happens to stay parseable, a truncated roll.
    #
    # The name must not END on a metacharacter: git's own ident parser strips
    # trailing "crud" (`"`, `'`, `.`, `,`, `:`, `;`, `<`, `>`) when it reads an
    # author line back, so `… "Quoted"` reaches shortlog as `… "Quoted` and the
    # case would then be measuring git's stripping instead of this escaper.
    commit_as 'A "B" C\D' "odd@example.invalid" "one"

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    # Single-quoted pattern: bash takes every character literally, so this is
    # the payload's exact bytes — two escaped quotes, one escaped backslash.
    [[ "$output" == *'{"name":"A \"B\" C\\D","commits":1}'* ]]
}

@test "no git is an honest empty payload, not a failure (AUR tarball, Dockerfile.release)" {
    # No `git init` at all: the shape both RELEASE substrates present.
    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    [ "$output" = '{"sha":null,"date":null,"contributors":[]}' ]
}

@test "the payload is a single line, so a wrapper can carry it in one env var" {
    init_repo
    commit_as "Ada Lovelace" "ada@example.invalid" "one"
    commit_as "Grace Hopper" "grace@example.invalid" "two"

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    [ "${#lines[@]}" -eq 1 ]
}
