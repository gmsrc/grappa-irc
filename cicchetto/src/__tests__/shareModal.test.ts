import { afterEach, describe, expect, it } from "vitest";
import { closeShareModal, openShareModal, shareModalOpen } from "../lib/shareModal";

// #392 — the session-share modal open/close singleton. One flag, two
// triggers (home + settings). These pin the contract the ShareSessionModal
// and both trigger buttons depend on.

describe("shareModal", () => {
  afterEach(() => closeShareModal());

  it("starts closed", () => {
    expect(shareModalOpen()).toBe(false);
  });

  it("openShareModal opens it", () => {
    openShareModal();
    expect(shareModalOpen()).toBe(true);
  });

  it("closeShareModal closes it", () => {
    openShareModal();
    closeShareModal();
    expect(shareModalOpen()).toBe(false);
  });
});
