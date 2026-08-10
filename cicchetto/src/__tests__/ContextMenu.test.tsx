import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import ContextMenu, { type ContextMenuItem } from "../ContextMenu";

// #949 — the WIRING half of the safe-area clamp. The arithmetic is pinned as a
// pure fn (lib/menuPosition.test.ts) and the stylesheet rules at source level
// (contextMenuSafeArea.test.ts); neither notices if `ContextMenu` stops
// rendering the ruler or stops feeding its rect to the math, which would leave
// the fix dead while both other suites stay green.
//
// jsdom reports every rect as zero, so the two boxes that matter are stubbed —
// the same shape RailActions.test.tsx uses for #913's JS half. That makes these
// behavioural tests of the component's contract (which numbers it reads, and
// what it does with them), not layout tests: jsdom does not paint, and the felt
// result on a notched device is still only confirmable by dogfood.

const ITEMS = [
  { label: "whois", enabled: true, action: vi.fn() },
  { label: "query", enabled: true, action: vi.fn() },
];

// #1192 — a top level with one drillable group in the MIDDLE. Middle on
// purpose: the drill state is an index into this array, so a group at index 0
// would let an off-by-one read as correct.
const VERSION_ACTION = vi.fn();
const NESTED: ContextMenuItem[] = [
  { label: "whois", enabled: true, action: vi.fn() },
  {
    label: "ctcp",
    enabled: true,
    submenu: [
      { label: "VERSION", enabled: true, action: (): void => VERSION_ACTION() },
      { label: "TIME", enabled: true, action: vi.fn() },
    ],
  },
  { label: "query", enabled: true, action: vi.fn() },
];

// A portrait iPhone 15 under `viewport-fit=cover`: the ruler is laid out at
// `inset: env(safe-area-inset-*)`, so its rect is the safe box in
// layout-viewport coordinates — 59px of status bar at the top, 34px of home
// indicator at the bottom of an 852px display.
const IPHONE_15_SAFE = { top: 59, right: 393, bottom: 818, left: 0 };

function stubRect(selector: string, rect: Partial<DOMRect>): HTMLElement {
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) throw new Error(`${selector} did not render`);
  el.getBoundingClientRect = (): DOMRect => rect as DOMRect;
  return el;
}

// The placement effect tracks `props.position`, so re-rendering at fresh
// coordinates is what re-runs it against the stubbed rects.
function renderThenPlace(
  safe: Partial<DOMRect>,
  menu: Partial<DOMRect>,
  at: { x: number; y: number },
): HTMLElement {
  const [position, setPosition] = createSignal({ x: 1, y: 1 });
  render(() => <ContextMenu items={ITEMS} position={position()} onClose={vi.fn()} />);
  stubRect(".context-menu-safe-area", safe);
  const menuEl = stubRect(".context-menu", menu);
  setPosition(at);
  return menuEl;
}

describe("ContextMenu safe-area placement (#949)", () => {
  it("renders the safe-area ruler, hidden from the accessibility tree", () => {
    render(() => <ContextMenu items={ITEMS} position={{ x: 10, y: 10 }} onClose={vi.fn()} />);
    const ruler = document.querySelector(".context-menu-safe-area");
    // Deleting this element is the cheapest way to silently un-fix #949: the
    // effect bails on a missing ref and the menu keeps its raw press coords.
    expect(ruler).not.toBeNull();
    expect(ruler?.getAttribute("aria-hidden")).toBe("true");
  });

  it("pins an oversized menu below the top inset, not at the physical top", () => {
    // 900px of menu against jsdom's 768px viewport: oversized either way, so
    // the only question is WHICH origin it pins to. y=0 is the #913 defect —
    // under viewport-fit=cover that coordinate is behind the status bar, and
    // the menu's own overflow scroll cannot recover a box that STARTS there.
    const menuEl = renderThenPlace(
      IPHONE_15_SAFE,
      { top: 0, left: 0, right: 200, bottom: 900, width: 200, height: 900 },
      { x: 100, y: 400 },
    );
    expect(menuEl.style.top).toBe("59px");
  });

  it("never opens the menu inside the leading inset", () => {
    // Landscape: the notch and the rounded corner eat a column on the leading
    // edge, and unlike the status bar iOS does still deliver touches there — so
    // a press CAN arrive at x=10 and must not be honoured as an origin.
    const menuEl = renderThenPlace(
      { top: 0, right: 793, bottom: 372, left: 59 },
      { top: 0, left: 0, right: 200, bottom: 120, width: 200, height: 120 },
      { x: 10, y: 100 },
    );
    expect(menuEl.style.left).toBe("59px");
  });

  // #1192 — a submenu changes the box HEIGHT, which is exactly the input the
  // #487 placement math takes. If the effect does not re-run on the drill, the
  // menu keeps the placement measured for the previous level and a submenu
  // opened low on the screen hangs off the fold — #487's defect, re-entered
  // through a door #487 could not have known about.
  it("re-measures the placement when drilling changes the box height", () => {
    const [position, setPosition] = createSignal({ x: 1, y: 1 });
    render(() => <ContextMenu items={NESTED} position={position()} onClose={vi.fn()} />);
    stubRect(".context-menu-safe-area", { top: 0, right: 1024, bottom: 768, left: 0 });

    // A rect that GROWS on the drill, the way a 2-item top level growing into a
    // 6-verb submenu does. jsdom paints nothing, so the height is the one thing
    // the test has to supply itself.
    let height = 100;
    const menuEl = document.querySelector(".context-menu");
    if (!(menuEl instanceof HTMLElement)) throw new Error(".context-menu did not render");
    menuEl.getBoundingClientRect = (): DOMRect =>
      ({ top: 0, left: 0, right: 200, bottom: height, width: 200, height }) as DOMRect;

    // Press low: 700 + 100 overflows 768, so the placement flips to 600.
    setPosition({ x: 100, y: 700 });
    expect(menuEl.style.top).toBe("600px");

    // Now the taller level. 700 + 400 overflows too, and the flip lands at 300 —
    // a value only a RE-measurement can produce.
    height = 400;
    fireEvent.click(screen.getByRole("button", { name: /^ctcp ▸$/i }));
    expect(menuEl.style.top).toBe("300px");
  });

  it("honours the press coordinates when there is no inset to dodge", () => {
    // The no-notch case — every desktop browser and every engine in the e2e
    // suite, where env(safe-area-inset-*) resolves to 0. The fix must be a
    // NO-OP here, or it is a regression of #487 dressed up as a fix.
    const menuEl = renderThenPlace(
      { top: 0, right: 1024, bottom: 768, left: 0 },
      { top: 0, left: 0, right: 200, bottom: 120, width: 200, height: 120 },
      { x: 100, y: 400 },
    );
    expect(menuEl.style.left).toBe("100px");
    expect(menuEl.style.top).toBe("400px");
  });
});

// #1192 — the drill-down itself. A submenu keeps the nick menu from growing by
// six items; the shell owns the mechanism so both menus that mount it inherit
// it, and the CTCP verb list stays a plain data structure at the call site.
describe("ContextMenu drill-down (#1192)", () => {
  const labels = (): string[] =>
    [...document.querySelectorAll(".context-menu-item")].map((b) => b.textContent ?? "");

  it("marks a drillable group with ▸ and leaves plain items unmarked", () => {
    render(() => <ContextMenu items={NESTED} position={{ x: 10, y: 10 }} onClose={vi.fn()} />);
    // The caller names the group; the shell says it opens. A caller that had to
    // spell the ▸ itself would eventually spell it two ways.
    expect(labels()).toEqual(["whois", "ctcp ▸", "query"]);
  });

  it("swaps the list for the submenu instead of closing the menu", () => {
    const onClose = vi.fn();
    render(() => <ContextMenu items={NESTED} position={{ x: 10, y: 10 }} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /^ctcp ▸$/i }));

    // The group row is a NAVIGATION, not an invocation: closing here would make
    // the six verbs unreachable.
    expect(onClose).not.toHaveBeenCalled();
    expect(labels()).toEqual(["‹ ctcp", "VERSION", "TIME"]);
  });

  it("invokes a submenu action and closes", () => {
    const onClose = vi.fn();
    render(() => <ContextMenu items={NESTED} position={{ x: 10, y: 10 }} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /^ctcp ▸$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^version$/i }));

    expect(VERSION_ACTION).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns to the top level from the back row, without acting", () => {
    const onClose = vi.fn();
    render(() => <ContextMenu items={NESTED} position={{ x: 10, y: 10 }} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /^ctcp ▸$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^‹ ctcp$/i }));

    expect(labels()).toEqual(["whois", "ctcp ▸", "query"]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("resets to the top level when the menu re-opens at new coordinates", () => {
    // Both call sites keep this component mounted across a value→value change
    // of their `<Show>` signal: right-clicking a second nick while the menu is
    // up re-positions it without unmounting. Without the reset that second nick
    // opens straight into the first one's submenu — and the actions in it are
    // bound to the FIRST nick.
    const [position, setPosition] = createSignal({ x: 10, y: 10 });
    render(() => <ContextMenu items={NESTED} position={position()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^ctcp ▸$/i }));
    expect(labels()).toEqual(["‹ ctcp", "VERSION", "TIME"]);

    setPosition({ x: 400, y: 400 });

    expect(labels()).toEqual(["whois", "ctcp ▸", "query"]);
  });
});
