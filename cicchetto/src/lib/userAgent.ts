// UX-4 bucket L (2026-05-19) — minimal UA-string parser.
//
// SettingsDrawer's device list rendered the raw `user_agent` string
// from the server (e.g. "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)
// AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
// — visually noisy, blew the drawer width on long modern strings (iOS
// Safari + UA-CH brand strings can hit 200+ chars). Bucket L replaces
// the raw string with a device-class icon + short parsed name like
// "💻 Chrome on macOS" or "📱 Safari on iOS".
//
// KISS: regex-based parser, no external dep (ua-parser-js is ~100KB
// minified — overkill for a 9-field device list). Covers the common
// browsers + platforms; falls back to "Unknown browser" / "Unknown OS"
// on misses. Misclassification of a niche UA is benign (the icon +
// name are informational; the unique device id is the row's
// load-bearing identity).
//
// Pattern order matters: Edge UA contains "Chrome" + "Safari" + "Edg"
// — we check Edg first. iOS Chrome contains "CriOS" not "Chrome" —
// check CriOS first. Match the most specific brand wins.
//
// #1682 (2026-08-23) — the allowlist above only ever knew BROWSERS, so
// every third-party native client (a self-hoster's `Resentin/1.2`, the
// native Android shell of #1193) rendered as "Unknown browser". The cure
// is a product-token branch that runs LAST, after every brand branch:
// see `detectProductName`. It is deliberately not an entry per client —
// an allowlist that has to grow once per client is the defect, not the
// gap in it.

export type DeviceClass = "desktop" | "mobile" | "tablet" | "unknown";

export type ParsedUserAgent = {
  browser: string;
  os: string;
  deviceClass: DeviceClass;
};

// One literal each, one owner: `deviceDisplayName` compares against
// UNKNOWN_OS to decide whether the ` on <os>` suffix is worth printing,
// and a second spelling of either string would silently break that test.
const UNKNOWN_BROWSER = "Unknown browser";
const UNKNOWN_OS = "Unknown OS";

const UNKNOWN: ParsedUserAgent = {
  browser: UNKNOWN_BROWSER,
  os: UNKNOWN_OS,
  deviceClass: "unknown",
};

// Device-class icon — single character so it fits in tight lists.
// Tablet falls back to mobile glyph (no distinct mid-size emoji that
// renders consistently across browsers).
export const deviceClassIcon = (cls: DeviceClass): string => {
  switch (cls) {
    case "desktop":
      return "\u{1F4BB}"; // 💻
    case "mobile":
      return "\u{1F4F1}"; // 📱
    case "tablet":
      return "\u{1F4F1}"; // 📱 (same glyph as mobile)
    case "unknown":
      return "❔"; // ❔
  }
};

// Every browser UA on earth opens with "Mozilla/5.0" for historical
// reasons, so a UA of that shape which matched none of the brand
// branches is an unrecognised BROWSER, not a native client — and its
// first product token is the literal string "Mozilla". Naming it that
// would be a confident wrong answer, which is strictly worse than
// admitting we do not know.
const MOZILLA_SHAPED = /^Mozilla\//;

// RFC 9110 §10.1.5: `User-Agent = product *( RWS ( product / comment ) )`
// and `product = token "/" product-version`. We take the FIRST product,
// which is the one naming the client itself.
//
// The capture class is an ALLOWLIST, and that is the whole sanitisation
// story: the name comes from an attacker-controlled request header and
// is rendered in the drawer, so rather than scrub afterwards we simply
// cannot capture a control character, a quote, an angle bracket, an
// ampersand or whitespace — none of them are in the class, so a UA
// carrying them fails to match and falls back. Rejecting at the
// boundary beats emitting a mangled half-name. (Solid escapes text
// nodes anyway; this holds the line one layer earlier, where the
// closed set is actually expressible.)
const PRODUCT_TOKEN = /^([A-Za-z0-9][A-Za-z0-9._+-]*)\/[\d.]+/;

// The remaining unbounded axis is length, so it gets the one cap.
// 32 is ~2.3x the longest product token that actually ships in the wild
// ("SamsungBrowser" / "HeadlessChrome", 14), so no real client is ever
// truncated, while the row stays inside a drawer whose width was the
// original reason (see the header) this module exists at all. The class
// above is ASCII-only, so `.length` counts characters and `slice` cannot
// split a surrogate pair. The ellipsis is not decoration: without it a
// truncated name reads as a genuine product name.
const MAX_PRODUCT_NAME = 32;

const detectProductName = (ua: string): string | null => {
  if (MOZILLA_SHAPED.test(ua)) return null;
  const match = PRODUCT_TOKEN.exec(ua);
  const name = match?.[1];
  if (name === undefined) return null;
  return name.length > MAX_PRODUCT_NAME ? `${name.slice(0, MAX_PRODUCT_NAME - 1)}…` : name;
};

const detectBrowser = (ua: string): string => {
  // Order: most specific first. Edg / OPR / CriOS / FxiOS all
  // embed substrings from upstream Chrome/Safari.
  if (/\bEdg\/[\d.]+/.test(ua)) return "Edge";
  if (/\bOPR\/[\d.]+/.test(ua)) return "Opera";
  if (/\bCriOS\/[\d.]+/.test(ua)) return "Chrome";
  if (/\bFxiOS\/[\d.]+/.test(ua)) return "Firefox";
  if (/\bFirefox\/[\d.]+/.test(ua)) return "Firefox";
  if (/\bChrome\/[\d.]+/.test(ua)) return "Chrome";
  if (/\bSafari\/[\d.]+/.test(ua) && /Version\/[\d.]+/.test(ua)) return "Safari";
  // #1682 — LAST, and only here: a brand branch must always win, or Edge
  // and Opera break (see the header).
  return detectProductName(ua) ?? UNKNOWN_BROWSER;
};

const detectOs = (ua: string): string => {
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Windows NT/.test(ua)) return "Windows";
  if (/X11.*Linux|Linux x86_64|Linux i686/.test(ua)) return "Linux";
  if (/CrOS/.test(ua)) return "ChromeOS";
  return UNKNOWN_OS;
};

const detectDeviceClass = (ua: string): DeviceClass => {
  if (/iPad/.test(ua)) return "tablet";
  if (/Tablet/i.test(ua)) return "tablet";
  if (/iPhone|iPod|Android.*Mobile|Mobile.*Android/.test(ua)) return "mobile";
  // Android-without-Mobile suggests a tablet UA in some Android versions
  if (/Android/.test(ua)) return "tablet";
  if (/Mac OS X|Macintosh|Windows NT|Linux|CrOS/.test(ua)) return "desktop";
  return "unknown";
};

/**
 * The ONE owner of the displayed device name.
 *
 * `${browser} on ${os}` (e.g. "Chrome on macOS") when we placed the OS,
 * and the bare browser otherwise. Consumers pair it with
 * `deviceClassIcon(p.deviceClass)` to render a chip like
 * "💻 Chrome on macOS".
 *
 * ## Why the suffix is DROPPED rather than printed as "on Unknown OS"
 *
 * A native client typically sends no platform token at all, so the old
 * format produced "Resentin on Unknown OS" — a sentence whose second
 * half carries no information and reads as a parser failure. "Resentin"
 * is what the reader expects (minimum surprise). The device-class icon
 * still shows ❔, so nothing is being hidden: the unknown-ness moved to
 * the axis that can express it in one glyph instead of three words.
 *
 * ONE rule, "OS unknown ⇒ no suffix", with no exception for a UA that is
 * absent rather than merely unrecognised — an absent UA prints "Unknown
 * browser", not "Unknown browser on Unknown OS". A second branch for the
 * empty case would be a second rule, free to drift from the first.
 *
 * ## Why this is a function and not a template literal at the call site
 *
 * #1682: it WAS a template literal at the call site, in two of them
 * (`push.ts` and `SettingsDrawer.tsx`), written out by hand. In `push.ts`
 * that string is not merely display — it is the GROUPING KEY the `#1`/`#2`
 * ordinals are derived from (see `deviceRows`). Had the suffix been
 * dropped at one site only, the key would have stopped being the thing
 * the user reads, which is the property that whole design rests on.
 */
export const deviceDisplayName = (parsed: ParsedUserAgent): string =>
  parsed.os === UNKNOWN_OS ? parsed.browser : `${parsed.browser} on ${parsed.os}`;

/**
 * Parses a UA string into `{browser, os, deviceClass}`. Returns
 * UNKNOWN-shaped placeholder for null/empty inputs.
 *
 * Render the result through `deviceDisplayName`, which owns the format;
 * do not compose `browser` and `os` by hand.
 */
export const parseUserAgent = (ua: string | null | undefined): ParsedUserAgent => {
  if (ua === null || ua === undefined || ua === "") return UNKNOWN;
  return {
    browser: detectBrowser(ua),
    os: detectOs(ua),
    deviceClass: detectDeviceClass(ua),
  };
};
