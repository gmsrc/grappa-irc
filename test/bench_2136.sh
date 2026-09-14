#!/usr/bin/env bash
#
# The measurement behind issue 2136 — what `cicchetto/src/themes/default.css`
# is actually made of, and how little of it the proposed token-model split
# would move.
#
# Committed, deliberately, for the same reason as `test/bench_1626.exs`: the
# DESIGN_NOTES entry for issue 2136 defers a refactor on the strength of these
# numbers, and a deferral of that weight should rest on evidence somebody else
# can re-run rather than on a table pasted into a PR. A number in the decision
# log whose provenance lives only in a worker's /tmp is exactly the class that
# already cost this project a DELETED census (DESIGN_NOTES 2026-09-08): nobody
# could say which node produced it, so it kept being re-cited as measured.
#
# It is NOT a test. `mix test` cannot see it, `scripts/bats.sh` runs only
# test/bin, test/infra and test/scripts, and nothing globs `test/*.sh`. There is
# no durable invariant here to guard — pinning "8,617 lines of component rules"
# would go red on every legitimate CSS edit, which is why this is a one-time
# quantitative record and not an assertion.
#
# THE CONTROLS COME FIRST, AND THEY GATE THE NUMBERS
#
# The fixtures below run the SAME awk program that measures the real sheet, so
# what they validate is the thing that produces the output rather than a
# lookalike. If any fixture disagrees with its known answer the script prints NO
# MEASUREMENT AT ALL and exits non-zero — a tool that cannot demonstrate it is
# reading correctly must not emit a number that will be quoted later.
#
# The four partition fixtures cover the ways this scan can silently be wrong:
# a known-answer file, braces INSIDE a comment (they must not move the depth),
# an unclosed block (must be REFUSED, not silently mis-bucketed), and a `:root`
# nested in an `@media` (the inner selector must not steal the outer class).
# The token fixture covers the two things that inflate a naive census: the
# sheet's own "Variables:" prose, and BEM selectors like `.adm-btn--danger:hover`
# where the `--` is mid-token.
#
# Run (from the worktree root):
#
#     bash test/bench_2136.sh
#
# Optional argument: a different stylesheet to measure.

set -euo pipefail

SHEET="${1:-cicchetto/src/themes/default.css}"

# ── the program ─────────────────────────────────────────────────────────────
#
# One pass, one comment scanner, two reports. Each line is rebuilt with its
# comment spans blanked to spaces; brace depth, prelude detection and the token
# match all read that rebuilt line, so prose can neither open a block nor
# declare a variable.
#
# Buckets partition the file: a line is interstitial when it sits at depth 0
# before any prelude text (a section comment, a blank), otherwise it belongs to
# the top-level block it is part of.

read -r -d '' PROGRAM <<'AWK' || true
BEGIN { split("tokens fontface keyframes media supports rules", ORDER, " ")
        split("core adm adm-space nick-color mode safe-area font effects", GORDER, " ") }

{
  n = length($0); out = ""
  for (i = 1; i <= n; i++) {
    ch = substr($0, i, 1); two = substr($0, i, 2)
    if (in_comment) { if (two == "*/") { in_comment = 0; i++ } out = out " "; continue }
    if (two == "/*") { in_comment = 1; i++; out = out "  "; continue }
    out = out ch
  }

  if (match(out, /^[[:space:]]*--[a-zA-Z0-9_-]+[[:space:]]*:/)) {
    name = substr(out, RSTART, RLENGTH)
    sub(/^[[:space:]]*--/, "", name); sub(/[[:space:]]*:$/, "", name)
    defs++; distinct[name] = 1; grp[tokengroup(name)]++
  }

  start_depth = depth; code = 0
  n = length(out)
  for (i = 1; i <= n; i++) {
    ch = substr(out, i, 1)
    if (ch != " " && ch != "\t") code = 1
    if (ch == "{") depth++
    else if (ch == "}") depth--
  }

  total++
  if (start_depth == 0 && !prelude && !code) { interstitial++; next }

  buffered++
  if (!prelude && code) { prelude = 1; head = out }
  if (depth == 0 && prelude) {
    bucket[classify(head)] += buffered; buffered = 0; prelude = 0; head = ""
  }
}

function classify(p) {
  if (p ~ /^[[:space:]]*@font-face/) return "fontface"
  if (p ~ /^[[:space:]]*@keyframes/) return "keyframes"
  if (p ~ /^[[:space:]]*@media/)     return "media"
  if (p ~ /^[[:space:]]*@supports/)  return "supports"
  if (p ~ /:root/ || p ~ /\[data-theme/) return "tokens"
  return "rules"
}

function tokengroup(name) {
  if (name ~ /^adm-space-/)   return "adm-space"
  if (name ~ /^adm-/)         return "adm"
  if (name ~ /^nick-color-/)  return "nick-color"
  if (name ~ /^mode-/)        return "mode"
  if (name ~ /^safe-area-/)   return "safe-area"
  if (name ~ /^crt-|^credits-/) return "effects"
  if (name ~ /^font/ || name == "line-height") return "font"
  return "core"
}

END {
  if (buffered > 0 || depth != 0 || in_comment) {
    printf("REFUSED: unparsable sheet (depth=%d in_comment=%d unflushed=%d)\n",
           depth, in_comment, buffered) > "/dev/stderr"
    exit 3
  }
  sum = interstitial
  for (k = 1; k <= 6; k++) sum += bucket[ORDER[k]]
  if (sum != total) {
    printf("REFUSED: buckets sum to %d, sheet has %d lines\n", sum, total) > "/dev/stderr"
    exit 3
  }
  gsum = 0
  for (k = 1; k <= 8; k++) gsum += grp[GORDER[k]]
  if (gsum != defs) {
    printf("REFUSED: token groups sum to %d, definitions counted %d\n", gsum, defs) > "/dev/stderr"
    exit 3
  }
  for (k = 1; k <= 6; k++) printf("%s %d\n", ORDER[k], bucket[ORDER[k]])
  printf("interstitial %d\nTOTAL %d\n", interstitial, total)
  names = 0
  for (k in distinct) names++
  printf("tokendefs %d\ntokennames %d\n", defs, names)
  for (k = 1; k <= 8; k++) printf("grp:%s %d\n", GORDER[k], grp[GORDER[k]])
}
AWK

measure() { awk "$PROGRAM" "$1"; }

# ── the controls ────────────────────────────────────────────────────────────

FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT
failures=0

expect() { # expect <label> <file> <key> <want>
	local got
	got="$(measure "$2" | awk -v k="$3" '$1 == k { print $2 }')"
	if [ "$got" != "$4" ]; then
		printf 'CONTROL FAILED [%s] %s: want %s, got %s\n' "$1" "$3" "$4" "${got:-<none>}" >&2
		failures=$((failures + 1))
	fi
}

cat > "$FIX/known.css" <<'EOF'
/* header */

:root {
  --bg: white;
}
.foo {
  color: red;
}
@media (min-width: 1px) {
  .bar {
    color: blue;
  }
}
EOF
expect known "$FIX/known.css" tokens 3
expect known "$FIX/known.css" rules 3
expect known "$FIX/known.css" media 5
expect known "$FIX/known.css" interstitial 2
expect known "$FIX/known.css" TOTAL 13

# Braces inside a comment must not move the depth; if they did, the file would
# be REFUSED as unbalanced and no number would come back at all.
printf '/* a comment with { and } inside */\n.foo {\n  color: red;\n}\n' > "$FIX/braces.css"
expect braces "$FIX/braces.css" rules 3
expect braces "$FIX/braces.css" interstitial 1

# A `:root` nested inside an `@media` belongs to the media block. Classifying
# by the innermost selector would move token lines into a bucket they are not
# in, which is the exact quantity this measurement is about.
printf '@media (min-width: 1px) {\n  :root {\n    --a: 1px;\n  }\n}\n' > "$FIX/nested.css"
expect nested "$FIX/nested.css" media 5
expect nested "$FIX/nested.css" tokens 0

# Prose naming a variable, and a BEM selector whose `--` is mid-token, are the
# two things that inflate a naive `grep -c -- '--.*:'`. Neither is a definition.
cat > "$FIX/tokens.css" <<'EOF'
/* docs:  --fake-token : must NOT count */
:root {
  --bg: white;
  --adm-line: grey;
}
.adm-btn--danger:hover {
  color: red;
}
EOF
expect tokens "$FIX/tokens.css" tokendefs 2
expect tokens "$FIX/tokens.css" tokennames 2
expect tokens "$FIX/tokens.css" grp:core 1
expect tokens "$FIX/tokens.css" grp:adm 1

# An unclosed block must be REFUSED rather than mis-bucketed.
printf '.foo {\n  color: red;\n' > "$FIX/unclosed.css"
if measure "$FIX/unclosed.css" >/dev/null 2>&1; then
	printf 'CONTROL FAILED [unclosed]: an unbalanced sheet was accepted\n' >&2
	failures=$((failures + 1))
fi

if [ "$failures" -ne 0 ]; then
	printf '\n%d control(s) failed — NO MEASUREMENT PRINTED.\n' "$failures" >&2
	exit 1
fi

# ── the measurement ─────────────────────────────────────────────────────────

printf 'controls: 13 known answers passed\n'
printf 'sheet:    %s (%s bytes)\n\n' "$SHEET" "$(wc -c < "$SHEET" | tr -d ' ')"
measure "$SHEET" | awk '
  $1 == "TOTAL" { total = $2 }
  { key[NR] = $1; val[NR] = $2; last = NR }
  END {
    for (i = 1; i <= last; i++) {
      if (key[i] ~ /^(tokendefs|tokennames|grp:)/) printf("  %-14s %6d\n", key[i], val[i])
      else printf("  %-14s %6d  %5.1f%%\n", key[i], val[i], 100 * val[i] / total)
    }
  }'
