// Contract under test: issue 2190 — the iOS/iPadOS 27 compositor-band gate.
//
// One file, deliberately, for the same reason the production code is one
// block: this is a PORKAROUND (vjt, #grappa 2026-09-15 16:18 «porkaround per
// ora, magari da rimuovere in seguito») and deleting it must be a revert, not
// an archaeology exercise. When the band goes, this file goes with it.
//
// WHAT WOULD MAKE THIS TEST WORTHLESS: passing on any UA at all. So the shape
// is a DEVICE TABLE with the expectation written per row, and the rows are
// chosen so that each half of the parser owns some of them:
//
//   * rows 1, 2, 5 and 11 carry BOTH signals, agreeing on the same major;
//   * row 9 carries ONLY the `OS <n>_<n> like Mac OS X` shape (underscores,
//     and the iPad spelling drops the device word) — the installed-PWA UA,
//     which is the configuration this entire gate targets;
//   * rows 3, 4 and 7 carry ONLY `Version/<n>`, the version signal on the
//     iPadOS-desktop-mode UA, which says `Macintosh` and has no `iPad` token;
//   * rows 6, 8 and 10 carry no iOS version signal in either shape.
//
// Rows 4 and 7 are the SAME USER-AGENT STRING, byte for byte. An iPad in
// desktop mode and a real Mac are told apart by `navigator.maxTouchPoints`
// alone — that is why `isIos()` carries its `Mac` + touch clause, and why the
// parser deliberately does not pretend to answer "is this Apple mobile?".
//
// Mutation check that this table actually discriminates (run by hand, recorded
// in the issue-2190 report). Each clause of the parser owns rows no other
// clause can cover, so each one falls alone:
//   * drop the `Version/` alternative  → rows 3, 4 and 7 fail, and ONLY those;
//   * drop the `OS … like Mac OS X` one → row 9 fails, and ONLY that one.
// If everything falls, or nothing does, the table is a mirror and not a
// measurement.

import { afterEach, describe, expect, it } from "vitest";
import {
  applyIos27BandClass,
  hasIos27Band,
  IOS27_BAND_CLASS,
  iosMajorVersion,
} from "../lib/platform";
import {
  resetPlatformStubs,
  stubMatchMedia,
  stubMaxTouchPoints,
  stubUserAgent,
} from "./helpers/platformStubs";
import { allRules, ruleBody, selectorList } from "./helpers/themeCss";

afterEach(() => {
  resetPlatformStubs();
  document.documentElement.classList.remove(IOS27_BAND_CLASS);
});

// The iPadOS-desktop-mode UA. Named once because rows 4 and 7 must be the
// same bytes — spelling it twice would let the two drift and quietly turn the
// "only maxTouchPoints separates them" row pair into two unrelated cases.
const MAC_SHAPED_UA_27 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15";

type DeviceRow = {
  /** Row label, printed by `it.each`. */
  readonly name: string;
  readonly ua: string;
  /** What `isIos()`'s desktop-mode clause reads. jsdom's baseline is 0. */
  readonly maxTouchPoints: number;
  /** Installed PWA? The band is PWA chrome — Safari in a tab must not pay. */
  readonly standalone: boolean;
  /** Expected `iosMajorVersion(ua)`. */
  readonly major: number | null;
  /** Expected `hasIos27Band()`. */
  readonly band: boolean;
};

const DEVICES: readonly DeviceRow[] = [
  {
    name: "1. iPhone, iOS 26, installed PWA — below the band's first major",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
    maxTouchPoints: 5,
    standalone: true,
    major: 26,
    band: false,
  },
  {
    name: "2. iPhone, iOS 27, installed PWA — the reported device",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
    maxTouchPoints: 5,
    standalone: true,
    major: 27,
    band: true,
  },
  {
    name: "3. iPad in desktop mode, iPadOS 26, installed PWA — Version/ is the only signal",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    maxTouchPoints: 5,
    standalone: true,
    major: 26,
    band: false,
  },
  {
    name: "4. iPad in desktop mode, iPadOS 27, installed PWA — the device morph reported second",
    ua: MAC_SHAPED_UA_27,
    maxTouchPoints: 5,
    standalone: true,
    major: 27,
    band: true,
  },
  {
    name: "5. iPad in mobile mode, iPadOS 27, installed PWA — `CPU OS`, no device word",
    ua: "Mozilla/5.0 (iPad; CPU OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
    maxTouchPoints: 5,
    standalone: true,
    major: 27,
    band: true,
  },
  {
    name: "6. Android Chrome, installed PWA — standalone and touch, but not Apple",
    ua: "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
    maxTouchPoints: 5,
    standalone: true,
    major: null,
    band: false,
  },
  {
    name: "7. macOS Safari 27 — byte-identical UA to row 4, told apart by maxTouchPoints alone",
    ua: MAC_SHAPED_UA_27,
    maxTouchPoints: 0,
    standalone: false,
    major: 27,
    band: false,
  },
  {
    name: "8. Windows desktop Chrome — no version signal in either shape",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    maxTouchPoints: 0,
    standalone: false,
    major: null,
    band: false,
  },
  {
    // NOT a hypothetical shape: iOS home-screen web apps have dropped the
    // `Version/` and `Safari/` tokens since the feature existed, and a
    // home-screen web app is the ONLY configuration this whole gate targets.
    // So on the phone the band fires off the OS-shaped clause and off
    // nothing else, which is also what makes that clause falsifiable here:
    // every other iPhone row carries BOTH signals agreeing on the same major.
    name: "9. iPhone, iOS 27, installed PWA UA — no `Version/` token at all",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    maxTouchPoints: 5,
    standalone: true,
    major: 27,
    band: true,
  },
  {
    // 🔴 THE KNOWN GAP, asserted so it is visible rather than discovered.
    // If iPadOS strips `Version/` from the standalone UA the same way iOS
    // does, the desktop-mode shape is left with NO version signal whatsoever
    // — `Intel Mac OS X 10_15_7` is the frozen lie every such UA carries —
    // and the iPad half of the cure never fires. We own no iOS 27 device and
    // no recorded iPadOS standalone UA, in this tree or anywhere we can
    // reach, so this row states what the code DOES (nothing), not what the
    // platform does. It is the second thing to ask morph for, next to the
    // screenshot: `navigator.userAgent` read inside the installed PWA on the
    // iPad. If it keeps `Version/27.0`, row 4 covers reality and this row is
    // unreachable; if it does not, this gate needs another signal and there
    // may not be one.
    name: "10. iPad desktop-mode, installed PWA, `Version/` stripped — KNOWN GAP, does not fire",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
    maxTouchPoints: 5,
    standalone: true,
    major: null,
    band: false,
  },
  {
    name: "11. iPhone, iOS 27, Safari TAB — the standalone half of the gate, on its own",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
    maxTouchPoints: 5,
    standalone: false,
    major: 27,
    band: false,
  },
];

function stubDevice(row: DeviceRow): void {
  stubUserAgent(row.ua);
  stubMaxTouchPoints(row.maxTouchPoints);
  stubMatchMedia(row.standalone);
}

describe("iosMajorVersion — the parser, both UA shapes", () => {
  it.each(DEVICES)("$name", (row) => {
    expect(iosMajorVersion(row.ua)).toBe(row.major);
  });

  it("returns null rather than a number for a UA it cannot read", () => {
    expect(iosMajorVersion("")).toBe(null);
    expect(iosMajorVersion("Resentin/1.2")).toBe(null);
  });

  it("reads a two-digit major, not the first digit of it", () => {
    // The guard against `OS (\d)` — iOS 9 shipped, and a parser that stops at
    // one digit reads 27 as 2 and the gate never fires again.
    expect(
      iosMajorVersion("Mozilla/5.0 (iPhone; CPU iPhone OS 9_3_5 like Mac OS X) Version/9.0"),
    ).toBe(9);
    expect(
      iosMajorVersion("Mozilla/5.0 (iPhone; CPU iPhone OS 127_0 like Mac OS X) Version/127.0"),
    ).toBe(127);
  });
});

describe("hasIos27Band — the composed gate", () => {
  it.each(DEVICES)("$name", (row) => {
    stubDevice(row);
    expect(hasIos27Band()).toBe(row.band);
  });

  it("a UA with no version signal does NOT satisfy the >= 27 comparison", () => {
    // Explicit because the JS coercion is a trap worth pinning rather than
    // trusting: `null >= 27` is false, but so is `undefined >= 27`, and a
    // reader cannot tell a deliberate guard from a lucky one.
    stubUserAgent("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile Safari/604.1");
    stubMaxTouchPoints(5);
    stubMatchMedia(true);
    expect(iosMajorVersion(navigator.userAgent)).toBe(null);
    expect(hasIos27Band()).toBe(false);
  });
});

describe("applyIos27BandClass — the <html> hook", () => {
  it.each(DEVICES)("$name", (row) => {
    stubDevice(row);
    applyIos27BandClass();
    expect(document.documentElement.classList.contains(IOS27_BAND_CLASS)).toBe(row.band);
  });

  it("is idempotent — boot may call it more than once and the class list stays one entry", () => {
    stubDevice(DEVICES[1] as DeviceRow);
    applyIos27BandClass();
    applyIos27BandClass();
    const classes = [...document.documentElement.classList].filter(
      (one) => one === IOS27_BAND_CLASS,
    );
    expect(classes).toHaveLength(1);
  });
});

// The CSS half. The clearance is a stylesheet rule, so what is pinnable here
// is the SOURCE: that the value is the reported 16px, that it is declared
// once, and — the property the ruling asks for in point 5 — that no rule
// reading it is reachable without the class. jsdom cascades none of this;
// the VISIBLE outcome is asserted in e2e (issue2190-ios27-band.spec.ts).
describe("the clearance rules are gated — no platform without the class pays", () => {
  it("declares the reported 16px exactly once, on the gating class", () => {
    expect(ruleBody(`html.${IOS27_BAND_CLASS}`)).toMatch(/--ios27-band-clearance:\s*16px;/);
  });

  it("the gated top padding is `.scrollback`'s OWN block padding plus the clearance", () => {
    // The `0.5rem` in the gated rule is a restatement — a padding cannot be
    // written as "whatever it was, plus". This is the pin that turns a drift
    // in the ungated shorthand into a red instead of a 16px that silently
    // becomes 12 or 24.
    const shorthand = /(?:^|;)\s*padding:\s*([^;]+);/.exec(ruleBody(".scrollback"))?.[1];
    expect(shorthand).toBeDefined();
    const block = (shorthand ?? "").trim().split(/\s+/)[0];
    expect(block).toBeDefined();
    const gated = ruleBody(`html.${IOS27_BAND_CLASS} .scrollback`);
    expect(gated).toContain(`padding-top: calc(${block} + var(--ios27-band-clearance));`);
    expect(gated).toContain("scroll-padding-top: var(--ios27-band-clearance);");
  });

  it("every rule that mentions the clearance token carries the class in EVERY selector", () => {
    const readers = allRules().filter((rule) => rule.body.includes("--ios27-band-clearance"));
    // Positive control: the census is only worth reading if it found the
    // rules at all. A typo'd token name would otherwise pass vacuously.
    expect(readers.length).toBeGreaterThan(1);
    for (const rule of readers) {
      for (const one of selectorList(rule.selectors)) {
        expect(one).toContain(IOS27_BAND_CLASS);
      }
    }
  });
});
