import { describe, expect, it } from "vitest";
import { ruleBody, themeCss } from "./helpers/themeCss";

// #462 — "no small controls in the settings drawer", as a rule rather than as
// a list of patched instances.
//
// `:where(.settings-drawer) button` (the #735 base) already declares the 44px
// floor, the drawer's --font-size and a comfortable padding — but it sits at
// (0,0,1), so ANY control class that declares its own padding or font-size
// out-specifies it and shrinks. #43 and #282 each noticed this on one button
// and patched that button; the ones nobody had open at the time stayed
// compact. These guards are on the CLASS: a shared rule that carries the
// shape, and per-instance rules that no longer re-declare it.
//
// jsdom applies no stylesheet, so this reads the source. It proves what the
// cascade is asked to do, never what a browser paints.

function declares(body: string, property: string): boolean {
  return new RegExp(`(^|;)\\s*${property}\\s*:`, "m").test(body);
}

// A per-instance class with no delta left carries no rule at all; "absent" and
// "present but declaring nothing shared" are the same pass. (Borrowed from
// sharedButtonRules.test.ts, which guards the same defect shape.)
function deltaBody(selector: string): string {
  try {
    return ruleBody(selector);
  } catch {
    return "";
  }
}

describe("#462 — the drawer's inline-confirm buttons share ONE size", () => {
  it("declares the full-size shape once, on the drawer-scoped rule", () => {
    const shared = ruleBody(".settings-drawer .inline-confirm-btn");
    expect(declares(shared, "padding")).toBe(true);
    expect(declares(shared, "font-size")).toBe(true);
  });

  it.each([".settings-drawer .inline-confirm-btn.vhost-reconnect"])(
    "%s no longer re-declares the shared shape or paint",
    (selector) => {
      const body = deltaBody(selector);
      for (const property of ["padding", "font-size", "color", "border-color"]) {
        expect(declares(body, property), `${selector} must not re-declare ${property}`).toBe(false);
      }
    },
  );

  it("paints the idle button accent, and only while it is idle", () => {
    // The `:not(.confirming)` is load-bearing, not decoration. The rule it
    // replaces (`.settings-drawer .inline-confirm-btn.vhost-reconnect`, three
    // classes = 0,3,0) OUT-SPECIFIED `.inline-confirm-btn.confirming` (0,2,0),
    // so the armed red never reached that button however the source was
    // ordered — its own comment claimed otherwise. Scoping the idle paint away
    // from `.confirming` is what gives the armed state back.
    expect(ruleBody(".settings-drawer .inline-confirm-btn:not(.confirming)")).toMatch(
      /color:\s*var\(--accent\)/,
    );
    expect(ruleBody(".inline-confirm-btn.confirming")).toMatch(/color:\s*#c00/);
  });

  it("leaves no drawer rule able to out-specify the armed red", () => {
    // Anything more specific than (0,2,0) that declares `color` on a
    // `.inline-confirm-btn` and does NOT exclude `.confirming` silently kills
    // the two-tap confirmation's only visible signal. That is the bug this
    // issue found; the guard is that it cannot come back by another name.
    const offenders = [...themeCss.matchAll(/^([^{}\n]*\.inline-confirm-btn[^{}\n]*)\{([^}]*)\}/gm)]
      .map(([, selector, body]) => ({ selector: selector ?? "", body: body ?? "" }))
      .filter(
        ({ selector, body }) =>
          !selector.includes(".confirming") &&
          /(^|;)\s*color\s*:/m.test(body.replace(/\/\*[\s\S]*?\*\//g, "")),
      )
      .map(({ selector }) => selector.trim());
    expect(offenders).toEqual([".inline-confirm-btn"]);
  });
});

describe("#462 — every remaining drawer control clears the tap floor", () => {
  it("gives the header × a real tap target", () => {
    const body = ruleBody(".settings-drawer-close");
    expect(body).toMatch(/min-height:\s*var\(--tap-min\)/);
    expect(body).toMatch(/min-width:\s*var\(--tap-min\)/);
  });

  it("stops the device-remove button from opting out of the base", () => {
    const body = deltaBody(".settings-drawer .device-remove");
    expect(declares(body, "padding")).toBe(false);
    expect(declares(body, "font-size")).toBe(false);
  });

  it("gives <select> the same floor <button> and <input> already have", () => {
    // #735 covered <button>, #497/#508 covered <input>/<textarea>. <select>
    // had no base rule anywhere in the sheet, so the drawer's three pickers
    // (identity network, upload retention, mute) rendered at UA default.
    const body = ruleBody(":where(.settings-drawer) select");
    expect(body).toMatch(/min-height:\s*var\(--tap-min\)/);
    expect(body).toMatch(/font-size:\s*var\(--font-size\)/);
  });
});

describe("#462 — the identity editor has a layout", () => {
  it("stacks the label/field pairs", () => {
    const body = ruleBody(".settings-identity");
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
  });

  it("stretches its controls to the card instead of leaving them at UA width", () => {
    // #497/#508 already gave the fields their height, face and font — what
    // was missing was width: an <input> with no width rule keeps its ~20ch
    // intrinsic size inside a 22rem drawer.
    expect(ruleBody(".settings-identity :where(input, select)")).toMatch(/width:\s*100%/);
  });
});
