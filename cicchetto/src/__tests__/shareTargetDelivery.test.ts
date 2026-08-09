import { describe, expect, it } from "vitest";
import type { PersistedFocus } from "../lib/lastFocusedChannel";
import {
  resolveShareDestination,
  type ShareDestinationSources,
  shareDeliveryPlan,
} from "../lib/shareTargetDelivery";

// #1103 — WHERE a shared file goes, and what happens when the answer is
// nowhere.
//
// This is the decision, isolated on purpose. A share arrives with no window
// selected, so something has to name a `(networkSlug, channelName)` pair, and
// the product question — deliver to the window the operator was last in, or
// ask them with a picker — is not settled. Keeping the whole policy in
// `resolveShareDestination` means settling it later is one function, not an
// archaeology dig through the service worker and the boot path.
//
// The sources are injected rather than imported so the policy is a pure
// function of what the stores say. Same shape as `installStaleResumeReload`
// and the other seams in this codebase.

const sources = (over: Partial<ShareDestinationSources>): ShareDestinationSources => ({
  lastFocused: () => null,
  channelExists: () => false,
  queryExists: () => false,
  ...over,
});

const focus = (over: Partial<PersistedFocus>): PersistedFocus => ({
  networkSlug: "azzurra",
  channelName: "#bofh",
  kind: "channel",
  ...over,
});

const png = (name: string): File => new File(["x"], name, { type: "image/png" });

describe("resolveShareDestination — the last window the operator was in", () => {
  it("names the last focused CHANNEL when it is still live", () => {
    const dest = resolveShareDestination(
      sources({
        lastFocused: () => focus({}),
        channelExists: (slug, name) => slug === "azzurra" && name === "#bofh",
      }),
    );
    expect(dest).toEqual({ networkSlug: "azzurra", channelName: "#bofh" });
  });

  it("names the last focused QUERY when it is still live", () => {
    const dest = resolveShareDestination(
      sources({
        lastFocused: () => focus({ kind: "query", channelName: "vjt" }),
        queryExists: (slug, nick) => slug === "azzurra" && nick === "vjt",
      }),
    );
    expect(dest).toEqual({ networkSlug: "azzurra", channelName: "vjt" });
  });

  it("refuses a channel that is no longer live", () => {
    // Parted while cic was closed. Enqueueing an upload for it would post the
    // resulting URL into a channel we are not in — the send is lost and the
    // operator is told nothing.
    const dest = resolveShareDestination(
      sources({ lastFocused: () => focus({}), channelExists: () => false }),
    );
    expect(dest).toBeNull();
  });

  it("refuses a query window that is gone", () => {
    const dest = resolveShareDestination(
      sources({ lastFocused: () => focus({ kind: "query", channelName: "vjt" }) }),
    );
    expect(dest).toBeNull();
  });

  it("refuses when nothing was ever focused", () => {
    expect(resolveShareDestination(sources({}))).toBeNull();
  });

  for (const kind of ["home", "admin", "mentions", "list", "server"] as const) {
    it(`refuses ${kind}: it is not a place a file can be sent`, () => {
      // These windows have no IRC target to PRIVMSG the upload URL to.
      // `server` is the subtle one — it has real scrollback, so it looks
      // deliverable, but its rows are numerics the bouncer wrote, not a
      // conversation anyone can post into.
      const dest = resolveShareDestination(
        sources({
          lastFocused: () => focus({ kind }),
          channelExists: () => true,
          queryExists: () => true,
        }),
      );
      expect(dest).toBeNull();
    });
  }
});

describe("shareDeliveryPlan — deliver, or say why not", () => {
  const live = sources({
    lastFocused: () => focus({}),
    channelExists: () => true,
  });

  it("delivers uploadable files to the resolved window", () => {
    const plan = shareDeliveryPlan([png("a.png")], live);
    expect(plan).toEqual({
      kind: "deliver",
      destination: { networkSlug: "azzurra", channelName: "#bofh" },
      files: [expect.objectContaining({ name: "a.png" })],
    });
  });

  it("blocks with no-destination when nowhere is live", () => {
    const plan = shareDeliveryPlan([png("a.png")], sources({}));
    expect(plan).toEqual({ kind: "blocked", reason: "no-destination" });
  });

  it("blocks with nothing-uploadable on an empty share", () => {
    // The flag said a share was coming and the cache had nothing. Opening the
    // app and doing nothing at all is the outcome this refuses.
    expect(shareDeliveryPlan([], live)).toEqual({ kind: "blocked", reason: "nothing-uploadable" });
  });

  it("blocks with nothing-uploadable when no file is an accepted type", () => {
    const exe = new File(["x"], "setup.exe", { type: "application/x-msdownload" });
    expect(shareDeliveryPlan([exe], live)).toEqual({
      kind: "blocked",
      reason: "nothing-uploadable",
    });
  });

  it("delivers the uploadable subset of a mixed share", () => {
    const exe = new File(["x"], "setup.exe", { type: "application/x-msdownload" });
    const plan = shareDeliveryPlan([exe, png("a.png")], live);
    expect(plan.kind).toBe("deliver");
    // The filter is `categoryOf`, the SAME gate drag-and-drop and paste use —
    // not a second accept list written for this door.
    expect(plan.kind === "deliver" && plan.files.map((f) => f.name)).toEqual(["a.png"]);
  });

  it("checks the destination BEFORE the files", () => {
    // Both wrong at once: the operator needs to hear about the window first,
    // because that is the one they can do something about.
    expect(shareDeliveryPlan([], sources({}))).toEqual({
      kind: "blocked",
      reason: "no-destination",
    });
  });
});
