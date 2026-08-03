import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it } from "vitest";
import { applyPresenceChange, applyPresenceError, resetNotifyWatch } from "../lib/notifyWatch";
import { _setScheduleExpiryForTest } from "../lib/toasts";
import Toasts from "../Toasts";

// #775 — the ONE toast surface, extracted from #247's PresenceToasts so a
// second producer can render into the same stack element rather than a second
// fixed overlay landing on top of it.
//
// jsdom renders no layout, so this covers the WIRING (a queued toast reaches
// the DOM, a click removes it) and not the appearance. Whether the stack is
// positioned and legible is a browser question, unverified here.

beforeEach(() => {
  _setScheduleExpiryForTest(() => {});
  resetNotifyWatch();
});

describe("Toasts", () => {
  it("renders a presence transition, migrated onto the shared chrome", () => {
    applyPresenceChange({
      network_id: 42,
      nick: "Foo",
      presence: "online",
      initial: false,
      ts: "2026-08-03T12:00:00Z",
    });

    const { container } = render(() => <Toasts />);

    expect(container.querySelectorAll(".toast-stack .toast-online")).toHaveLength(1);
    expect(screen.getByText("is online")).toBeInTheDocument();
    expect(screen.getByText("Foo")).toBeInTheDocument();
  });

  it("renders a watch-list rejection with the error tone", () => {
    applyPresenceError({ network_id: 42, detail: "aaa,bbb" });

    const { container } = render(() => <Toasts />);

    expect(container.querySelectorAll(".toast-error")).toHaveLength(1);
    expect(screen.getByText(/aaa,bbb/)).toBeInTheDocument();
  });

  it("dismisses a presence toast on click", () => {
    applyPresenceError({ network_id: 42, detail: "aaa,bbb" });

    const { container } = render(() => <Toasts />);
    fireEvent.click(container.querySelector(".toast-error")!);

    expect(container.querySelectorAll(".toast")).toHaveLength(0);
  });

  it("says nothing with no toasts queued", () => {
    const { container } = render(() => <Toasts />);

    expect(container.querySelectorAll(".toast")).toHaveLength(0);
  });
});
