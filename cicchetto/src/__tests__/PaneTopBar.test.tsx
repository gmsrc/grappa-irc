import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import PaneTopBar, { PaneTopBarRailOpener } from "../PaneTopBar";

// #1766 — the band grew a LEADING slot, and the band is where it belongs
// rather than in `TopicBar`: turning the mobile window bar off has to leave a
// door on every surface wearing this bar, not only the channel one.
//
// The slot is REQUIRED, exactly like `trailing` (#1697) and for the same
// stated reason: a defaulted slot lets a new host inherit a door it never
// asked for. A host with no left door passes `null` and says so at the call
// site. That is why these tests assert the CHILD COUNT and not just presence —
// `null` must emit no element, or every host that opted out silently gains a
// layout box in a `justify-content: space-between`-adjacent band.
//
// Side is child ORDER, not a CSS override. #1073 pinned that for the trailing
// side after `.admin-pane-header` and `.shell-chrome` had disagreed about
// which edge the ☰ sits on; the leading side inherits the same oracle.

describe("PaneTopBar — the band's slots", () => {
  it("with no leading slot the band is two children: header, then trailing", () => {
    const { container } = render(() => (
      <PaneTopBar leading={null} trailing={<button type="button">x</button>}>
        <span>content</span>
      </PaneTopBar>
    ));

    const bar = container.querySelector(".topic-bar");
    expect(bar).not.toBeNull();
    const kids = Array.from(bar?.children ?? []);
    expect(kids).toHaveLength(2);
    expect(kids[0]).toHaveClass("topic-bar-header");
  });

  it("with a leading slot it is three, and the leading control comes FIRST", () => {
    const { container } = render(() => (
      <PaneTopBar
        leading={
          <button type="button" data-testid="lead">
            l
          </button>
        }
        trailing={
          <button type="button" data-testid="trail">
            t
          </button>
        }
      >
        <span>content</span>
      </PaneTopBar>
    ));

    const bar = container.querySelector(".topic-bar") as HTMLElement;
    const kids = Array.from(bar.children);
    expect(kids).toHaveLength(3);
    expect(kids[0]).toBe(screen.getByTestId("lead"));
    expect(kids[1]).toHaveClass("topic-bar-header");
    expect(kids[2]).toBe(screen.getByTestId("trail"));
  });

  // The header carries `flex: 1; min-width: 0`, so it is the header — not a
  // margin on the opener — that pushes the trailing control to the far edge
  // once something sits on the near one. Nothing else in this band has to
  // change for the leading slot to land where it should.
  it("the header keeps the flex-1 slot between the two controls", () => {
    render(() => (
      <PaneTopBar
        leading={<button type="button">l</button>}
        trailing={<button type="button">t</button>}
      >
        <span data-testid="content">content</span>
      </PaneTopBar>
    ));

    expect(screen.getByTestId("content").parentElement).toHaveClass("topic-bar-header");
  });
});

describe("PaneTopBarRailOpener — one button, two doors", () => {
  // The same button serves both sides; only the accessible name differs, and
  // it MUST differ — a screen-reader user meeting two "open sidebar" controls
  // in one 48px-tall band has been told nothing.
  it("wears the caller's label", () => {
    render(() => <PaneTopBarRailOpener onOpenRail={vi.fn()} railLabel="open windows sidebar" />);
    expect(screen.getByLabelText("open windows sidebar")).toBeInTheDocument();
  });

  it("keeps the shared classes whichever side it lands on", () => {
    render(() => <PaneTopBarRailOpener onOpenRail={vi.fn()} railLabel="open windows sidebar" />);
    const btn = screen.getByLabelText("open windows sidebar");
    expect(btn).toHaveClass("topic-bar-hamburger");
    expect(btn).toHaveClass("shell-chrome-btn");
  });

  it("calls its handler on click", () => {
    const onOpenRail = vi.fn();
    render(() => <PaneTopBarRailOpener onOpenRail={onOpenRail} railLabel="open windows sidebar" />);
    fireEvent.click(screen.getByLabelText("open windows sidebar"));
    expect(onOpenRail).toHaveBeenCalledTimes(1);
  });
});
