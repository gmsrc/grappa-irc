import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetWireDropForTests,
  droppedKind,
  noteWireDrop,
  shouldShowWireDropBanner,
  wireDropMessage,
} from "../lib/wireDrop";

// #1393d — the latch behind the "cic is discarding data" banner.
describe("wireDrop — the discarded-payload latch (#1393d)", () => {
  beforeEach(() => {
    __resetWireDropForTests();
  });

  it("is dark until something is actually dropped", () => {
    expect(droppedKind()).toBeNull();
    expect(shouldShowWireDropBanner()).toBe(false);
  });

  it("records the kind of the payload that was dropped", () => {
    noteWireDrop({ kind: "isupport_changed", network_id: 1 });
    expect(droppedKind()).toBe("isupport_changed");
    expect(shouldShowWireDropBanner()).toBe(true);
  });

  it("names the kind in the message, so the banner says WHICH pane is stale", () => {
    noteWireDrop({ kind: "whois_bundle" });
    expect(wireDropMessage()).toContain("whois_bundle");
  });

  // A payload that failed narrowing is by definition not one whose shape we
  // established, so `kind` may be anything at all. Reading it is safe only
  // because it is type-checked at the read; everything else in the frame
  // stays out of the message.
  it.each([
    ["a non-string kind", { kind: 42 }],
    ["no kind at all", { network: "azzurra" }],
    ["not an object", "garbage"],
    ["null", null],
    ["an array", [1, 2, 3]],
  ])("degrades to `unknown` for %s rather than leaking it", (_label, raw) => {
    noteWireDrop(raw);
    expect(droppedKind()).toBe("unknown");
    expect(shouldShowWireDropBanner()).toBe(true);
  });

  // The property that keeps a stale BEAM from turning the banner into a
  // slot machine: an `isupport_changed` drop repeats on every 005 and on
  // every reconnect, and the text must not change under the reader's eyes
  // while they are reading it.
  it("latches the FIRST kind and ignores every drop after it", () => {
    noteWireDrop({ kind: "isupport_changed" });
    noteWireDrop({ kind: "window_invited" });
    noteWireDrop({ kind: "connection_state_changed" });
    expect(droppedKind()).toBe("isupport_changed");
  });

  // `unknown` is a real latched value, not a "still empty" sentinel — so a
  // later well-formed kind must not overwrite it either. Without this the
  // idempotence above could be implemented as a falsy check and pass.
  it("treats a latched `unknown` as latched, not as still-empty", () => {
    noteWireDrop({ no: "kind" });
    noteWireDrop({ kind: "isupport_changed" });
    expect(droppedKind()).toBe("unknown");
  });
});
