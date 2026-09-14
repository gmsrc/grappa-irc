import { describe, expect, it } from "vitest";
import { nestedRuleBodies, ruleBody } from "./helpers/themeCss";

// issue 2166 — at the rail's 160px floor the network-header row's umode
// indicator ran OVER the network slug instead of yielding, and the reporter's
// re-measurement raised it past cosmetic: the slug is squeezed to ZERO width,
// not truncated, and that row is also the SERVER TAB, so with several networks
// connected the rows lose both their identity and their click target.
//
// THE MECHANISM, and it is one line of the flexbox spec. The header `<li>` is
// the flex container (`.sidebar-network-section li { display: flex }`) and its
// direct children are exactly three (`Sidebar.tsx` ~:336-425):
//
//   .sidebar-window-btn        flex: 1 1 auto; min-width: 0   (holds the slug)
//   .sidebar-umode-indicator   white-space: nowrap; <nothing else>
//   .sidebar-close             flex: 0 0 auto                 (a bounded ×)
//
// A flex item's `min-width` is `auto`, and `auto` resolves to the item's
// CONTENT-BASED MINIMUM — except on a scroll container, where it resolves to
// zero (css-flexbox-1 §4.5). A `nowrap` text box that is not a scroll
// container therefore has a minimum equal to its whole string and takes NONE
// of the row's deficit: an 18-character oper umode string floors ~113px of a
// 160px row, the whole shortfall lands on the one sibling that CAN shrink, and
// the slug inside it goes to zero. That is the report, exactly.
//
// SO THE CONTRACT IS "NO CHILD OF THIS ROW MAY IMPOSE AN UNBOUNDED CONTENT
// FLOOR", not "the umode indicator has four declarations". Once every
// content-sized child can shrink, the deficit is shared in proportion to the
// bases, so each keeps `base x available / sum(bases)` — strictly greater than
// zero for any available width above zero, whatever the font. That is why the
// acceptance criterion (at the floor the slug still renders at least an
// ellipsised first character) follows from these assertions rather than from a
// pixel count. It is a DERIVATION, not a measurement: jsdom performs no
// layout, so no test in this suite can witness a rendered width. See the PR
// body for the e2e that could, and why it is not here.

/** Does `body` declare `property`, as a declaration and not inside a value? */
function declares(body: string, property: string): boolean {
  return new RegExp(`(^|;|\\s)${property}\\s*:`).test(body);
}

/** The declared value of `property` in `body`, whitespace-collapsed. */
function declaredValue(body: string, property: string): string | null {
  const match = new RegExp(`(?:^|;|\\s)${property}\\s*:([^;]+)`).exec(body);
  return match === null ? null : (match[1] ?? "").trim().replace(/\s+/g, " ");
}

/** Every rule body in the sheet whose selector is exactly `selector`, joined. */
function allBodies(selector: string): string {
  return nestedRuleBodies(selector).join("\n");
}

// The `<li>` flex line, named from `Sidebar.tsx` rather than guessed. The
// umode indicator is a SIBLING of the window button, not a child of it — the
// slug lives one flex context deeper, which is why the indicator's floor
// crushes it rather than merely crowding it.
const UMODE = ".sidebar-umode-indicator";
const WINDOW_BTN = ".sidebar-network-section li .sidebar-window-btn";
const CLOSE = ".sidebar-close";
const SLUG = ".sidebar-channel-name";

describe("issue 2166 — the network-header row shares its deficit instead of flooring", () => {
  it("the umode indicator cannot impose a content floor on the row", () => {
    // THE HEADLINE, and the whole defect. A nowrap item lifts its automatic
    // minimum in either of two independent ways: an explicit `min-width: 0`,
    // or becoming a scroll container. Either alone is sufficient, so the
    // assertion is the disjunction and not a list of declarations — a test
    // demanding both would go red on a correct simplification.
    const body = ruleBody(UMODE);
    expect(declares(body, "white-space"), "the rule that makes it unbounded").toBe(true);
    expect(declaredValue(body, "white-space")).toBe("nowrap");

    const lifted =
      declaredValue(body, "min-width") === "0" ||
      (declaredValue(body, "overflow") ?? "visible") !== "visible";
    expect(
      lifted,
      "a nowrap flex item with overflow:visible and no min-width floors the row at its whole string",
    ).toBe(true);
  });

  it("the modes truncate legibly rather than clip or overflow", () => {
    // The three are load-bearing ONLY together: `text-overflow` does nothing
    // without `overflow` clipping, and neither does anything while the box is
    // free to be as wide as its text. Asserted as a triple for that reason.
    const body = ruleBody(UMODE);
    expect(declaredValue(body, "white-space")).toBe("nowrap");
    expect(declaredValue(body, "overflow")).toBe("hidden");
    expect(declaredValue(body, "text-overflow")).toBe("ellipsis");
  });

  it("the slug is still the willing one, so the two actually share", () => {
    // The other half of the contract, and the half a careless fix inverts: if
    // the name stopped being able to shrink, the row would floor again with
    // the roles swapped and the MODES would be the casualty. Pre-existing
    // (`default.css:2079`); pinned here because this issue depends on it.
    const body = ruleBody(SLUG);
    expect(declaredValue(body, "overflow")).toBe("hidden");
    expect(declaredValue(body, "text-overflow")).toBe("ellipsis");
    expect(declaredValue(body, "white-space")).toBe("nowrap");
  });

  it("the window button keeps the min-width that lets the slug shrink at all", () => {
    // The slug's own shrinkability is worth nothing if its container floors:
    // `.sidebar-window-btn` is itself a flex item of the same `<li>`, and its
    // `min-width: 0` is what lets the row reach the slug's `overflow: hidden`.
    const body = allBodies(WINDOW_BTN);
    expect(declaredValue(body, "min-width")).toBe("0");
    expect(declaredValue(body, "flex")).toBe("1 1 auto");
  });

  it("the × is not where the clearance came from", () => {
    // `.sidebar-close` is deliberately `flex: 0 0 auto`: a disconnect target
    // that shrinks with the row is a tap target that disappears at the floor.
    // A "fix" that bought the slug its pixels here would be a worse bug than
    // the one reported, and nothing else in this file would notice.
    expect(declaredValue(ruleBody(CLOSE), "flex")).toBe("0 0 auto");
  });

  it("declares nothing on the indicator that the initial value already says", () => {
    // `flex: 0 1 auto` IS the initial value of `flex`, and an exhaustive grep
    // of the sheet finds no other rule setting `flex` on this selector (the
    // base rule, `:hover`, and the shared `:focus-visible` group are all three
    // of them). Declaring it would state that it is load-bearing when removing
    // it cannot change a pixel — and the next reader would believe the sheet.
    expect(declares(ruleBody(UMODE), "flex")).toBe(false);
  });
});
