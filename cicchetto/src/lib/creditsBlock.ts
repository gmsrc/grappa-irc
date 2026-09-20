// #1929 — the DICTATED half of the credits' first block: the cow and the
// special thanks.
//
// Both are content rather than behaviour, and both were handed down rather
// than derived, so this module is data with one small function in it. It is a
// module and not JSX because content that someone else wrote should be
// testable without rendering a modal — see `creditsBlock.test.ts`, where the
// list is pinned against the issue and the cow against the ircd it came from.
//
// Sibling of `creditsProse.ts`, which owns the paragraph sets that run AFTER
// this block. The split is the block boundary itself: what is here is shown
// once, on the first pass; what is there is shown on every pass afterwards.

/** One line of the special thanks: who, and what for. */
export type SpecialThanks = {
  readonly who: string;
  readonly why: string;
};

/**
 * The cow's body, transcribed verbatim from Azzurra's bahamut —
 * `azzurra/bahamut src/version.c.SH:148-152`, the `/info` infotext whose
 * balloon reads "This bahamut has Super Cow Powers !".
 *
 * REUSED, not redrawn. The whole reason to put a cow here is that it is the
 * cow Azzurra's `/info` has been printing for twenty years; an ASCII animal
 * that merely resembles it would be a different joke told to nobody.
 *
 * The source is a shell heredoc generating C, so every backslash is written
 * there as four — two collapses later, this is what reaches a terminal.
 * `String.raw` keeps the escapes looking like what they are.
 */
const COW_BODY = String.raw`        \   ^__^
         \  (oo)\_______
            (__)\       )\/\
                ||----w |
                ||     ||`;

/**
 * What our cow says, dictated by vjt on #grappa 2026-09-06 09:28 — TWO lines,
 * verbatim and lowercase as he typed them:
 *
 *     this grappa server
 *     has super cow powers
 *
 * It replaced the one-liner ("This grappa has Super Cow Powers !") because the
 * single line is what made the block 38 columns wide, and 38 columns is what
 * forced the font down to a size he could not read: "il font è troppo piccolo,
 * specialmente quello del cowsay ... direi che il fumetto dovrebbe andare a
 * capi". Two short lines cap the balloon at 24 columns, so the art is now as
 * wide as the COW is (28) and the type can grow into the room that frees.
 */
const COW_SAYS: readonly string[] = ["this grappa server", "has super cow powers"];

/**
 * A cowsay balloon around one or more lines, in cowsay's own geometry.
 *
 * Built rather than transcribed so the rules can never disagree with the
 * sentence — the failure mode of a hand-drawn box is that someone edits the
 * words and the underscores stay the old length. Fed bahamut's own single
 * sentence it still reproduces bahamut's own balloon byte-for-byte, which is
 * what `creditsBlock.test.ts` checks before trusting it with ours.
 *
 * The ONE-LINE shape is bahamut's and is kept exactly: `< text >` between two
 * space-flanked rules. It is NOT the general case with n=1 — real cowsay uses
 * the angle brackets only for a single line and the `/ | \` shoulders as soon
 * as there are two, so collapsing the two shapes into one would break the
 * reference the whole joke rests on.
 *
 * Multi-line pads every line to the widest, or the right-hand wall zigzags.
 *
 * @param said what the cow speaks — one line, or several
 */
export function cowSaying(said: string | readonly string[]): string {
  const spoken = typeof said === "string" ? [said] : said;
  const first = spoken[0] ?? "";
  if (spoken.length === 1) {
    const rule = (fill: string): string => ` ${fill.repeat(first.length + 2)} `;
    return [rule("_"), `< ${first} >`, rule("-"), COW_BODY].join("\n");
  }

  const width = Math.max(...spoken.map((line) => line.length));
  const rule = (fill: string): string => ` ${fill.repeat(width + 2)} `;
  const walls = spoken.map((line, i) => {
    const [left, right] =
      i === 0 ? ["/", "\\"] : i === spoken.length - 1 ? ["\\", "/"] : ["|", "|"];
    return `${left} ${line.padEnd(width)} ${right}`;
  });
  return [rule("_"), ...walls, rule("-"), COW_BODY].join("\n");
}

/** The cow as it is rendered in the credits, balloon and all. */
export const CREDITS_COW: string = cowSaying(COW_SAYS);

/**
 * The special thanks, exactly as vjt dictated them on issue 1929.
 *
 * 🔴 COPIED VERBATIM. Nothing here is ours to improve: no name added, none
 * removed, no wording tightened, no "tidier" order. **Sonic is thanked twice
 * on purpose** — once among the people keeping Azzurra standing and once for
 * bicchierino — and deduplicating him would be editing someone else's words.
 * The test pins the whole list against the issue for exactly that reason.
 *
 * `who` and `why` are separate fields rather than one sentence so the roll can
 * lay them out as a list; the em-dash that joins them in the issue text is
 * presentation and lives in the stylesheet's business, not here.
 */
export const CREDITS_SPECIAL_THANKS: readonly SpecialThanks[] = [
  { who: "Hypnotize, Mezmerize, Sonic, scorpion, joep", why: "for keeping Azzurra standing" },
  {
    who: "DeepSET / Johnny^Lizard",
    why: "for embracing grappa and spreading it far and wide",
  },
  { who: "tsk", why: "for suggesting Erlang" },
  { who: "peluche", why: "most assiduous betatester" },
  { who: "nextime", why: "for shottino" },
  { who: "Lucy", why: "for resentin" },
  { who: "Sonic", why: "for bicchierino" },
  { who: "Sythos", why: "for Cordiale" },
  {
    who: "morph",
    why: "for spreading grappa, bringing people back, and throwing himself at the ircd and the services again",
  },
  { who: "the whole #sniffo crew", why: "for still being here" },
];
