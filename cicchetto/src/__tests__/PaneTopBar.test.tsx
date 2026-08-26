import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import PaneTopBar, { PaneTopBarRailOpener, PaneTopBarWindowsOpener } from "../PaneTopBar";

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

describe("PaneTopBarRailOpener — one button, two hosts", () => {
  // The same button serves the channel bar and the admin console; only the
  // accessible name differs, and it MUST differ — a screen-reader user meeting
  // two "open sidebar" controls in one 48px-tall band has been told nothing.
  it("wears the caller's label", () => {
    render(() => <PaneTopBarRailOpener onOpenRail={vi.fn()} railLabel="open actions" />);
    expect(screen.getByLabelText("open actions")).toBeInTheDocument();
  });

  it("keeps the shared classes whichever host it lands in", () => {
    render(() => <PaneTopBarRailOpener onOpenRail={vi.fn()} railLabel="open members sidebar" />);
    const btn = screen.getByLabelText("open members sidebar");
    expect(btn).toHaveClass("topic-bar-hamburger");
    expect(btn).toHaveClass("shell-chrome-btn");
  });

  it("calls its handler on click", () => {
    const onOpenRail = vi.fn();
    render(() => <PaneTopBarRailOpener onOpenRail={onOpenRail} railLabel="open members sidebar" />);
    fireEvent.click(screen.getByLabelText("open members sidebar"));
    expect(onOpenRail).toHaveBeenCalledTimes(1);
  });

  // #1801, ruling 1: this one STAYS a hamburger. It was the other door that
  // had to stop being one, and the temptation while splitting them was to give
  // this one a "people" icon — refused in channel, because it is a catch-all
  // (home, rooms, mentions, player, radio, themes, archive, settings, admin
  // AND the member list), and the generic glyph is the honest name for that.
  // The character is what renders if the stylesheet never loads; the bars are
  // drawn over it (#1766).
  it("still carries U+2630, the character the CSS bars are drawn over", () => {
    render(() => <PaneTopBarRailOpener onOpenRail={vi.fn()} railLabel="open members sidebar" />);
    expect(screen.getByLabelText("open members sidebar").textContent).toBe("\u{2630}");
  });
});

// #1766 — the LEFT door. A separate component from the rail opener, and the
// separation is the whole point of the tests below.
describe("PaneTopBarWindowsOpener — the other door", () => {
  it("names itself for the sidebar it opens", () => {
    render(() => <PaneTopBarWindowsOpener onOpenWindows={vi.fn()} />);
    expect(screen.getByLabelText("open windows sidebar")).toBeInTheDocument();
  });

  // 🔴 The load-bearing assertion in this file. `.topic-bar-hamburger` is the
  // NAME of the rail door, not a style hook: `openMembersDrawer` locates it by
  // class and takes `.first()` (#1073, stated in the fixture). The first cut of
  // #1766 reused the rail opener here, so with the window bar off two buttons
  // wore that class, `.first()` resolved to THIS one, and the fixture opened
  // the window sidebar instead of the rail — then had its retry occluded by the
  // sidebar it had just opened. Measured on the integration run, not reasoned
  // about. Roughly twenty specs reach the rail through that helper.
  it("does NOT wear the rail door's class", () => {
    render(() => <PaneTopBarWindowsOpener onOpenWindows={vi.fn()} />);
    const btn = screen.getByLabelText("open windows sidebar");
    expect(btn).not.toHaveClass("topic-bar-hamburger");
    expect(btn).toHaveClass("topic-bar-windows-opener");
  });

  // What the two doors DO still share: the sizing tokens. With the window bar
  // off they sit in one 48px band, so #305's tap floor and icon size have to
  // reach both. Only the identity was split.
  it("still shares the chrome button's sizing", () => {
    render(() => <PaneTopBarWindowsOpener onOpenWindows={vi.fn()} />);
    expect(screen.getByLabelText("open windows sidebar")).toHaveClass("shell-chrome-btn");
  });

  it("calls its handler on click", () => {
    const onOpenWindows = vi.fn();
    render(() => <PaneTopBarWindowsOpener onOpenWindows={onOpenWindows} />);
    fireEvent.click(screen.getByLabelText("open windows sidebar"));
    expect(onOpenWindows).toHaveBeenCalledTimes(1);
  });

  // 🔴 #1801, ruling 2 — and the assertion is on the CODEPOINT, not on the
  // rendered string, because the spellings that must not ship are INVISIBLE in
  // a diff: U+0023 followed by U+FE0F (emoji presentation) reads as one `#` in
  // every editor, and the keycap U+0023 U+FE0F U+20E3 differs from it by one
  // more zero-width character. `Array.from` splits by codepoint, so a trailing
  // selector makes the array two long and the test names it. vjt in channel:
  // "il # non emoji / il # carattere / ascii / roba anni '70". The reason is
  // not taste — an emoji is painted by the platform,
  // so it ignores `currentColor` and would sit dead under the `:hover` /
  // `:focus-visible` lift the rest of the chrome answers, and it renders
  // differently on iOS and Android.
  it("paints the ASCII `#` (U+0023) and nothing emoji-adjacent", () => {
    render(() => <PaneTopBarWindowsOpener onOpenWindows={vi.fn()} />);
    const text = screen.getByLabelText("open windows sidebar").textContent ?? "";
    expect(Array.from(text)).toEqual(["#"]);
    expect(text.codePointAt(0)).toBe(0x23);
  });
});
