import { describe, expect, it } from "vitest";
import { CREDITS_COW, CREDITS_SPECIAL_THANKS, cowSaying } from "../lib/creditsBlock";

// #1929 — the cow and the special thanks, the two halves of the first block
// that are DICTATED rather than derived.
//
// Both are content someone handed us, so the tests here are pins rather than
// behaviour checks, and that is the point: the failure they exist to catch is
// a future tidy-up "improving" a list vjt wrote out by hand, or a cow that
// drifted off the ASCII it was copied from. There is nothing to compute, so
// there is nothing to assert except sameness — and sameness against the
// ORIGINAL, never against a second copy of ourselves.

/** What bahamut's own cow says, so the generator can be fed the original. */
const BAHAMUT_SAYS = "This bahamut has Super Cow Powers !";

/**
 * bahamut's eight lines exactly as its `/info` prints them, transcribed from
 * `azzurra/bahamut src/version.c.SH:145-152`. The source is a shell heredoc
 * generating C, so every backslash is written there as four; this is what
 * reaches a terminal after both collapses.
 *
 * One quoted string per line rather than one template literal, for TWO
 * reasons that both bite silently:
 *
 *   * the two rules END IN A SPACE, and trailing whitespace inside a
 *     multi-line template is invisible in review and eaten by half the tools
 *     that touch a file — inside quotes it survives, and it can be seen;
 *   * the tail line ends in a BACKSLASH, and `String.raw` does not save you
 *     from that: `\` still escapes the closing backtick at the tokenizer, so
 *     the template silently swallows the rest of the file.
 *
 * Hence `\\` per backslash, in ordinary quotes.
 */
const BAHAMUT_COW = [
  " _____________________________________ ",
  "< This bahamut has Super Cow Powers ! >",
  " ------------------------------------- ",
  "        \\   ^__^",
  "         \\  (oo)\\_______",
  "            (__)\\       )\\/\\",
  "                ||----w |",
  "                ||     ||",
].join("\n");

/**
 * What OUR cow says, dictated by vjt on #grappa (2026-09-06 09:28) verbatim
 * and lowercase, broken across two lines where he broke it.
 *
 * Written out again here rather than imported from `creditsBlock.ts`: an
 * import would compare the shipped words to themselves and pass whatever they
 * became. This is the second copy that makes the pin a pin — and it is also
 * what tells the geometry assertions how many lines to expect, so a third line
 * added to the cow lands as a RED here and nowhere else.
 */
const SAID: readonly string[] = ["this grappa server", "has super cow powers"];

const lines = (): readonly string[] => CREDITS_COW.split("\n");

describe("the cowsay (#1929 — bahamut's cow, speaking for grappa)", () => {
  it("reproduces bahamut's cow EXACTLY when fed bahamut's sentence", () => {
    // The positive control on the balloon builder, and the assertion that
    // earns the right to generate the box instead of transcribing it: given
    // the original sentence, the generator emits the original eight lines,
    // underscore for underscore. If it did not, every claim below about "the
    // same cow" would be a claim about a lookalike.
    expect(cowSaying(BAHAMUT_SAYS)).toBe(BAHAMUT_COW);
  });

  it("keeps bahamut's cow body byte-for-byte", () => {
    // The ASCII is REUSED, not redrawn. A cow that merely looks similar is a
    // different cow, and the whole point of the reference is that this is the
    // one Azzurra's /info has been printing for twenty years.
    const body = BAHAMUT_COW.split("\n").slice(3).join("\n");
    expect(CREDITS_COW.endsWith(body)).toBe(true);
  });

  it("speaks for grappa, and no longer for bahamut", () => {
    // vjt dictated these two lines on #grappa (2026-09-06 09:28), lowercase
    // and broken where he broke them. Pinned as two separate `toContain`s
    // rather than one joined string: the padding between the text and the
    // right-hand wall is computed, so a joined literal would be pinning the
    // BALLOON's arithmetic here as well, in the test that exists to pin the
    // WORDS. The geometry has its own assertions below.
    for (const line of SAID) {
      expect(CREDITS_COW).toContain(line);
    }
    expect(CREDITS_COW).not.toContain("bahamut");
  });

  it("keeps the balloon square around whatever the cow says", () => {
    // Every balloon line must be the same width or the box is visibly broken.
    // This is the assertion that makes editing the text safe: change the
    // sentence and the rules follow, because they are measured from it.
    //
    // Counted off the RULES rather than hard-coded at three or four lines, so
    // that it keeps holding when the cow is given a third thing to say.
    const balloon = lines().slice(0, 1 + SAID.length + 1);
    expect(balloon.length).toBeGreaterThanOrEqual(4);
    for (const line of balloon) {
      expect(line.length).toBe(balloon[0]?.length);
    }
  });

  it("draws the balloon the way cowsay does, with shoulders once it wraps", () => {
    // Two lines or more is cowsay's BOX shape, not bahamut's `< >` one: rules
    // top and bottom, `/ \` on the first line, `\ /` on the last. The single
    // line keeps the angle brackets, and the test above proves it by rebuilding
    // bahamut's own cow byte-for-byte — these two shapes are separate on
    // purpose, and collapsing them would break that reference.
    const [top, ...rest] = lines();
    const walls = rest.slice(0, SAID.length);
    const bottom = rest[SAID.length];
    expect(top).toMatch(/^ _+ $/);
    expect(bottom).toMatch(/^ -+ $/);
    expect(walls[0]).toMatch(/^\/ .* \\$/);
    expect(walls[walls.length - 1]).toMatch(/^\\ .* \/$/);
  });

  it("is a `pre` block's worth of lines, not a paragraph", () => {
    // Two rules, one wall line per line spoken, five body lines. A cow that
    // lost a line still renders, which is why the count is pinned.
    expect(lines()).toHaveLength(2 + SAID.length + 5);
  });
});

describe("the special thanks (#1929 — dictated, copied verbatim)", () => {
  // vjt dictated this list in the issue, and adds to it by order since. It is
  // reproduced here in full and in order, so that changing the shipped list
  // without changing this file is a RED — which is exactly the friction
  // wanted around someone else's words. Every later addition carries the
  // order that put it there, inline.
  const DICTATED: readonly (readonly [string, string])[] = [
    ["Hypnotize, Mezmerize, Sonic, scorpion, joep", "for keeping Azzurra standing"],
    ["DeepSET / Johnny^Lizard", "for embracing grappa and spreading it far and wide"],
    ["tsk", "for suggesting Erlang"],
    ["peluche", "most assiduous betatester"],
    ["nextime", "for shottino"],
    ["Lucy", "for resentin"],
    ["Sonic", "for bicchierino"],
    // Added on vjt's order, #grappa 2026-09-20: "metti sythos in special
    // thanks nei credits". He named the person, not the reason — so the
    // reason is the same minimal form the other client authors get above,
    // and nothing was put in his mouth.
    ["Sythos", "for Cordiale"],
    [
      "morph",
      "for spreading grappa, bringing people back, and throwing himself at the ircd and the services again",
    ],
    ["the whole #sniffo crew", "for still being here"],
  ];

  it("carries every name that was dictated, in the order it was dictated", () => {
    expect(CREDITS_SPECIAL_THANKS.map((entry) => [entry.who, entry.why])).toEqual(
      DICTATED.map((entry) => [...entry]),
    );
  });

  it("thanks Sonic TWICE, because that is what was dictated", () => {
    // Sonic is named once among the people keeping Azzurra standing and once
    // for bicchierino. They are two different thanks for two different things
    // and collapsing them would be editing vjt's words — the exact "helpful"
    // cleanup this test exists to fail.
    const sonicLines = CREDITS_SPECIAL_THANKS.filter((entry) => entry.who.includes("Sonic"));
    expect(sonicLines).toHaveLength(2);
  });

  it("says nothing this codebase invented", () => {
    // A guard against a name being ADDED. The count is the cheapest total
    // statement about the list, and the one an insertion cannot slip past.
    expect(CREDITS_SPECIAL_THANKS).toHaveLength(DICTATED.length);
  });
});
