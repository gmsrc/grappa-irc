import { describe, expect, it } from "vitest";
import {
  mentionJumpTargetId,
  mentionsBelowViewport,
  type ScrollbackLineGeom,
} from "../lib/mentionScroll";

// #360 — pure geometry core for the mention-aware scroll-to-bottom badge plus
// the mention JUMP anchor. jsdom is blind to real layout (offsetTop /
// clientHeight read 0), so the DOM measuring lives in ScrollbackPane and the
// DECISION is isolated here as pure functions over pre-measured geometry. The
// e2e pins the DOM→scroll wiring in a real browser; these pin the predicate.
//
// #1582 — merged from a second file that tested this same module from
// `src/lib/mentionScroll.test.ts`. The two overlapped on the below-the-fold
// predicate without either dominating the other (different fixtures, same
// claim), so BOTH survive: a case is dropped only when it is byte-identical to
// one that stays or strictly weaker than one that stays. The near-duplicates
// are placed ADJACENT rather than scattered, so the next reader can see the
// redundancy and judge it instead of rediscovering it.

const line = (id: number, top: number, isMention = false): ScrollbackLineGeom => ({
  id,
  top,
  isMention,
});

describe("mentionsBelowViewport", () => {
  it("returns nearest-first ids of mentions fully below the fold", () => {
    const lines = [
      line(1, 0, true), // above fold
      line(2, 100),
      line(3, 500, true), // below fold
      line(4, 700, true), // below fold, farther
    ];
    // viewportBottom = 300 → lines 3 and 4 are below; line 1 is above.
    expect(mentionsBelowViewport(lines, 300)).toEqual([3, 4]);
  });

  it("returns nearest-first ids of mention lines entirely below the fold", () => {
    const lines = [
      line(1, 0, true), // above the fold — already seen
      line(2, 100, false),
      line(3, 300, true), // below the fold
      line(4, 500, false),
      line(5, 700, true), // below the fold
    ];
    // viewport bottom at 200px: lines with top >= 200 are below the fold.
    expect(mentionsBelowViewport(lines, 200)).toEqual([3, 5]);
  });

  it("excludes a mention straddling the fold (partially visible = seen)", () => {
    const lines = [line(1, 290, true)];
    // top 290 < viewportBottom 300 → straddling → excluded.
    expect(mentionsBelowViewport(lines, 300)).toEqual([]);
  });

  it("excludes partially-visible mentions whose top is above the fold", () => {
    // A mention straddling the fold (top above viewportBottom) is treated as
    // seen — not counted, not a jump target.
    const lines = [line(1, 150, true)];
    expect(mentionsBelowViewport(lines, 200)).toEqual([]);
  });

  it("preserves DOM order so element[0] is the nearest jump target", () => {
    const lines = [line(9, 400, true), line(7, 800, true), line(8, 1200, true)];
    // Input order == chronological order; nearest-below is the smallest top,
    // which is the first element. The consumer jumps to below[0].
    expect(mentionsBelowViewport(lines, 100)).toEqual([9, 7, 8]);
  });

  it("excludes non-mention lines below the fold", () => {
    const lines = [line(1, 300, false), line(2, 500, false)];
    expect(mentionsBelowViewport(lines, 100)).toEqual([]);
  });

  it("counts a mention whose top sits exactly at the viewport bottom", () => {
    // top === viewportBottom ⇒ the line begins exactly at the fold, so it is
    // entirely below and unseen.
    const lines = [line(1, 200, true)];
    expect(mentionsBelowViewport(lines, 200)).toEqual([1]);
  });

  it("returns empty when every mention is above the fold", () => {
    const lines = [line(1, 0, true), line(2, 50, true), line(3, 120, false)];
    expect(mentionsBelowViewport(lines, 300)).toEqual([]);
  });
});

// #360 iOS fix — the JUMP anchors on the message AFTER the target mention
// (msg+1), so the mention lands fully visible ABOVE the anchor instead of
// at the very bottom where the on-screen keyboard clips it.
describe("mentionJumpTargetId", () => {
  it("returns the id of the message immediately AFTER the mention (DOM order)", () => {
    const lines = [line(10, 0), line(11, 100, true), line(12, 200), line(13, 300)];
    // mention is id 11 → anchor on id 12 (the next line) so 11 sits above it.
    expect(mentionJumpTargetId(lines, 11)).toBe(12);
  });

  it("falls back to the mention itself when it is the LAST line (no msg+1)", () => {
    const lines = [line(10, 0), line(11, 100), line(12, 200, true)];
    expect(mentionJumpTargetId(lines, 12)).toBe(12);
  });

  it("falls back to the given id when the mention is not in the list (defensive)", () => {
    const lines = [line(10, 0), line(11, 100)];
    expect(mentionJumpTargetId(lines, 99)).toBe(99);
  });
});
