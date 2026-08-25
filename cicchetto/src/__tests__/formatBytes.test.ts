import { describe, expect, it } from "vitest";
import { formatBytes } from "../lib/formatBytes";

// #411 — human byte-size formatter for the `file_too_large` cap copy (and any
// future size-carrying surface). Base-1024 with "bytes"/KB/MB/GB/TB labels,
// mirroring the upload orchestrator's binary spelling. These cases pin the
// edge behaviour vjt asked for: zero, sub-KB, flooring (cap-safety), and huge
// values. FLOOR, never round — a non-round cap must never render LARGER than
// the true limit.
describe("formatBytes", () => {
  it("renders 0 as '0 bytes'", () => {
    expect(formatBytes(0)).toBe("0 bytes");
  });

  it("renders 1 as the singular '1 byte'", () => {
    expect(formatBytes(1)).toBe("1 byte");
  });

  it("renders sub-KB counts as plural bytes (no unit scaling)", () => {
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(1023)).toBe("1023 bytes");
  });

  it("renders an exact KB/MB/GB without a trailing decimal", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3 GB");
  });

  it("floors a fractional value to one decimal below 10", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(Math.round(2.5 * 1024 * 1024))).toBe("2.5 MB");
    // 2816 B = 2.75 KB → floor to 2.7 (round would give 2.8): a cap must
    // never read larger than the true limit.
    expect(formatBytes(2816)).toBe("2.7 KB");
  });

  it("drops the decimal once the value reaches 10 in a unit (floored)", () => {
    // 10.5 MB → floor to 10 (round would give 11): whole number at >= 10.
    expect(formatBytes(Math.round(10.5 * 1024 * 1024))).toBe("10 MB");
  });

  it("floors just below a unit boundary without overflowing (never promotes)", () => {
    // 1048575 B is 1023.999… KB. FLOOR keeps it at 1023 KB — round would push
    // to 1024 KB and force a promote to 1 MB. Flooring can never overflow a
    // unit, so this cap reads "1023 KB", never the rounded-up "1 MB" that
    // would overstate the limit.
    expect(formatBytes(1024 * 1024 - 1)).toBe("1023 KB");
  });

  it("handles huge values, clamping the largest unit at TB", () => {
    expect(formatBytes(5 * 1024 ** 4)).toBe("5 TB");
    expect(formatBytes(2 * 1024 ** 5)).toBe("2048 TB");
  });

  it("floors non-finite / negative input to '0 bytes' (defensive)", () => {
    expect(formatBytes(Number.NaN)).toBe("0 bytes");
    expect(formatBytes(-100)).toBe("0 bytes");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 bytes");
  });
});
