// #455 — client-side textual emphasis markers, keeping the markers visible.
//
// A second, display-only emphasis layer ON TOP of the wire-level mIRC
// formatting (mircFormat.ts). Three ASCII markers, irssi/mIRC-era style:
//
//   *word*  → bold
//   _word_  → underline
//   /word/  → italic
//
// This is DECORATION, not Markdown compilation: the marker characters
// stay IN the styled text (`*word*` renders bold including the two
// asterisks). Nothing is stripped, so window.getSelection()/copy round-
// trips the original bytes verbatim — the span-text concatenation always
// reproduces the input.
//
// PURELY CLIENT SIDE. This never sees the wire and never sees a URL: the
// render layer (MircText.renderRun) runs `linkify()` first and feeds this
// tokenizer ONLY the `text`-typed linkify segments, so `_`/`/` inside a
// URL or a `host.tld/path` are structurally out of reach. The output OR-s
// its attributes onto the run's own mIRC attributes (wire formatting is
// authoritative and always wins; an already-bold run stays bold).
//
// ## Matching rules (the false-positive guards)
//
// `_` and `/` are extremely common in paths (`/usr/bin/`), identifiers
// (`snake_case_name`) and prose (`and/or`), so a naive pair-matcher is
// useless. A marker pair is a span only when ALL hold:
//
//   (a) the OPENER is at a left word boundary — preceded by start-of-
//       string, whitespace, or an opening bracket `([{` — AND immediately
//       followed by a non-whitespace char. Kills `snake_case` (opener
//       after a letter), `2*3*4` (after a digit), `2 * 3 * 4` and the
//       `* bullet` line (opener followed by space).
//   (b) the CLOSER is at a right word boundary — followed by end-of-
//       string, whitespace, terminal punctuation `.,!?;:)]}`, or another
//       marker char (so `*bold _und_*` cross-type nesting closes cleanly)
//       — AND immediately preceded by a non-whitespace char.
//   (c) the span content is NON-EMPTY and contains NO occurrence of the
//       SAME marker char. This is what kills `/usr/bin/` and `__init__`
//       BY CONSTRUCTION rather than with a blacklist: the closer search
//       stops at the FIRST marker after the opener, so a path's inner
//       slash is either the (nearest) closer or it aborts the opener.
//
// ## Non-greedy — nearest valid closer
//
// The closer is the NEAREST valid marker after the opener, never the
// farthest. Without this, `he said *hi* and *bye*` would match from the
// first `*` to the last and embolden the whole sentence. Rule (c) and
// non-greedy reinforce each other: a greedy match would swallow an inner
// marker into the content, which rule (c) forbids.
//
// ## Cross-type nesting — three independent passes, per-char mask
//
// The three markers are matched INDEPENDENTLY over the original text,
// each producing ranges (marker chars included). A per-character boolean
// mask per attribute is then coalesced into sub-runs, so partially
// overlapping spans (`*a _b* c_`) compose correctly as the union of
// attributes per character. Same-type nesting is not a thing (rule c).
// Zero-gap adjacency `*_word_*` is bold-only by design: the inner `_`
// opener is preceded by `*`, which is not a left word boundary (rule a).

export type EmphasisSpan = {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
};

type EmphasisAttr = "bold" | "italic" | "underline";
type Marker = { char: string; attr: EmphasisAttr };

const MARKERS: readonly Marker[] = [
  { char: "*", attr: "bold" },
  { char: "_", attr: "underline" },
  { char: "/", attr: "italic" },
];

const MARKER_CHARS = new Set(MARKERS.map((m) => m.char));
const OPEN_BRACKETS = new Set(["(", "[", "{"]);
const TERMINAL_PUNCT = new Set([".", ",", "!", "?", ";", ":", ")", "]", "}"]);

// noUncheckedIndexedAccess: index access is `string | undefined`. Return
// undefined for out-of-range so opener/closer boundary checks can treat
// start/end-of-string as a valid word boundary.
const charAt = (s: string, k: number): string | undefined =>
  k >= 0 && k < s.length ? s[k] : undefined;

const isWhitespace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);
const isOpenBracket = (ch: string | undefined): boolean =>
  ch !== undefined && OPEN_BRACKETS.has(ch);
const isTerminalPunct = (ch: string | undefined): boolean =>
  ch !== undefined && TERMINAL_PUNCT.has(ch);
const isMarkerChar = (ch: string | undefined): boolean => ch !== undefined && MARKER_CHARS.has(ch);

// Rule (a): left word boundary + non-whitespace immediately after.
const isValidOpener = (text: string, i: number): boolean => {
  const prev = charAt(text, i - 1);
  const next = charAt(text, i + 1);
  const prevOk = prev === undefined || isWhitespace(prev) || isOpenBracket(prev);
  const nextOk = next !== undefined && !isWhitespace(next);
  return prevOk && nextOk;
};

// Rule (b): right word boundary + non-whitespace immediately before.
const isValidCloser = (text: string, j: number): boolean => {
  const prev = charAt(text, j - 1);
  const next = charAt(text, j + 1);
  const prevOk = prev !== undefined && !isWhitespace(prev);
  const nextOk =
    next === undefined || isWhitespace(next) || isTerminalPunct(next) || isMarkerChar(next);
  return prevOk && nextOk;
};

// All non-overlapping [start, end] ranges (inclusive of the marker chars)
// for one marker, matched non-greedily. The closer search breaks at the
// FIRST marker after a valid opener: if that marker is a valid, non-empty
// closer it forms the span (nearest closer, content marker-free by
// construction — rule c); otherwise the opener is abandoned.
const findRanges = (text: string, marker: string): Array<[number, number]> => {
  const ranges: Array<[number, number]> = [];
  const len = text.length;
  let i = 0;
  while (i < len) {
    if (charAt(text, i) === marker && isValidOpener(text, i)) {
      let j = i + 1;
      let closer = -1;
      while (j < len) {
        if (charAt(text, j) === marker) {
          if (j > i + 1 && isValidCloser(text, j)) closer = j;
          break;
        }
        j++;
      }
      if (closer >= 0) {
        ranges.push([i, closer]);
        i = closer + 1;
        continue;
      }
    }
    i++;
  }
  return ranges;
};

// Split a text segment into emphasis sub-runs. Markers are kept in the
// span text. A run with no emphasis is a single unstyled span; empty
// input is a single empty span (mirrors linkify's never-empty contract).
export function splitEmphasis(text: string): EmphasisSpan[] {
  const len = text.length;
  if (len === 0) return [{ text: "", bold: false, italic: false, underline: false }];

  const boldMask = new Array<boolean>(len).fill(false);
  const italicMask = new Array<boolean>(len).fill(false);
  const underlineMask = new Array<boolean>(len).fill(false);
  const maskFor: Record<EmphasisAttr, boolean[]> = {
    bold: boldMask,
    italic: italicMask,
    underline: underlineMask,
  };

  for (const m of MARKERS) {
    const mask = maskFor[m.attr];
    for (const [start, end] of findRanges(text, m.char)) {
      for (let k = start; k <= end; k++) mask[k] = true;
    }
  }

  const at = (mask: boolean[], k: number): boolean => mask[k] ?? false;

  const spans: EmphasisSpan[] = [];
  let segStart = 0;
  for (let k = 1; k <= len; k++) {
    const boundary =
      k === len ||
      at(boldMask, k) !== at(boldMask, segStart) ||
      at(italicMask, k) !== at(italicMask, segStart) ||
      at(underlineMask, k) !== at(underlineMask, segStart);
    if (boundary) {
      spans.push({
        text: text.slice(segStart, k),
        bold: at(boldMask, segStart),
        italic: at(italicMask, segStart),
        underline: at(underlineMask, segStart),
      });
      segStart = k;
    }
  }
  return spans;
}
