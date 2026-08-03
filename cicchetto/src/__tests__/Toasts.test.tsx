import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it } from "vitest";
import {
  announceAppliedBundleRefresh,
  bundleRefreshToasts,
  dismissBundleRefreshToast,
  markBundleRefreshApplied,
} from "../lib/bundleRefreshNotice";
import { applyPresenceChange, applyPresenceError, resetNotifyWatch } from "../lib/notifyWatch";
import { _setScheduleExpiryForTest } from "../lib/toasts";
import Toasts from "../Toasts";

// #775 — the ONE toast surface. Two producers, two queues, one stack element:
// separate fixed overlays would render on top of each other.
//
// jsdom renders no layout, so this covers the WIRING (a queued toast reaches
// the DOM, a click removes it) and not the appearance. Whether the stack is
// positioned and legible is a browser question, unverified here.

const t0 = 1_700_000_000_000;

beforeEach(() => {
  sessionStorage.clear();
  _setScheduleExpiryForTest(() => {});
  resetNotifyWatch();
  for (const t of bundleRefreshToasts()) dismissBundleRefreshToast(t.id);
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

  it("announces an auto-refresh that landed", () => {
    markBundleRefreshApplied(t0);
    announceAppliedBundleRefresh(t0 + 2_000, "0.10.1");

    const { container } = render(() => <Toasts />);

    expect(container.querySelectorAll(".toast-update")).toHaveLength(1);
    expect(screen.getByText("Updated to 0.10.1")).toBeInTheDocument();
  });

  it("says nothing on an ordinary boot", () => {
    const { container } = render(() => <Toasts />);

    expect(container.querySelectorAll(".toast")).toHaveLength(0);
  });

  it("stacks both producers in the one container", () => {
    applyPresenceChange({
      network_id: 42,
      nick: "Foo",
      presence: "offline",
      initial: false,
      ts: "2026-08-03T12:00:00Z",
    });
    markBundleRefreshApplied(t0);
    announceAppliedBundleRefresh(t0 + 2_000, "0.10.1");

    const { container } = render(() => <Toasts />);

    expect(container.querySelectorAll(".toast-stack")).toHaveLength(1);
    expect(container.querySelectorAll(".toast-stack > .toast")).toHaveLength(2);
  });

  it("dismisses the update toast on click without touching the presence one", () => {
    applyPresenceChange({
      network_id: 42,
      nick: "Foo",
      presence: "online",
      initial: false,
      ts: "2026-08-03T12:00:00Z",
    });
    markBundleRefreshApplied(t0);
    announceAppliedBundleRefresh(t0 + 2_000, "0.10.1");

    const { container } = render(() => <Toasts />);
    fireEvent.click(container.querySelector(".toast-update")!);

    expect(container.querySelectorAll(".toast-update")).toHaveLength(0);
    expect(container.querySelectorAll(".toast-online")).toHaveLength(1);
  });
});
