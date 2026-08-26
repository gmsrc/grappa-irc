/// <reference types="node" />
import { readFileSync } from "node:fs";

// Shared source-level reader for the stylesheet, lifted out of
// ipadSafeArea.test.ts when #734/#735 needed the same "does this rule
// exist, and what does it declare?" guard (CLAUDE.md "implement once,
// reuse everywhere"). vitest stubs `.css?raw` imports to empty, so the
// stylesheet has to be read off disk; relative paths resolve against cwd
// (= cicchetto/, the vite root). cicchetto's tsconfig deliberately omits
// @types/node, hence the file-scoped reference above.
export const themeCss = readFileSync("src/themes/default.css", "utf8");

/**
 * Extract a single top-level CSS rule body by its selector. Matches
 * `selector { ... }` at column 0 (top-level rules, outside any @media
 * block, start at the left margin). Returns the text BETWEEN the braces
 * with CSS comments stripped, so prose that mentions a property cannot
 * satisfy or trip a declaration assertion. Throws when the rule is absent
 * so a rename can't silently pass the test — the #734 failure mode was a
 * class name with NO rule behind it at all.
 */
/**
 * Every rule whose selector list mentions a focus state (`:focus` or
 * `:focus-visible`), as `{ selectors, body }` pairs with CSS comments
 * stripped. Matches INNERMOST blocks only — the `[^{}]` classes can't span a
 * brace, so an `@media` prelude is never captured as a selector, and a rule
 * nested inside one still is.
 *
 * Grouped selector lists come back whole (`a:focus-visible,\n b:focus-visible`)
 * rather than split, so a caller asking "is this surface covered?" must look
 * inside the list — which is what `#96` needs: the sidebar's ring is one rule
 * over five selectors on purpose.
 */
export function focusRules(): { selectors: string; body: string }[] {
  return allRules().filter((rule) => rule.selectors.includes(":focus"));
}

/**
 * Every rule in the sheet as `{ selectors, body }`, comments stripped.
 * INNERMOST blocks only, the same way `focusRules` reads them: the `[^{}]`
 * classes cannot span a brace, so an `@media` prelude is never returned as a
 * selector and a rule nested inside one still is.
 *
 * Selector lists come back WHOLE (`a,\n b`) rather than split, because a
 * caller asking "is this rule allowed to declare X?" has to reason about the
 * list — a rule is only as scoped as its LOOSEST selector. Split with
 * `selectorList` when the per-entry answer is what matters (#1802).
 */
export function allRules(): { selectors: string; body: string }[] {
  const stripped = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selectors: string; body: string }[] = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selectors: (match[1] ?? "").trim(), body: match[2] ?? "" });
  }
  return out;
}

/** The entries of a comma-separated selector list, whitespace-collapsed. */
export function selectorList(selectors: string): string[] {
  return selectors
    .split(",")
    .map((one) => one.trim().replace(/\s+/g, " "))
    .filter((one) => one.length > 0);
}

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

/**
 * Every horizontal margin/padding component a rule body declares.
 *
 * Lifted out of `railInset.test.ts` when #1828 needed the same reader for the
 * radio band (CLAUDE.md "implement once, reuse everywhere"): both gates ask
 * "which boxes in this region inset themselves horizontally, and how?", and a
 * second copy of the shorthand-arity expansion is a second place to get
 * `padding: 0.4rem 0` wrong.
 */
export function horizontalInsets(body: string): { property: string; component: string }[] {
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

/**
 * Whether an inset component is a RESET rather than a declared gap — killing
 * the user-agent list indent, resetting a button. Anything else is a box
 * deciding its own horizontal position.
 */
export const isZeroInset = (component: string): boolean => /^0(px|rem|em|%)?$/.test(component);

/**
 * Every body of a rule whose selector is EXACTLY `selector`, at any nesting
 * depth — `ruleBody`'s column-0 anchor cannot see rules inside an `@media` /
 * `@supports` block. Returns one entry per block on purpose: a selector can
 * legitimately have more than one (`.shell-mobile` has a second block under
 * `@supports not (height: 100dvh)`), and an assertion about which value a
 * property ends up with has to see them all. Comments stripped, same as
 * `ruleBody`; throws when the selector has no rule at all, so a rename can't
 * pass vacuously.
 */
export function nestedRuleBodies(selector: string): string[] {
  const stripped = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((match[1] ?? "").trim() !== selector) continue;
    out.push(match[2] ?? "");
  }
  if (out.length === 0) throw new Error(`CSS rule not found: ${selector}`);
  return out;
}

/**
 * The body of every `@media (hover: hover)` block, brace-MATCHED rather than
 * regex-captured: such a block contains whole rules, and the `[^{}]` classes
 * the helpers above rely on cannot span a nested brace. Comments stripped,
 * same as the rest of this module, so prose naming a selector can neither
 * satisfy nor trip an assertion about it.
 *
 * Throws when the sheet carries no such gate at all, for the same reason
 * `ruleBody` throws on an absent rule: a test asking "is this rule gated?"
 * must not pass because the GATE vanished.
 */
export function hoverGatedBlocks(): string[] {
  const stripped = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const opener = /@media\s*\(\s*hover\s*:\s*hover\s*\)\s*\{/g;
  const out: string[] = [];
  let match = opener.exec(stripped);
  while (match !== null) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (i < stripped.length && depth > 0) {
      const ch = stripped[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      i += 1;
    }
    if (depth !== 0) throw new Error("unbalanced @media (hover: hover) block in default.css");
    out.push(stripped.slice(start, i - 1));
    opener.lastIndex = i;
    match = opener.exec(stripped);
  }
  if (out.length === 0) throw new Error("no @media (hover: hover) gate found in default.css");
  return out;
}

export function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m");
  const match = themeCss.match(re);
  const captured = match?.[1];
  if (captured === undefined) throw new Error(`CSS rule not found: ${selector}`);
  return captured.replace(/\/\*[\s\S]*?\*\//g, "");
}
