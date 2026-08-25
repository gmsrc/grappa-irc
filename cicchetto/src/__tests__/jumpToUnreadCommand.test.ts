import { describe, expect, it } from "vitest";
import { jumpToUnreadRequest, requestJumpToUnread } from "../lib/jumpToUnreadCommand";

// #1765 — the jump-back command nonce, sibling to `scrollToBottomCommand` and
// pinned for the same property: a monotonic counter, not a boolean toggle, so
// back-to-back requests each register as a DISTINCT transition. Solid's `===`
// equality would swallow a repeated `true`, and the second `»N` tap on a
// window still far behind (a failed fetch leaves the flag standing) is exactly
// the case that would go missing.
describe("jumpToUnreadCommand", () => {
  it("requestJumpToUnread advances the request nonce by one", () => {
    const before = jumpToUnreadRequest();
    requestJumpToUnread();
    expect(jumpToUnreadRequest()).toBe(before + 1);
  });

  it("each back-to-back call is a distinct transition (monotonic, no === swallow)", () => {
    const start = jumpToUnreadRequest();
    requestJumpToUnread();
    requestJumpToUnread();
    requestJumpToUnread();
    expect(jumpToUnreadRequest()).toBe(start + 3);
  });
});
