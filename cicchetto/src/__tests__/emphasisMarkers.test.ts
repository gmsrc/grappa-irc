import { describe, expect, it } from "vitest";
import { type EmphasisSpan, splitEmphasis } from "../lib/emphasisMarkers";

// #455 — client-side textual emphasis markers, keeping the markers visible.
//
//   *word*  → bold      (markers included in the styled text)
//   _word_  → underline
//   /word/  → italic
//
// splitEmphasis is the PURE tokenizer over a single already-linkified
// text segment: it never sees URLs (the render layer only feeds it
// linkify text segments) and never touches the wire. It reports which of
// {bold, italic, underline} apply to each sub-run; the render layer ORs
// those onto the run's own mIRC attributes. Marker chars stay IN the
// span text — this is decoration (irssi/mIRC-era look), not Markdown
// compilation — so copy-paste round-trips the original bytes.

const plain = (text: string): EmphasisSpan => ({
  text,
  bold: false,
  italic: false,
  underline: false,
});
const bold = (text: string): EmphasisSpan => ({ ...plain(text), bold: true });
const under = (text: string): EmphasisSpan => ({ ...plain(text), underline: true });
const ital = (text: string): EmphasisSpan => ({ ...plain(text), italic: true });

// The core fidelity invariant: concatenating every span's text MUST
// reproduce the input verbatim (markers kept, nothing added/dropped).
const fidelity = (input: string) =>
  expect(
    splitEmphasis(input)
      .map((s) => s.text)
      .join(""),
  ).toBe(input);

describe("splitEmphasis (#455)", () => {
  describe("plain text (no markers)", () => {
    it("returns a single unstyled span", () => {
      expect(splitEmphasis("hello world")).toEqual([plain("hello world")]);
    });

    it("returns a single unstyled span for empty input", () => {
      expect(splitEmphasis("")).toEqual([plain("")]);
    });
  });

  describe("single marker pair (markers kept visible)", () => {
    it("styles *word* bold, asterisks included", () => {
      expect(splitEmphasis("a *bold* b")).toEqual([plain("a "), bold("*bold*"), plain(" b")]);
    });

    it("styles _word_ underline, underscores included", () => {
      expect(splitEmphasis("a _und_ b")).toEqual([plain("a "), under("_und_"), plain(" b")]);
    });

    it("styles /word/ italic, slashes included", () => {
      expect(splitEmphasis("a /it/ b")).toEqual([plain("a "), ital("/it/"), plain(" b")]);
    });

    it("allows multi-word spans", () => {
      expect(splitEmphasis("*due parole*")).toEqual([bold("*due parole*")]);
    });
  });

  describe("non-greedy: nearest valid closer, two independent pairs per line", () => {
    it("bold — *hi* and *bye* are two spans, not one greedy span", () => {
      expect(splitEmphasis("a *hi* b *bye* c")).toEqual([
        plain("a "),
        bold("*hi*"),
        plain(" b "),
        bold("*bye*"),
        plain(" c"),
      ]);
    });

    it("underline — _hi_ and _bye_ are two spans", () => {
      expect(splitEmphasis("a _hi_ b _bye_ c")).toEqual([
        plain("a "),
        under("_hi_"),
        plain(" b "),
        under("_bye_"),
        plain(" c"),
      ]);
    });

    it("italic — /hi/ and /bye/ are two spans", () => {
      expect(splitEmphasis("a /hi/ b /bye/ c")).toEqual([
        plain("a "),
        ital("/hi/"),
        plain(" b "),
        ital("/bye/"),
        plain(" c"),
      ]);
    });
  });

  describe("false positives stay literal", () => {
    it("leaves a filesystem path /usr/bin/ untouched (content has the marker)", () => {
      expect(splitEmphasis("/usr/bin/")).toEqual([plain("/usr/bin/")]);
    });

    it("leaves a rooted path /usr/local/etc untouched", () => {
      expect(splitEmphasis("/usr/local/etc")).toEqual([plain("/usr/local/etc")]);
    });

    it("leaves snake_case_name untouched (opener not at a word boundary)", () => {
      expect(splitEmphasis("snake_case_name")).toEqual([plain("snake_case_name")]);
    });

    it("leaves and/or untouched (opener preceded by a letter)", () => {
      expect(splitEmphasis("and/or")).toEqual([plain("and/or")]);
    });

    it("leaves 2*3*4 untouched (opener preceded by a digit)", () => {
      expect(splitEmphasis("2*3*4")).toEqual([plain("2*3*4")]);
    });

    it("leaves spaced arithmetic 2 * 3 * 4 untouched (opener followed by space)", () => {
      expect(splitEmphasis("2 * 3 * 4")).toEqual([plain("2 * 3 * 4")]);
    });

    it("leaves an unmatched lone marker untouched", () => {
      expect(splitEmphasis("a _lonely marker")).toEqual([plain("a _lonely marker")]);
    });

    it("leaves an empty span ** // __ untouched", () => {
      expect(splitEmphasis("** // __")).toEqual([plain("** // __")]);
    });

    it("leaves a leading '* ' bullet literal (opener followed by space)", () => {
      expect(splitEmphasis("* voce di lista")).toEqual([plain("* voce di lista")]);
    });
  });

  describe("word-boundary punctuation around the pair", () => {
    it("matches inside parentheses (*bold*)", () => {
      expect(splitEmphasis("(*bold*)")).toEqual([plain("("), bold("*bold*"), plain(")")]);
    });

    it("matches with a trailing period *bold*.", () => {
      expect(splitEmphasis("*bold*.")).toEqual([bold("*bold*"), plain(".")]);
    });
  });

  describe("cross-type nesting (three independent passes, per-char mask)", () => {
    it("space-separated inner marker nests: *bold _und_* → bold whole, underline the inner", () => {
      expect(splitEmphasis("*bold _und_*")).toEqual([
        bold("*bold "),
        { text: "_und_", bold: true, italic: false, underline: true },
        bold("*"),
      ]);
    });

    it("adjacent zero-gap *_word_* is bold-only (inner opener not at a boundary)", () => {
      expect(splitEmphasis("*_word_*")).toEqual([bold("*_word_*")]);
    });
  });

  describe("copy-paste fidelity — span text concatenation reproduces the input", () => {
    it("round-trips every shape verbatim, markers included", () => {
      fidelity("plain text");
      fidelity("a *bold* and _under_ and /italic/ end");
      fidelity("/usr/bin/ and snake_case");
      fidelity("*hi* and *bye*");
      fidelity("(*bold*). and /it/,");
      fidelity("*bold _und_*");
    });
  });
});
