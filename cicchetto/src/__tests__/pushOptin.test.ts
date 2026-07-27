import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #459 — the push opt-in banner's owner module. Mirrors swRegistration.ts as a
// single-source-of-truth for ONE banner source: it owns the show/hide gate, the
// accept ([of course!]) and decline (×) verbs, and the persisted-decline
// localStorage flag. The registry (errorBanners.ts) only asks
// `shouldShowPushOptinBanner()` and wires the two verbs.
//
// push.ts (pushAvailable + enablePush) and auth.ts (token) are mocked so the
// gate/accept/decline logic is tested in isolation — pushAvailable's own
// capability matrix is covered in push.test.ts, and enablePush's dance in the
// #181 suite there.
vi.mock("../lib/push", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/push")>()),
  pushAvailable: vi.fn(() => true),
  enablePush: vi.fn(() => Promise.resolve({ status: "enabled", subscriptionId: "sub-x" })),
}));
vi.mock("../lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/auth")>()),
  token: vi.fn(() => "tok"),
}));

import { token } from "../lib/auth";
import { enablePush, pushAvailable } from "../lib/push";
import {
  __resetPushOptinForTests,
  acceptPushOptin,
  declinePushOptin,
  shouldShowPushOptinBanner,
} from "../lib/pushOptin";

const mockPushAvailable = vi.mocked(pushAvailable);
const mockEnablePush = vi.mocked(enablePush);
const mockToken = vi.mocked(token);

const DECLINED_KEY = "cic.pushOptinDeclined";

beforeEach(() => {
  localStorage.clear();
  __resetPushOptinForTests();
  mockPushAvailable.mockReturnValue(true);
  mockToken.mockReturnValue("tok");
  mockEnablePush
    .mockReset()
    .mockResolvedValue({ status: "enabled", subscriptionId: "sub-x" as never });
  vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("shouldShowPushOptinBanner — the 3-part gate (#459)", () => {
  it("shows when push is available, permission is default, and not declined", () => {
    expect(shouldShowPushOptinBanner()).toBe(true);
  });

  it("hides when push is not available on this platform", () => {
    mockPushAvailable.mockReturnValue(false);
    expect(shouldShowPushOptinBanner()).toBe(false);
  });

  it("hides when permission is already granted (nothing to ask)", () => {
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    expect(shouldShowPushOptinBanner()).toBe(false);
  });

  it("hides when permission is denied (browser blocks re-prompting)", () => {
    vi.stubGlobal("Notification", { permission: "denied", requestPermission: vi.fn() });
    expect(shouldShowPushOptinBanner()).toBe(false);
  });

  it("hides when the user previously declined (persisted in localStorage)", () => {
    localStorage.setItem(DECLINED_KEY, "1");
    expect(shouldShowPushOptinBanner()).toBe(false);
  });
});

describe("declinePushOptin — the × (#459)", () => {
  it("persists the decline so the banner never returns this session or the next", () => {
    expect(shouldShowPushOptinBanner()).toBe(true);
    declinePushOptin();
    expect(shouldShowPushOptinBanner()).toBe(false);
    expect(localStorage.getItem(DECLINED_KEY)).toBe("1");
  });

  it("NEVER calls Notification.requestPermission (a decline must leave the origin at default)", () => {
    const requestPermission = vi.fn();
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    declinePushOptin();
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe("acceptPushOptin — the [of course!] (#459)", () => {
  it("calls enablePush with the bearer token and hides the banner after the attempt", async () => {
    await acceptPushOptin();
    expect(mockEnablePush).toHaveBeenCalledWith("tok");
    // Hidden for the session once the attempt settles (a grant makes the gate
    // false anyway; this also covers the OS-prompt-dismissed case).
    expect(shouldShowPushOptinBanner()).toBe(false);
  });

  it("does NOT persist a decline — a next-login re-offer is still possible", async () => {
    await acceptPushOptin();
    expect(localStorage.getItem(DECLINED_KEY)).toBeNull();
  });

  it("is a no-op with no bearer token (leaves the banner up)", async () => {
    mockToken.mockReturnValue(null);
    await acceptPushOptin();
    expect(mockEnablePush).not.toHaveBeenCalled();
    expect(shouldShowPushOptinBanner()).toBe(true);
  });

  it("swallows an enablePush throw (no unhandled rejection) and still hides", async () => {
    // enablePush RETURNS its expected outcomes but THROWS on infra failures
    // (VAPID fetch, subscribe, POST). The one-shot offer must not leak that as
    // an unhandled rejection; the settings toggle is the recovery surface.
    mockEnablePush.mockRejectedValue(new Error("vapid_fetch_failed"));
    await expect(acceptPushOptin()).resolves.toBeUndefined();
    expect(shouldShowPushOptinBanner()).toBe(false);
  });
});
