import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChannelMembers } from "../lib/memberTypes";
import {
  NICK_PALETTE_SIZE,
  nickColorIndex,
  nickColorVar,
  senderPrefix,
  snapshotSenderPrefix,
} from "../lib/nickColor";

// UX-5 bucket BC2 — deterministic nick-color hash + scrollback-side
// mode-prefix glyph lookup. Pair feature: per-nick color (replaces
// nick-length-only differentiation) + irssi-style mode prefix in
// scrollback (members pane already has sigil via `memberSigil`).
//
// The helper signature is the load-bearing contract — it MUST be:
//   * deterministic (same input → same index, always; no Date.now / Math.random)
//   * case-insensitive (RFC 2812 §2.2; cic-side `nickEquals` rule)
//   * in-bounds (0 ≤ index < NICK_PALETTE_SIZE)
//
// The CSS palette `--nick-color-0..{NICK_PALETTE_SIZE-1}` lives in
// `themes/default.css` and is theme-aware via the `:root[data-theme="..."]`
// selector. This module is theme-AGNOSTIC — it produces a
// `var(--nick-color-N)` string; theme blocks own the actual colors.
//
// #444 — the palette is 32 buckets, of which the theme AUTHORS only 16
// (`nick_0..15`, the hand-picked xchat-style hues, unchanged server-side);
// cic DERIVES buckets 16..31 in CSS from those 16 (a tone shift), so the
// render palette doubles with zero server / theme-token / migration change.
// See the `widened palette (#444)` block below for the two invariants that
// keep the derivation safe.

describe("nickColorIndex", () => {
  it("returns the same index for the same nick across calls", () => {
    const a = nickColorIndex("vjt");
    const b = nickColorIndex("vjt");
    expect(a).toBe(b);
  });

  it("is case-insensitive per RFC 2812 §2.2 (Vjt === vjt === VJT)", () => {
    const lower = nickColorIndex("vjt");
    const mixed = nickColorIndex("Vjt");
    const upper = nickColorIndex("VJT");
    expect(mixed).toBe(lower);
    expect(upper).toBe(lower);
  });

  it("gives one color to case-variant nicks; the hue is on the ASCII fold (#525)", () => {
    // #525: the hue is computed on the ASCII fold (A-Z only). Case
    // variants share a color; `[ ] \ ~` are NO LONGER folded to
    // `{ } | ^` (bahamut is CASEMAPPING=ascii), so a bracket nick and its
    // brace twin are distinct identities that hash independently.
    expect(nickColorIndex("Foo[1]")).toBe(nickColorIndex("foo[1]"));
    expect(nickColorIndex("A\\B")).toBe(nickColorIndex("a\\b"));
    expect(nickColorIndex("OP~X")).toBe(nickColorIndex("op~x"));
  });

  it("always returns an index in [0, NICK_PALETTE_SIZE)", () => {
    const nicks = ["vjt", "alice", "bob", "carol", "dave", "_", "x", "OperServ", "{user}", "💩"];
    for (const nick of nicks) {
      const idx = nickColorIndex(nick);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(NICK_PALETTE_SIZE);
    }
  });

  it("distributes distinct nicks across multiple palette buckets (sanity, not uniformity)", () => {
    const nicks = [
      "alice",
      "bob",
      "carol",
      "dave",
      "eve",
      "frank",
      "grace",
      "heidi",
      "ivan",
      "judy",
      "kate",
      "leo",
      "mallory",
      "nick",
      "olivia",
      "peggy",
      "quentin",
      "ruth",
      "sasha",
      "trent",
    ];
    const indices = new Set(nicks.map(nickColorIndex));
    // 20 nicks across the 32-bucket palette: a working hash should still
    // reach at least 6 distinct indices (loose sanity, NOT a uniformity or
    // no-collision claim). A pathologically bad hash (e.g. all → 0) fails.
    expect(indices.size).toBeGreaterThanOrEqual(6);
  });

  it("handles empty string without throwing (defensive — should never happen at the boundary)", () => {
    const idx = nickColorIndex("");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(NICK_PALETTE_SIZE);
  });
});

// #444 — a busy channel shows more than 16 nicks at once, so at 16 buckets
// same-colour collisions are a pigeonhole CERTAINTY (measured in the issue:
// ~13.75 distinct colours at a 30-nick roster). The palette is the ceiling,
// not the hash. cic doubles it to 32 by DERIVING buckets 16..31 from the
// theme's own 16 hand-picked hues (a tone shift toward `--fg`, in CSS
// `color-mix`), so the server theme vocabulary stays at 16 tokens (zero
// server change, no migration) while the RENDER palette is 32. These tests
// pin the two invariants that keep that safe.
describe("widened palette (#444) — 32 render buckets, 16 CSS-derived", () => {
  // vitest runs with cwd = the cicchetto/ root, so the theme file is a
  // stable cwd-relative path (import.meta.url is mangled by the jsdom transform).
  const css = readFileSync("src/themes/default.css", "utf8");

  it("declares a CSS colour for EVERY bucket the hash can return (no undefined var)", () => {
    // The undefined-var trap `NickText` would hit: it renders
    // `color: var(--nick-color-N)` with NO fallback, so a bucket with no
    // `--nick-color-N` declaration is invalid-at-computed-value-time and the
    // nick silently inherits `--fg` (uncoloured). EVERY index in
    // [0, NICK_PALETTE_SIZE) must have a declaration — asserted against the
    // constant so a future resize can't outrun the CSS unnoticed.
    const missing: number[] = [];
    for (let i = 0; i < NICK_PALETTE_SIZE; i++) {
      if (!css.includes(`--nick-color-${i}:`)) missing.push(i);
    }
    expect(missing, "buckets with no --nick-color-N declaration in themes/default.css").toEqual([]);
  });

  it("reaches buckets beyond the legacy ceiling over a realistic roster", () => {
    // Proves the hash actually exercises the widened range — guards a forgotten
    // constant bump or a mapping that can't reach the upper band. Deterministic
    // (fixed corpus + pure hash), so it never flakes.
    const roster = Array.from({ length: 400 }, (_, i) => `nick_${i}_azzurra`);
    const maxIndex = Math.max(...roster.map(nickColorIndex));
    expect(maxIndex).toBeGreaterThanOrEqual(NICK_PALETTE_SIZE / 2);
  });
});

describe("nickColorVar", () => {
  it("returns the var() string for the palette slot", () => {
    const v = nickColorVar("vjt");
    expect(v).toMatch(/^var\(--nick-color-\d+\)$/);
  });

  it("agrees with nickColorIndex for the embedded index", () => {
    const idx = nickColorIndex("vjt");
    expect(nickColorVar("vjt")).toBe(`var(--nick-color-${idx})`);
  });
});

describe("senderPrefix", () => {
  const m = (entries: Record<string, string[]>): ChannelMembers =>
    Object.entries(entries).map(([nick, modes]) => ({ nick, modes }));

  it("returns @ for an op", () => {
    expect(senderPrefix(m({ alice: ["@"] }), "alice", "ascii")).toBe("@");
  });

  it("returns % for a halfop", () => {
    expect(senderPrefix(m({ bob: ["%"] }), "bob", "ascii")).toBe("%");
  });

  it("returns + for a voiced member", () => {
    expect(senderPrefix(m({ carol: ["+"] }), "carol", "ascii")).toBe("+");
  });

  it("returns empty string for a plain member", () => {
    expect(senderPrefix(m({ dave: [] }), "dave", "ascii")).toBe("");
  });

  it("returns empty string for a non-member (sender from a different channel)", () => {
    expect(senderPrefix(m({ alice: ["@"] }), "stranger", "ascii")).toBe("");
  });

  it("returns empty string when members list is undefined (unknown channel)", () => {
    expect(senderPrefix(undefined, "alice", "ascii")).toBe("");
  });

  it("returns the HIGHEST precedence prefix when a member has multiple modes (@ > % > +)", () => {
    expect(senderPrefix(m({ alice: ["@", "+"] }), "alice", "ascii")).toBe("@");
    expect(senderPrefix(m({ bob: ["%", "+"] }), "bob", "ascii")).toBe("%");
    expect(senderPrefix(m({ carol: ["+"] }), "carol", "ascii")).toBe("+");
  });

  it("is case-insensitive for the nick lookup (Alice/alice match)", () => {
    expect(senderPrefix(m({ Alice: ["@"] }), "alice", "ascii")).toBe("@");
    expect(senderPrefix(m({ alice: ["@"] }), "Alice", "ascii")).toBe("@");
  });
});

describe("snapshotSenderPrefix (#25)", () => {
  it("returns the snapshotted glyph from meta.sender_prefix", () => {
    expect(snapshotSenderPrefix({ sender_prefix: "@" })).toBe("@");
    expect(snapshotSenderPrefix({ sender_prefix: "%" })).toBe("%");
    expect(snapshotSenderPrefix({ sender_prefix: "+" })).toBe("+");
  });

  it("returns '' when the key is absent (plain sender / pre-#25 row)", () => {
    expect(snapshotSenderPrefix({})).toBe("");
    expect(snapshotSenderPrefix({ new_nick: "x" })).toBe("");
  });

  it("returns '' for a malformed / non-glyph value (never a live guess)", () => {
    expect(snapshotSenderPrefix({ sender_prefix: "~" })).toBe("");
    expect(snapshotSenderPrefix({ sender_prefix: 1 })).toBe("");
    expect(snapshotSenderPrefix({ sender_prefix: null })).toBe("");
  });
});
