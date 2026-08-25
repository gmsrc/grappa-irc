import { describe, expect, it } from "vitest";
import { MUTE_SNOOZE_OPTIONS, snoozeUntil } from "../lib/muteSnooze";

// #950 — the snooze offer table and the ONE place a chosen offer becomes the
// unix-seconds integer `muted_targets[key].until` carries. Pure: `now` is a
// parameter, so every arm here is deterministic without fake timers.

describe("snoozeUntil — #950", () => {
  // 2026-08-08 14:30:00 local time.
  const now = new Date(2026, 7, 8, 14, 30, 0, 0);
  const nowSeconds = Math.floor(now.getTime() / 1000);

  it("turns the 1-hour offer into now + 3600 seconds", () => {
    expect(snoozeUntil("1h", now)).toBe(nowSeconds + 3_600);
  });

  it("turns the 8-hour offer into now + 28800 seconds", () => {
    expect(snoozeUntil("8h", now)).toBe(nowSeconds + 28_800);
  });

  it("resolves 'until tomorrow' to the NEXT local midnight, not now + 24h", () => {
    const expected = Math.floor(new Date(2026, 7, 9, 0, 0, 0, 0).getTime() / 1000);
    expect(snoozeUntil("tomorrow", now)).toBe(expected);
    // ...which is strictly less than a rolling 24 hours from 14:30.
    expect(snoozeUntil("tomorrow", now)).toBeLessThan(nowSeconds + 86_400);
  });

  it("keeps 'until tomorrow' in the future one minute before midnight", () => {
    const lateNight = new Date(2026, 7, 8, 23, 59, 0, 0);
    const until = snoozeUntil("tomorrow", lateNight);
    expect(until).not.toBeNull();
    expect(until as number).toBeGreaterThan(Math.floor(lateNight.getTime() / 1000));
  });

  it("gives the permanent offer a null until — the shape's 'never expires'", () => {
    expect(snoozeUntil("forever", now)).toBeNull();
  });

  it("emits whole seconds the server will accept as a positive integer", () => {
    for (const option of MUTE_SNOOZE_OPTIONS) {
      const until = snoozeUntil(option.value, now);
      if (until === null) continue;
      expect(Number.isInteger(until)).toBe(true);
      expect(until).toBeGreaterThan(0);
    }
  });
});

describe("MUTE_SNOOZE_OPTIONS — #950", () => {
  it("offers the three #866 durations plus the permanent mute, in that order", () => {
    expect(MUTE_SNOOZE_OPTIONS.map((o) => o.value)).toEqual(["1h", "8h", "tomorrow", "forever"]);
  });

  it("labels every offer for a human, never with the raw token", () => {
    for (const option of MUTE_SNOOZE_OPTIONS) {
      expect(option.label).not.toBe(option.value);
      expect(option.label.length).toBeGreaterThan(2);
    }
  });
});
