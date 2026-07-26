/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #430 — cicchetto declared only the vendor-prefixed
// `apple-mobile-web-app-capable` standalone opt-in; the standardised,
// unprefixed `mobile-web-app-capable` was absent. Chrome logs a deprecation
// warning for the apple-only shape and reads the unprefixed tag as the
// standard signal for standalone display mode. BOTH must ship: iOS Safari
// ignores the standard tag (and the manifest) for standalone chrome, so the
// apple- tag stays load-bearing on iOS; the standard tag covers non-Safari
// runtimes and silences the Chrome warning. Adding the standard tag is a
// no-op on iOS — a pure addition, never a replacement.
//
// SOURCE-LEVEL regression guard, mirroring ipadSafeArea.test.ts: jsdom and
// Playwright do not exercise PWA install/standalone launch, so we assert the
// meta wiring is PRESENT. A real Add-to-Home-Screen launch stays a dogfood
// check. readFileSync resolves against cwd (= cicchetto/, the vite root),
// same as ipadSafeArea.test.ts; the node type reference is scoped to this
// file so it does not widen ambient types for the browser-target src tree.
const indexHtml = readFileSync("index.html", "utf8");

// Return the `content` value of a `<meta name="NAME" ...>` tag, or undefined
// if the tag is absent. The leading `"` in `name="NAME"` anchors the match,
// so the standard `mobile-web-app-capable` lookup does NOT collide with the
// apple- prefixed tag that contains it as a substring.
function metaContent(name: string): string | undefined {
  const tag = indexHtml.match(new RegExp(`<meta\\s+name="${name}"[^>]*>`, "i"))?.[0];
  return tag?.match(/content="([^"]*)"/i)?.[1];
}

describe("#430 mobile-web-app-capable meta", () => {
  it("declares the standard mobile-web-app-capable=yes tag", () => {
    expect(metaContent("mobile-web-app-capable")).toBe("yes");
  });

  it("keeps the apple- prefixed tag (iOS Safari still needs it)", () => {
    // The standard tag is added ALONGSIDE, never as a replacement: iOS
    // Safari reads only the apple- tag for standalone chrome.
    expect(metaContent("apple-mobile-web-app-capable")).toBe("yes");
  });
});
