import { describe, expect, it } from "vitest";
import type { ConnectionState } from "../lib/api";
import { connectionStateEmoji } from "../lib/connectionStateEmoji";

// ADMIN-LAYOUT-FIX (2026-07-12) — pure table test for the DB-canonical
// `connection_state` → glyph map rendered in AdminVisitorsTab. Mirrors
// the timeFormat.ts (#217) closed-set→value pattern: the closed set is
// `Grappa.Networks.Credential.connection_state()` = :connected |
// :failing | :parked | :failed, encoded over JSON as the string
// discriminator, plus a defensive `null`/unrecognised → ⚪ fallback (the
// wire field is non-nullable per api.ts, so the null arm is belt-and-
// braces, not a live signal). Every real state + the fallback maps to a
// glyph AND an aria-label word — the label is the a11y hook AND the test
// seam (assert the word, NOT the glyph codepoint, so a glyph tweak
// doesn't break the suite).

// The full closed set, sourced from the production union type so a fourth
// arm landing in api.ts's ConnectionState (which mirrors a server-side
// schema change) trips this matrix loudly instead of silently degrading
// to the ⚪ fallback.
const STATES: ReadonlyArray<[ConnectionState, string]> = [
  ["connected", "connected"],
  // #1675 — the fourth value. `failing` and `failed` are different
  // facts (retrying vs terminal) and the "DISTINCT glyph" case below is
  // what keeps them from rendering as the same picture.
  ["failing", "failing"],
  ["parked", "parked"],
  ["failed", "failed"],
];

describe("connectionStateEmoji", () => {
  it.each(STATES)("maps %s to a non-empty glyph + its word label", (state, word) => {
    const { glyph, label } = connectionStateEmoji(state);
    expect(glyph.length).toBeGreaterThan(0);
    expect(label).toBe(word);
  });

  it("gives each real state a DISTINCT glyph", () => {
    const glyphs = STATES.map(([state]) => connectionStateEmoji(state).glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("falls back to the neutral ⚪ glyph + 'unknown' label for null", () => {
    const { glyph, label } = connectionStateEmoji(null);
    expect(glyph).toBe("⚪");
    expect(label).toBe("unknown");
  });

  it("falls back to the neutral ⚪ glyph + 'unknown' label for an unrecognised value", () => {
    // Degrade visibly, never throw — an unexpected wire value (e.g. a
    // future server state cic hasn't shipped a glyph for) must render the
    // neutral fallback, not crash the admin table.
    const { glyph, label } = connectionStateEmoji("bogus" as unknown as ConnectionState);
    expect(glyph).toBe("⚪");
    expect(label).toBe("unknown");
  });
});
