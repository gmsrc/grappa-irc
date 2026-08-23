import { describe, expect, it } from "vitest";
import { deviceClassIcon, deviceDisplayName, parseUserAgent } from "../lib/userAgent";

// UX-4 bucket L (2026-05-19) — minimal UA-string parser.
// Tests cover the common modern browsers/platforms in plain UA-string
// form (no UA-CH brand). Misclassification of niche UAs is benign;
// these tests assert the happy paths for the device-list display.

describe("userAgent.parseUserAgent", () => {
  it("returns UNKNOWN placeholder for null", () => {
    expect(parseUserAgent(null)).toEqual({
      browser: "Unknown browser",
      os: "Unknown OS",
      deviceClass: "unknown",
    });
  });

  it("returns UNKNOWN placeholder for empty string", () => {
    expect(parseUserAgent("")).toEqual({
      browser: "Unknown browser",
      os: "Unknown OS",
      deviceClass: "unknown",
    });
  });

  it("parses Chrome on macOS", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(parseUserAgent(ua)).toEqual({
      browser: "Chrome",
      os: "macOS",
      deviceClass: "desktop",
    });
  });

  it("parses Safari on iOS (iPhone)", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(parseUserAgent(ua)).toEqual({
      browser: "Safari",
      os: "iOS",
      deviceClass: "mobile",
    });
  });

  it("parses Chrome on iOS (CriOS) as Chrome (not Safari)", () => {
    // iOS Chrome embeds Safari + Mobile substrings; CriOS is the
    // discriminator. Verify the order-matters guard in detectBrowser.
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1";
    expect(parseUserAgent(ua)).toEqual({
      browser: "Chrome",
      os: "iOS",
      deviceClass: "mobile",
    });
  });

  it("parses Firefox on Linux", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0";
    expect(parseUserAgent(ua)).toEqual({
      browser: "Firefox",
      os: "Linux",
      deviceClass: "desktop",
    });
  });

  it("parses Edge on Windows (Edg discriminator, not Chrome)", () => {
    // Edge UA embeds Chrome + Safari substrings; Edg/ is the
    // discriminator. Order matters — detectBrowser checks Edg first.
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
    expect(parseUserAgent(ua)).toEqual({
      browser: "Edge",
      os: "Windows",
      deviceClass: "desktop",
    });
  });

  it("parses Chrome on Android (mobile tablet discrimination via Mobile token)", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
    expect(parseUserAgent(ua)).toEqual({
      browser: "Chrome",
      os: "Android",
      deviceClass: "mobile",
    });
  });

  it("parses Safari on iPad as tablet", () => {
    const ua =
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(parseUserAgent(ua)).toEqual({
      browser: "Safari",
      os: "iOS",
      deviceClass: "tablet",
    });
  });

  it("returns Unknown browser + Unknown OS on a UA carrying no product token", () => {
    // #1682 note: "HypotheticalBot/9000" used to live here as the
    // never-classified case. It IS a well-formed product token, so it now
    // parses as "HypotheticalBot" — that reclassification is the fix, not a
    // regression. The genuinely unclassifiable UA is one with no `Name/version`
    // at its head at all.
    expect(parseUserAgent("some free-form nonsense")).toEqual({
      browser: "Unknown browser",
      os: "Unknown OS",
      deviceClass: "unknown",
    });
  });
});

// #1682 — third-party / native clients. `detectBrowser`'s allowlist only ever
// knew browsers, so every native client collapsed to "Unknown browser". The
// product-token branch runs LAST, after every browser branch, and only on a UA
// that is not Mozilla-shaped.
describe("userAgent.parseUserAgent — third-party clients (#1682)", () => {
  it("names a bare native client from its leading product token", () => {
    expect(parseUserAgent("Resentin/1.2.3")).toEqual({
      browser: "Resentin",
      os: "Unknown OS",
      deviceClass: "unknown",
    });
  });

  it("names a native client that carries a platform comment it cannot place", () => {
    expect(parseUserAgent("Resentin/1.2 (FreeBSD 14.1; amd64)")).toEqual({
      browser: "Resentin",
      os: "Unknown OS",
      deviceClass: "unknown",
    });
  });

  it("keeps the OS when a native client DOES carry a platform token", () => {
    // The product-token branch replaces only the browser; detectOs and
    // detectDeviceClass are untouched and still get their chance.
    expect(parseUserAgent("Resentin/1.2 (Macintosh; arm64)")).toEqual({
      browser: "Resentin",
      os: "macOS",
      deviceClass: "desktop",
    });
  });

  it("does NOT name an unrecognised BROWSER 'Mozilla'", () => {
    // The load-bearing guard. Every browser UA starts "Mozilla/5.0", so
    // without the not-Mozilla-shaped test the first product token of an
    // unknown Chromium fork is literally "Mozilla" — a confident wrong
    // answer, strictly worse than "Unknown browser".
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) NotAKnownFork/9.9";
    expect(parseUserAgent(ua).browser).toBe("Unknown browser");
  });

  it("still prefers a browser branch over the product token", () => {
    // Order guard: the allowlist runs first, so a Mozilla-shaped Firefox is
    // "Firefox" and never reaches the new branch.
    expect(parseUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Firefox/120.0").browser).toBe(
      "Firefox",
    );
  });

  it("rejects a product name carrying markup rather than sanitising it", () => {
    // The capture class is an ALLOWLIST, so `<` cannot survive into the name:
    // the token simply fails to match and we fall back. Rejecting at the
    // boundary beats emitting a scrubbed half-name.
    expect(parseUserAgent("Res<script>entin/1.0").browser).toBe("Unknown browser");
  });

  it("rejects a product name carrying a control character", () => {
    // Built rather than written as a literal escape: a raw control byte in a
    // source file turns it binary to grep and survives review unseen.
    const nul = String.fromCharCode(0);
    expect(parseUserAgent(`Resentin${nul}Evil/1.0`).browser).toBe("Unknown browser");
  });

  it("rejects a product name carrying whitespace before the version", () => {
    expect(parseUserAgent("Resentin Evil/1.0").browser).toBe("Unknown browser");
  });

  it("caps an absurdly long product name at 32 characters, ellipsis included", () => {
    const name = "A".repeat(200);
    const parsed = parseUserAgent(`${name}/1.0`);
    expect(parsed.browser).toBe(`${"A".repeat(31)}…`);
    expect(parsed.browser.length).toBe(32);
  });

  it("leaves a product name exactly at the cap untouched", () => {
    const name = "B".repeat(32);
    expect(parseUserAgent(`${name}/1.0`).browser).toBe(name);
  });
});

describe("userAgent.deviceClassIcon", () => {
  it("returns 💻 for desktop", () => {
    expect(deviceClassIcon("desktop")).toBe("\u{1F4BB}");
  });

  it("returns 📱 for mobile", () => {
    expect(deviceClassIcon("mobile")).toBe("\u{1F4F1}");
  });

  it("returns 📱 for tablet (same glyph as mobile by design)", () => {
    expect(deviceClassIcon("tablet")).toBe("\u{1F4F1}");
  });

  it("returns ❔ for unknown", () => {
    expect(deviceClassIcon("unknown")).toBe("❔");
  });
});

// #1682 — the ONE owner of the `Browser on OS` format. Before this it was
// composed by hand in two places (`push.ts` and `SettingsDrawer.tsx`), which
// is why the OS-suffix drop needed a home rather than a second copy.
describe("userAgent.deviceDisplayName", () => {
  it("prints `Browser on OS` when the OS is known", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(deviceDisplayName(parseUserAgent(ua))).toBe("Chrome on macOS");
  });

  it("drops the suffix entirely when the OS is unknown", () => {
    // "Resentin on Unknown OS" is noise; "Resentin" is what the reader
    // expects. The icon stays unknown — that axis is untouched.
    expect(deviceDisplayName(parseUserAgent("Resentin/1.2"))).toBe("Resentin");
  });

  it("keeps the suffix for a native client that DID place its OS", () => {
    expect(deviceDisplayName(parseUserAgent("Resentin/1.2 (Macintosh; arm64)"))).toBe(
      "Resentin on macOS",
    );
  });

  it("applies the same rule to an absent UA — no special case for empty", () => {
    // One rule, "OS unknown ⇒ no suffix", rather than a second branch that
    // would drift from the first the moment either is touched.
    expect(deviceDisplayName(parseUserAgent(null))).toBe("Unknown browser");
    expect(deviceDisplayName(parseUserAgent(""))).toBe("Unknown browser");
  });
});
