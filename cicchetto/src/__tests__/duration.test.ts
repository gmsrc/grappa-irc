import { describe, expect, it } from "vitest";
import { formatDuration, formatDurationSince } from "../lib/duration";

// #474 — shared human-duration formatter, lifted from WhoisCard's private
// `formatIdle` so the server-info rail card and the whois idle row render
// the same "4h 12m" / "2d 3h" shape from ONE implementation (DRY). The
// server card additionally needs "connected for <duration>" from a wire
// ISO timestamp, hence `formatDurationSince`.

describe("formatDuration (seconds → human)", () => {
  it("returns null for null", () => {
    expect(formatDuration(null)).toBeNull();
  });

  it("renders sub-minute as seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
  });

  it("renders minutes under an hour", () => {
    expect(formatDuration(90)).toBe("1m");
    expect(formatDuration(59 * 60)).toBe("59m");
  });

  it("renders hours+minutes under a day", () => {
    // 4h 12m = 15120s — the issue's own example.
    expect(formatDuration(4 * 3600 + 12 * 60)).toBe("4h 12m");
    expect(formatDuration(3600)).toBe("1h 0m");
  });

  it("renders days+hours past a day", () => {
    expect(formatDuration(2 * 86400 + 3 * 3600)).toBe("2d 3h");
  });
});

describe("formatDurationSince (wire ISO + now → human)", () => {
  const now = Date.parse("2026-07-31T12:00:00.000Z");

  it("returns null for a null timestamp", () => {
    expect(formatDurationSince(null, now)).toBeNull();
  });

  it("returns null for an unparseable timestamp (never a confident-wrong value)", () => {
    expect(formatDurationSince("not-a-date", now)).toBeNull();
  });

  it("renders the elapsed duration from the ISO instant to now", () => {
    const since = new Date(now - (4 * 3600 + 12 * 60) * 1000).toISOString();
    expect(formatDurationSince(since, now)).toBe("4h 12m");
  });

  it("clamps a future timestamp (clock skew) to 0s rather than going negative", () => {
    const future = new Date(now + 5000).toISOString();
    expect(formatDurationSince(future, now)).toBe("0s");
  });
});
