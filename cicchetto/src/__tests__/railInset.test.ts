// #1802 — the source-level half of "solve it once and for all".
//
// WHAT THIS GUARDS AND WHAT IT CANNOT. The ruling has three constraints: the
// rail carries the horizontal inset, the members scrollbar keeps running on
// the rail's edge, and the rule that buys the second one lives in the
// CONTAINER's rules rather than the child's. The second is GEOMETRY and is
// asserted where geometry lives — `e2e/tests/issue1802-rail-inset-container.
// spec.ts`, in a real engine. The first and third are about WHERE A VALUE IS
// DECLARED, which no rendered measurement can see: a child that re-declares
// the same 0.5rem by hand lands on the identical pixel and reads green
// forever, right up until the token changes and the two drift. That is the
// failure mode #1737 shipped and #1802 is closing, so it needs a reader of the
// SOURCE, and this is it.
//
// NOT A MIRROR OF THE STYLESHEET. None of the three tests below names the
// rules the fix added; they name properties no rule may carry and a scope
// every reference must be inside. The fix is one way to satisfy them, not the
// only one — rewrite the rail's rules any way you like and these stay green as
// long as the ownership holds.

import { describe, expect, it } from "vitest";
import { allRules, selectorList } from "./helpers/themeCss";

const CONTAINER = ".shell-members";
const TOKEN = "--rail-inset";

/**
 * Split a CSS value on top-level whitespace. `calc(-1 * var(--rail-inset))` is
 * ONE value with two spaces inside it, so a naive `split(/\s+/)` would read it
 * as three and take the wrong one as the horizontal component.
 */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (depth === 0 && /\s/.test(ch)) {
      if (current !== "") parts.push(current);
      current = "";
    } else current += ch;
  }
  if (current !== "") parts.push(current);
  return parts;
}

/**
 * The HORIZONTAL components a single declaration contributes, or `[]` when it
 * contributes none. Shorthands are expanded by arity the way the cascade does
 * it (1 → all, 2 → `block inline`, 3 → `top inline bottom`, 4 → clockwise), so
 * a `padding: 0.25rem 1rem` is caught and a `padding-block: 0.25rem` is not.
 */
function horizontalComponents(property: string, value: string): string[] {
  const parts = splitTopLevel(value);
  const [p0, p1, p2, p3] = parts;
  if (property === "margin" || property === "padding") {
    if (parts.length === 1) return p0 === undefined ? [] : [p0];
    if (parts.length === 2 || parts.length === 3) return p1 === undefined ? [] : [p1];
    if (parts.length === 4) {
      return p1 !== undefined && p3 !== undefined ? [p1, p3] : [];
    }
    return [];
  }
  if (property === "margin-inline" || property === "padding-inline") {
    return parts;
  }
  if (/^(margin|padding)-(left|right|inline-start|inline-end)$/.test(property)) {
    return parts.length === 0 ? [] : [parts.join(" ")];
  }
  // `-block`, `-top`, `-bottom`, and everything that is not a box inset.
  void p2;
  return [];
}

/** Every horizontal margin/padding component a rule body declares. */
function horizontalInsets(body: string): { property: string; component: string }[] {
  const out: { property: string; component: string }[] = [];
  for (const raw of body.split(";")) {
    const colon = raw.indexOf(":");
    if (colon === -1) continue;
    const property = raw.slice(0, colon).trim();
    const value = raw.slice(colon + 1).trim();
    for (const component of horizontalComponents(property, value)) {
      out.push({ property, component });
    }
  }
  return out;
}

const isZero = (component: string): boolean => /^0(px|rem|em|%)?$/.test(component);

describe("#1802 — the rail's horizontal inset is owned by the container", () => {
  it("defines the inset token exactly once, and in the container's own rule", () => {
    const definers = allRules().filter((rule) =>
      new RegExp(`(^|[;\\s])${TOKEN}\\s*:`).test(rule.body),
    );
    // A second definition is how a "single source" quietly becomes two: the
    // rail would still render one value while a media query or a theme block
    // served another, and every geometric assertion would stay green.
    expect(definers.map((rule) => rule.selectors)).toEqual([CONTAINER]);
  });

  it("keeps every reference to the token inside a container-scoped rule", () => {
    // The whole content of constraint (3). A `var(--rail-inset)` reachable
    // from a rule that does not name the rail is a child helping itself to the
    // container's number — which is how `.members-pane` came to cancel it.
    const referring = allRules().filter((rule) => rule.body.includes(`var(${TOKEN}`));
    // Positive control: if the token ever stops being referenced at all this
    // test must not pass by having nothing to look at.
    expect(referring.length).toBeGreaterThan(0);
    const escapees = referring
      .flatMap((rule) => selectorList(rule.selectors))
      .filter((one) => !one.includes(CONTAINER));
    expect(escapees).toEqual([]);
  });

  it("lets no rail child declare a horizontal inset of its own", () => {
    // The set of children to police is READ OUT of the container's own rules
    // rather than listed here, so adding a carve-out to the rail extends this
    // guard in the same edit instead of drifting away from it.
    const railChildren = new Set<string>();
    for (const rule of allRules()) {
      for (const one of selectorList(rule.selectors)) {
        if (!one.includes(CONTAINER)) continue;
        for (const match of one.matchAll(/>\s*(\.[\w-]+)/g)) {
          const cls = match[1];
          if (cls !== undefined) railChildren.add(cls);
        }
      }
    }
    // Positive control, and the reason this is not vacuous: the container must
    // actually address someone by name for the loop below to have a subject.
    expect([...railChildren]).toContain(".members-pane");

    const offenders: string[] = [];
    for (const rule of allRules()) {
      const entries = selectorList(rule.selectors);
      // Container-owned iff EVERY entry names the rail — a rule is only as
      // scoped as its loosest selector.
      if (entries.every((one) => one.includes(CONTAINER))) continue;
      if (![...railChildren].some((cls) => entries.some((one) => one.includes(cls)))) continue;
      for (const { property, component } of horizontalInsets(rule.body)) {
        // Zero is a reset (killing the user-agent list indent, resetting a
        // button), not an inset. Anything else is the child deciding.
        if (isZero(component)) continue;
        offenders.push(`${rule.selectors} → ${property}: ${component}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
