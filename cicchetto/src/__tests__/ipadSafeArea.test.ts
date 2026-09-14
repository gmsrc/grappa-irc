/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allRules, nestedRuleBodies, ruleBody, selectorList, themeCss } from "./helpers/themeCss";

// #205 — cicchetto as an installed PWA on iPadOS rendered its top chrome
// (settings cog included) UNDER the iOS status bar, clipped and
// non-interactive. Root cause: an iPad is WIDER than the 768px mobile
// breakpoint in BOTH orientations, so `isMobile()` is false and cic
// renders the DESKTOP `.shell` — but every piece of safe-area / dynamic-
// viewport handling in the stylesheet was scoped to the mobile shell
// (`@media (max-width: 768px)` / `.shell-mobile`). The desktop `.shell`
// shipped `height: 100vh` with ZERO insets, so under a `black-translucent`
// standalone status bar the shell's top edge landed inside the reserved
// status-bar zone where iOS swallows touches.
//
// SOURCE-LEVEL regression guards, not layout tests. Playwright
// chromium/webkit does NOT reproduce real iPadOS Safari safe-area/dvh
// physics, and jsdom resolves neither `env()` nor `dvh`. So we assert the
// wiring is PRESENT (viewport-fit, env() insets on the container, no bare
// clipping 100vh) — the actual on-device layout + the settings hit region
// MUST still be confirmed by a real-iPad dogfood. See #205.

// This test reads source files (vitest stubs `.css?raw` imports to empty,
// so `?raw` can't be used for the stylesheet). cicchetto is a browser-
// target project whose tsconfig `types` deliberately omits `@types/node`;
// the `/// <reference types="node" />` above scopes the Node types to this
// file alone rather than widening ambient types for the whole `src` tree.
// vitest runs on Node so readFileSync exists at runtime; relative paths
// resolve against cwd (= cicchetto/, the vite root). The stylesheet read +
// `ruleBody` extractor moved to helpers/themeCss.ts when #734/#735 needed
// the same guard.
const css = themeCss;
const indexHtml = readFileSync("index.html", "utf8");

describe("#205 iPad standalone-PWA safe area", () => {
  it("index.html viewport meta opts into viewport-fit=cover", () => {
    // Without `viewport-fit=cover` the `env(safe-area-inset-*)` values
    // resolve to 0 and every inset below is a no-op.
    const viewportMeta = indexHtml.match(/<meta\s+name="viewport"[^>]*>/i)?.[0];
    expect(viewportMeta).toBeTruthy();
    expect(viewportMeta).toMatch(/viewport-fit=cover/);
  });

  it("desktop .shell carries all four safe-area insets", () => {
    // The desktop shell is what an iPad renders (wider than 768px in both
    // orientations). Its OUTER box must sit inside the safe area so the
    // top chrome (settings cog) clears the status bar and stays tappable.
    // Left/right matter in landscape where the home-indicator + camera
    // housing eat the side gutters.
    //
    // #1751 moved the spelling to the `:root` tokens (one `env()` per edge,
    // there and nowhere else). The claim is unchanged — this container carries
    // all four insets — only the vector is the token now.
    const body = ruleBody(".shell");
    expect(body).toMatch(/padding-top:\s*var\(--safe-area-inset-top\)/);
    expect(body).toMatch(/padding-bottom:\s*var\(--safe-area-inset-bottom\)/);
    expect(body).toMatch(/padding-left:\s*var\(--safe-area-inset-left\)/);
    expect(body).toMatch(/padding-right:\s*var\(--safe-area-inset-right\)/);
  });

  it("desktop .shell height is dynamic-viewport, not a bare clipping 100vh", () => {
    // `100vh` resolves to the iOS LAYOUT viewport (taller than the visible
    // area), overflowing the shell and clipping the bottom; `100dvh`
    // tracks the visible viewport. The `@supports not (dvh)` fallback may
    // still name `100vh`, but the primary declaration must be dynamic.
    const body = ruleBody(".shell");
    expect(body).toMatch(/height:\s*100dvh/);
    expect(body).not.toMatch(/height:\s*100vh\b/);
  });

  it("base .shell-members carries NO safe-area insets (relocated to mobile)", () => {
    // The desktop members aside is a grid CHILD of the now-inset `.shell`,
    // so it must NOT re-inset or it double-counts the top status-bar
    // height (members column shoved down 2× while sidebar + main sit
    // flush). Reintroducing `env()` here silently returns the #205
    // double-inset regression — guard against it. `ruleBody` anchors to
    // column 0, so it captures the BASE rule, not the indented mobile
    // override.
    //
    // Both spellings, since #1751: an `env()` here and a `var(--safe-area-…)`
    // here are the same double-count, and pinning only the older one would
    // leave this guard passing over exactly the edit it exists to stop. This
    // is also the rule that keeps `.rail-radio-picker` correct — the picker is
    // abspos `inset: 0` against this aside, so an inset landing here reaches
    // it too (#1751 declined to put one on the picker for the mirror reason).
    const body = ruleBody(".shell-members");
    expect(body).not.toMatch(/env\(safe-area-inset-/);
    expect(body).not.toMatch(/var\(--safe-area-inset-/);
  });

  it("mobile .shell-members (the fixed drawer) keeps its own safe-area insets", () => {
    // The mobile members drawer is `position: fixed` — it escapes
    // `.shell`'s container padding box, so it genuinely needs its own
    // insets. These were RELOCATED from the base rule; assert they landed
    // in the `@media (max-width: 768px)` override (indented, so matched by
    // substring, not `ruleBody`'s column-0 anchor). Both top and the
    // 1.5rem-floored bottom must survive the move.
    // #1751 — the TOP arm moved from `padding-top` to `top` (+ a compensating
    // `height`). Not cosmetic: padding does not move a container's abspos
    // descendants, so the padded form left `.rail-radio-picker` under the
    // notch. The claim here is unchanged — the fixed drawer owns its own top
    // clearance — only the property carrying it moved.
    expect(css).toMatch(
      /@media[^{]*\(max-width: 768px\)[\s\S]*\.shell-members\s*\{[\s\S]*?top:\s*var\(--safe-area-inset-top\)/,
    );
    expect(css).toMatch(
      /\.shell-members\s*\{[\s\S]*?padding-bottom:\s*max\(1\.5rem,\s*var\(--safe-area-inset-bottom\)\)/,
    );
  });
});

// #1127 — the mobile shell's bottom edge. The guards above pin `.shell`
// (desktop / iPad) and never mention `.shell-mobile`, so flipping the
// mobile bottom edge used to land green either way. Same caveat as #205:
// SOURCE-level, because jsdom resolves no `env()` and desktop Chrome
// reports every inset as 0 — the on-device look still needs a real
// notched iPhone.
describe("#1127 mobile shell bottom edge", () => {
  it(".shell-mobile declares exactly one bottom edge, and it is 0", () => {
    // One assertion over the whole declaration list, deliberately: it has
    // to kill three different regressions at once. Restoring the inset
    // (`env(safe-area-inset-bottom)`) reopens the black band the issue was
    // filed for. DELETING the declaration is just as wrong and far more
    // tempting — base `.shell` declares the same property at the same
    // specificity and the element carries both classes, so an absent
    // longhand here means the inset cascades straight back in. And a
    // second declaration appended after the `0` would silently win.
    const declared = [
      ...nestedRuleBodies(".shell-mobile")
        .join("\n")
        .matchAll(/padding-bottom:\s*([^;]+);/g),
    ].map((m) => (m[1] ?? "").trim());
    expect(declared).toEqual(["0"]);
  });

  it(".shell-mobile keeps the top / left / right insets", () => {
    // Bottom edge only. The top inset clears the status bar and keeps the
    // chrome tappable (UX-3 BIS); the sides matter in the sub-768 landscape
    // edge on small notched devices.
    const body = nestedRuleBodies(".shell-mobile").join("\n");
    expect(body).toMatch(/padding-top:\s*var\(--safe-area-inset-top\)/);
    expect(body).toMatch(/padding-left:\s*var\(--safe-area-inset-left\)/);
    expect(body).toMatch(/padding-right:\s*var\(--safe-area-inset-right\)/);
  });
});

// issue 2163 — the DESKTOP shell's bottom edge, in a fullscreen iPad PWA.
// The #1127 block above cured this on `.shell-mobile`; the desktop shell is
// what an iPad actually renders (#205), and it never got the same treatment.
//
// The mechanism is one step removed from "the shell is lifted off the bottom",
// and the difference decides the shape of the cure: with the global
// `box-sizing: border-box`, `height: 100dvh` puts the shell's BORDER box on
// the physical bottom edge and `padding-bottom` shrinks only the CONTENT box.
// So the shell is not lifted — its bottom `var(--safe-area-inset-bottom)` is a
// TRANSPARENT strip (`.shell` declares no background of its own) through which
// `body { background: var(--bg) }` shows. A band appears under every column
// whose own bottom-most painter is not `--bg`.
//
// The cure is PAINT, not spacing: each such painter extends its own background
// through the strip with an OUTER box-shadow. Nothing moves, which is the
// whole point — the two alternatives both move a box and both are fenced by a
// prior measured ruling. Widening an aside's box carries `.rail-radio-picker`
// (abspos `inset: 0` against `.shell-members`) into the home-indicator gesture
// strip, which is #1751's measurement. Putting the inset on `.compose-box`
// re-opens #1127's D11 on the SHARED mobile shell, where iOS reports the inset
// against the DEVICE while the soft keyboard shrinks the visual viewport.
//
// SOURCE-level guards, the same limit #205 and #1127 record: jsdom resolves no
// `env()` and Playwright/webkit reports every inset as 0, so no runner reachable
// from here can see the real geometry. What IS checkable here is the property
// the cure rests on — that each painter's extender carries that painter's OWN
// colour, by exactly the container's own inset, and moves nothing.
const BOTTOM_PAINTERS = [
  // Both asides, in every window kind. `.shell-sidebar` additionally proves the
  // choice of box-shadow over an `::after`: the sidebar is `overflow-y: auto`,
  // which would clip an absolutely-positioned pseudo-element child, while an
  // element's own overflow never clips its own outer shadow.
  { painter: ".shell-sidebar", extender: ".shell:not(.shell-mobile) > .shell-sidebar" },
  { painter: ".shell-members", extender: ".shell:not(.shell-mobile) > .shell-members" },
  // The main column's bottom-most painter varies by window kind (Shell.tsx's
  // <Switch>), and only these two paint anything other than `--bg`: measured,
  // `.compose-box` and `.admin-pane` are both `var(--bg)` — the SAME colour as
  // the strip, so those windows show no band at all — and `.mentions-window`
  // and `.directory-pane` declare no background.
  { painter: ".home-pane", extender: ".shell:not(.shell-mobile) .home-pane" },
  { painter: ".crt-splash", extender: ".shell:not(.shell-mobile) .crt-splash" },
] as const;

/** The single rule carrying `selector` in its list. Throws if absent or split. */
function extenderRuleBody(selector: string): string {
  const matched = allRules().filter((rule) => selectorList(rule.selectors).includes(selector));
  if (matched.length !== 1) {
    throw new Error(`expected exactly 1 rule for \`${selector}\`, found ${matched.length}`);
  }
  return matched[0]?.body ?? "";
}

/** The property names a rule body declares, in source order. */
function declaredProperties(body: string): string[] {
  return body
    .split(";")
    .map((declaration) => declaration.split(":")[0]?.trim() ?? "")
    .filter((property) => property.length > 0);
}

describe("issue 2163 desktop shell bottom edge", () => {
  it("every desktop bottom-most painter extends its OWN background through the inset", () => {
    for (const { painter, extender } of BOTTOM_PAINTERS) {
      // The expected colour is READ from the painter's own rule rather than
      // written down here, so re-theming an element without re-theming its
      // extender is a red — a hardcoded `var(--bg-alt)` would keep passing
      // while the band came back in the new colour.
      const background = /background:\s*([^;]+);/.exec(ruleBody(painter))?.[1]?.trim();
      expect(background, `${painter} declares no background`).toBeTruthy();

      const shadow = /box-shadow:\s*([^;]+);/.exec(extenderRuleBody(extender))?.[1]?.trim();
      expect(shadow, `${extender} declares no box-shadow`).toBeTruthy();

      // Split on plain whitespace: every token in this value (`0`, a `var()`
      // with no argument list, a hex literal) is space-free, so no top-level
      // splitter is needed. Compared as an exact 4-tuple — offset-x 0,
      // offset-y the container's own inset token, blur 0 (a blurred edge would
      // read as a gradient seam), colour the painter's own. A literal `20px`
      // in place of the token is a red: the inset is 20px on ONE device.
      expect(shadow?.split(/\s+/), `${extender} shadow shape`).toEqual([
        "0",
        "var(--safe-area-inset-bottom)",
        "0",
        background,
      ]);
    }
  });

  it("the container keeps the bottom inset that buys the interactive clearance", () => {
    // The other half of the outcome, and the reason the cure is not "delete
    // the inset": the 20px keeps the compose row (and the rail's bottom
    // buttons) out of the home-indicator gesture strip.
    //
    // #205's "desktop .shell carries all four safe-area insets" asserts this
    // same declaration, deliberately re-pinned here: that guard exists for the
    // TOP edge's status-bar clearance and would be rewritten wholesale if the
    // top chrome ever changed. This one owns the bottom edge, so the pair
    // "paint reaches the edge AND clearance survives" cannot be half-deleted.
    expect(ruleBody(".shell")).toMatch(/padding-bottom:\s*var\(--safe-area-inset-bottom\)/);
  });

  it("the extenders are paint only — they declare no box-model property", () => {
    // This is what keeps #1751 and #1127's D11 closed, and it is why the
    // "base .shell-members carries NO safe-area insets" guard above is not
    // being routed around: that guard forbids the aside from taking a LAYOUT
    // inset (which would double-count, and would drag the abspos rail picker
    // with it). A box-shadow occupies no space and moves no descendant. An
    // exact list, not a `not.toMatch`: anything at all creeping into these
    // rules has to be looked at.
    for (const { extender } of BOTTOM_PAINTERS) {
      expect(declaredProperties(extenderRuleBody(extender)), extender).toEqual(["box-shadow"]);
    }
  });
});
