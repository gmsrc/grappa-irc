#!/usr/bin/env bats
#
# Bats suite for GH #1592 — the AUR sentinel's safety net was credited, in
# eight places, to a `makepkg` pkgver lint that accepts '@'.
#
# THE CLAIM. `pkgver=@GRAPPA_VERSION@` is committed unfilled; `regen.sh`
# derives the real number before any build. Eight comments/docs/test names
# explained WHY an underived recipe cannot ship: makepkg's pkgver lint
# "REFUSES '@'", so the build dies loudly instead of publishing
# `grappa-@GRAPPA_VERSION@`.
#
# THE MEASUREMENT. That lint's whole rejecting surface is two bracket
# expressions in `check_pkgver` (libmakepkg/lint_pkgbuild/pkgver.sh):
#
#     [[ $ver = *[[:space:]/:-]* ]]   colons, forward slashes, hyphens, whitespace
#     [[ $ver = *[![:ascii:]]* ]]     non-ascii
#
# '@' is ASCII and is in neither class. On `menci/archlinuxarm:base-devel`
# with a minimal recipe, `makepkg -sf --noconfirm` measures rc=0 on
# `pkgver=@GRAPPA_VERSION@` and rc=0 via `--printsrcinfo`, against rc=12 on
# `1.3.0-rc1` — the negative control that proves the lint fires at all. The
# tree already carried the refuting evidence: `aur/pkgver.sh`'s header
# transcribes that same bracket expression, cited to the file, measured under
# #1591. Two files apart, one measured and one asserted, and the asserted one
# was wrong.
#
# WHAT THIS SUITE DOES NOT SETTLE. Which stage DOES stop an underived build
# is not measured and is deliberately left open (#1592). The real recipe has
# a `source=()` that interpolates the sentinel into a tag URL, so a download
# failure is a candidate — a candidate, not a finding. Nothing here asserts a
# mechanism, and neither should any comment in the tree.
#
# Scope: the refuted predicate (host-side, no Arch needed — the lint's class
# is a shell bracket expression and `pkgver.sh` enforces its transcription),
# and a copy-paste guard over the eight sites, so the ninth is not written.

load ../bats_helpers

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
    PKGVER_SH="$REPO_ROOT/infra/packaging/aur/pkgver.sh"
}

# ── The refuted predicate ───────────────────────────────────────────────────

@test "#1592 makepkg's rejecting class ACCEPTS the sentinel, with the hyphen as control" {
    # makepkg's punctuation class, transcribed — the same bracket expression
    # `pkgver.sh` carries. The rejected loop is the known-answer control:
    # without it a mis-typed class would accept everything and this case would
    # pass while proving nothing.
    for accepted in '@GRAPPA_VERSION@' '@SHOTTINO_VERSION@' '1.3.0' '1.3.0rc1'; do
        refute grep -qE '[[:space:]/:-]' <<<"$accepted"
    done

    for rejected in '1.3.0-rc1' '1.3 0' '1:3.0' '1/3.0'; do
        grep -qE '[[:space:]/:-]' <<<"$rejected"
    done

    # makepkg's SECOND class is `*[![:ascii:]]*`, and `[:ascii:]` is a
    # GNU/perl extension POSIX never defined — BSD grep answers "invalid
    # character class" (rc=2), which `refute` reports as proving nothing
    # rather than as a satisfied negation. So the stand-in is the printable
    # ASCII byte range under the C locale. It is STRICTLY TIGHTER than
    # makepkg's, which is the safe direction for the claim being made: a
    # value this accepts is certainly ASCII, so makepkg's ascii test accepts
    # it too.
    for accepted in '@GRAPPA_VERSION@' '@SHOTTINO_VERSION@'; do
        refute env LC_ALL=C grep -q '[^ -~]' <<<"$accepted"
    done
    LC_ALL=C grep -q '[^ -~]' <<<'1.3.0-café'
}

@test "#1592 the sentinel reaches makepkg byte-for-byte — pkgver.sh never inspects it" {
    # Stated precisely, because the near-miss reading is tempting and false:
    # this is NOT the mapper's closing guard clearing '@'. That guard
    # (`*[[:space:]/:-]*`, makepkg's class transcribed a second time) sits on
    # the HYPHEN branch, and a value with no hyphen takes the `*)` arm and
    # `exit 0`s before ever reaching it. So the mapper neither maps nor
    # examines the sentinel — it hands it to makepkg exactly as committed,
    # which is what makes the previous case the whole of the story.
    run "$PKGVER_SH" '@GRAPPA_VERSION@'
    [ "$status" -eq 0 ]
    [ "$output" = '@GRAPPA_VERSION@' ]

    # The branch that DOES reach the guard, for contrast: a hyphen is mapped
    # away rather than passed through, which is the refusal we have measured.
    run "$PKGVER_SH" '1.3.0-rc1'
    [ "$status" -eq 0 ]
    [ "$output" = '1.3.0rc1' ]
}

# ── The copy-paste guard ────────────────────────────────────────────────────

# Emit every place where a refusal is claimed within two lines of the
# sentinel, EXCEPT the ones that name the hyphen — the only refusal this tree
# has measured (#1591, rc=12). Reads whole files, not lines: every one of the
# eight sites wrapped its claim across a line break, so a line-wise grep sees
# half a sentence and misses it.
#
# Honest about its own reach: this is a COPY-PASTE guard, not a semantic one.
# It catches the sentence being pasted into a ninth file — which is how eight
# copies came to exist across #538, #1447 and #1591 — and it does not catch a
# freshly-worded mechanism claim. The recipes' comments carry the reasoning;
# this carries the regression.
sentinel_refusal_claims() {
    perl -0777 -ne '
      while (/(?:[^\n]*\n){0,2}[^\n]*(?:\@GRAPPA_VERSION\@|\@SHOTTINO_VERSION\@|sentinel)[^\n]*\n(?:[^\n]*\n){0,2}/gi) {
        # Take the offset BEFORE anything else matches: the two tests below
        # overwrite @- with their own offsets inside $blk, which reports every
        # hit at line 3-ish of its file.
        my ($blk, $off) = ($&, $-[0]);
        next unless $blk =~ /refus/i;
        next if $blk =~ /hyphen/i;
        my $ln = 1 + (substr($_, 0, $off) =~ tr/\n//);
        print "$ARGV:$ln\n$blk\n";
      }' "$@"
}

@test "#1592 nothing near the sentinel claims a refusal except the measured hyphen" {
    # TWO exclusions, both deliberate.
    #
    # docs/DESIGN_NOTES.md: the chronological log. Its #538 entry legitimately
    # records what was believed then, and the #1592 entry quotes the false
    # claim in order to retract it. Rewriting either would be falsifying the
    # record, not fixing a doc.
    #
    # This file: it quotes the retracted sentence in its header and feeds it
    # verbatim to the positive control below. A detector that may not name
    # what it hunts cannot be tested at all — so it is excluded here and
    # pointed at itself in the case that follows.
    cd "$REPO_ROOT"
    files=()
    while IFS= read -r f; do
        files+=("$f")
    done < <(
        grep -rl 'GRAPPA_VERSION@\|SHOTTINO_VERSION@' \
            --include='*.md' --include='*.exs' --include='*.sh' --include='*.yml' \
            --include='*.bats' --include='PKGBUILD' --include='.SRCINFO' --include='*.ts' \
            . --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=_build \
            --exclude-dir=deps --exclude='DESIGN_NOTES.md' \
            --exclude="$(basename "$BATS_TEST_FILENAME")"
    )
    # Not a formality: an empty list would make the assertion below hold
    # vacuously, which is the failure mode `refute` exists to refuse.
    [ "${#files[@]}" -gt 0 ]

    run sentinel_refusal_claims "${files[@]}"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "#1592 that guard fires on the sentence it was written for" {
    # Without this the case above passes on a broken detector — a bad regex, a
    # perl that is not there, a file list that came back empty. The fixture is
    # the bouncer recipe's own wording as it stood before this issue.
    fixture="$BATS_TEST_TMPDIR/PKGBUILD"
    cat >"$fixture" <<'EOF'
# The `@GRAPPA_VERSION@` sentinel is deliberate: makepkg's pkgver lint
# REFUSES '@', so an underived build fails loudly.
pkgver=@GRAPPA_VERSION@
EOF

    run sentinel_refusal_claims "$fixture"
    [ "$status" -eq 0 ]
    grep -q 'REFUSES' <<<"$output"

    # And it stays quiet on the surviving TRUE claim, which names the hyphen.
    cat >"$fixture" <<'EOF'
# DERIVED != EQUAL: makepkg's lint refuses the hyphen a semver pre-release
# spells its suffix with, so regen.sh maps it before filling the sentinel.
pkgver=@GRAPPA_VERSION@
EOF

    run sentinel_refusal_claims "$fixture"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}
