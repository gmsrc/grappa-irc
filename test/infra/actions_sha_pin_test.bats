#!/usr/bin/env bats
#
# Bats suite for #1404 — supply-chain: every third-party GitHub Action a
# workflow runs MUST be referenced by commit SHA, not by a tag.
#
# A tag is a pointer its owner can move. The jobs in `release.yml` hold
# `contents: write` and `packages: write` — they publish the container image
# and attach the Release assets — so what those jobs execute has to be a fixed
# object, chosen here, not resolved at run time from a name someone else
# controls. `ci.yml` and `integration.yml` are pinned on the same terms rather
# than "the risky ones only": a half-pinned tree gives the next author two
# patterns to copy from, and the wrong one still looks like the house style.
#
# The `# vX.Y.Z` comment is not decoration. It is the human-readable half of
# the pin (a bare SHA says nothing about what you are running) AND the handle
# Dependabot rewrites: the `github-actions` ecosystem is already configured in
# `.github/dependabot.yml`, and it bumps a SHA-pinned `uses:` while keeping the
# comment in step. That is the documented update path — pinning without one
# just trades a moving target for a frozen, unpatched one.
#
# This is the drift GUARD, not the pin itself. It reads the worktree's tracked
# workflows, so it judges the change under test, not `main`. Local composite
# actions (`uses: ./...`) are excluded: they live in this repository and move
# only when this repository moves.
#
# Refresh a pin by hand when Dependabot is not the one doing it:
#   gh api repos/<owner>/<repo>/commits/<tag> --jq .sha

REPO_ROOT="$BATS_TEST_DIRNAME/../.."

# Every third-party `uses:` in the tracked workflows. `git grep -n` →
# `path:line:content`. Local `./` actions are not third-party; a commented-out
# `# uses:` line is prose.
action_refs() {
    git -C "$REPO_ROOT" grep -nE '^[[:space:]]*(- )?uses:' -- '.github/workflows/*.yml' 2>/dev/null \
        | while IFS= read -r line; do
            content="${line#*:*:}"                        # strip `path:line:`
            trimmed="$(printf '%s' "$content" | sed 's/^[[:space:]]*//')"
            case "$trimmed" in
                \#*) continue ;;                          # comment line — prose
                *uses:\ ./*) continue ;;                  # local composite action
            esac
            printf '%s\n' "$line"
        done
}

@test "every third-party action is pinned to a commit SHA (#1404)" {
    refs="$(action_refs)"

    # Guard against a vacuous pass: with the grep or the filter wrong, the
    # assertion below would trivially hold over an empty set. The three
    # workflows carry well over thirty `uses:` between them.
    count="$(printf '%s\n' "$refs" | grep -c . || true)"
    [ "$count" -ge 30 ] || {
        echo "expected >=30 third-party action references, found $count — grep/filter is wrong:" >&2
        printf '%s\n' "$refs" >&2
        return 1
    }

    violations="$(printf '%s\n' "$refs" | grep -vE '@[0-9a-f]{40}( |$)' || true)"
    [ -z "$violations" ] || {
        echo "TAG-pinned action reference(s) — pin to a commit SHA (#1404):" >&2
        printf '%s\n' "$violations" >&2
        echo "    gh api repos/<owner>/<repo>/commits/<tag> --jq .sha" >&2
        return 1
    }
}

@test "every pinned action carries its human-readable version comment (#1404)" {
    # Without it the reference is unreadable to a human AND unbumpable by
    # Dependabot, which keys its rewrite on the comment it wrote last time.
    #
    # Scoped to the refs that ARE sha-pinned, so a tag left behind fails the
    # test above and this one only. One defect, one red line.
    missing="$(action_refs | grep -E '@[0-9a-f]{40}' | grep -vE '@[0-9a-f]{40} # v[0-9]' || true)"
    [ -z "$missing" ] || {
        echo "pinned action(s) with no '# vX.Y.Z' version comment (#1404):" >&2
        printf '%s\n' "$missing" >&2
        return 1
    }
}

# `owner/repo@sha # version`, one per line, for every reference above.
pinned_tokens() {
    action_refs | grep -oE '[A-Za-z0-9._/-]+@[0-9a-f]{40} # v[0-9][^ ]*'
}

@test "all references to one action carry the SAME sha and version (#1404)" {
    # `actions/checkout` is transcribed eleven times across the three
    # workflows. Bumping some of them is the failure this catches: the jobs
    # that were missed keep running the old object silently, and the tree
    # reads as pinned either way.
    tokens="$(pinned_tokens)"
    actions="$(printf '%s\n' "$tokens" | sed 's/@.*//' | sort -u)"

    multi_ref_actions=0
    conflicts=""

    for action in $actions; do
        refs="$(printf '%s\n' "$tokens" | grep -cF -- "$action@")"
        pins="$(printf '%s\n' "$tokens" | grep -F -- "$action@" | sed "s|^$action@||" | sort -u)"

        [ "$refs" -ge 2 ] && multi_ref_actions=$((multi_ref_actions + 1))

        if [ "$(printf '%s\n' "$pins" | grep -c .)" -gt 1 ]; then
            # Name the FILES, not just the action: the references are
            # textually identical, so "these two pins disagree" would leave
            # the reader to grep eleven call sites for the one that moved.
            conflicts="${conflicts}${action}: $(printf '%s' "$pins" | tr '\n' ' ')
$(action_refs | grep -F -- "$action@" | sed 's/^/    /')
"
        fi
    done

    # Same anti-vacuous reasoning as the count check: with every action down
    # to a single reference this test asserts nothing.
    [ "$multi_ref_actions" -ge 1 ] || {
        echo "no action is referenced twice — the equality assertion is vacuous:" >&2
        printf '%s\n' "$tokens" >&2
        return 1
    }

    [ -z "$conflicts" ] || {
        echo "DIVERGENT pins for the same action — bump every call site together (#1404):" >&2
        printf '%s' "$conflicts" >&2
        return 1
    }
}
