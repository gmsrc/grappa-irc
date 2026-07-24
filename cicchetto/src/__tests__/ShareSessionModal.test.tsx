import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetForTest } from "../lib/overlayScrollLock";
import { closeShareModal, openShareModal } from "../lib/shareModal";
import ShareSessionModal from "../ShareSessionModal";

// #392 — the session-share modal (QR + native-share + copy + countdown),
// mounted once in Shell and opened by BOTH the home button and the settings
// button via openShareModal(). These tests pin: no mint at boot (closed →
// nothing rendered, mint NOT called), mint on open, the QR + link + countdown
// surface, native-share wiring, and token discard on close.

const mintShareToken = vi.fn();
vi.mock("../lib/api", () => ({
  mintShareToken: (t: string) => mintShareToken(t),
}));
vi.mock("../lib/auth", () => ({
  token: () => "session-token",
}));

const futureIso = () => new Date(Date.now() + 600_000).toISOString();

describe("ShareSessionModal (#392)", () => {
  beforeEach(() => {
    mintShareToken.mockReset();
    mintShareToken.mockResolvedValue({ token: "SHARETOK", expires_at: futureIso() });
  });
  afterEach(() => {
    closeShareModal();
    __resetForTest();
    vi.clearAllMocks();
  });

  it("renders nothing and does NOT mint while closed", () => {
    render(() => <ShareSessionModal />);
    expect(screen.queryByTestId("share-modal")).toBeNull();
    expect(mintShareToken).not.toHaveBeenCalled();
  });

  it("mints on open and shows the QR, the share URL and the countdown", async () => {
    render(() => <ShareSessionModal />);
    openShareModal();

    await waitFor(() => expect(screen.getByTestId("share-modal")).toBeInTheDocument());
    expect(mintShareToken).toHaveBeenCalledWith("session-token");

    // QR container carries an inline <svg> built from the share URL.
    const qr = await screen.findByTestId("share-qr");
    expect(qr.querySelector("svg")).not.toBeNull();

    // The link the user sends to themselves.
    const url = (await screen.findByTestId("share-url")) as HTMLInputElement;
    expect(url.value).toContain("/share/SHARETOK");

    // Spec heading above the QR + the "send yourself a link" alt copy.
    expect(screen.getByText(/scan this code on another device/i)).toBeInTheDocument();
    expect(screen.getByText(/alternatively, send yourself a link/i)).toBeInTheDocument();

    // TTL countdown (m:ss).
    expect(screen.getByTestId("share-countdown").textContent).toMatch(/\d+:\d\d/);
  });

  it("invokes the Web Share API from the native-share button when available", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    // biome-ignore lint/suspicious/noExplicitAny: test stub of navigator.share
    (navigator as any).share = share;
    render(() => <ShareSessionModal />);
    openShareModal();

    const nativeBtn = await screen.findByTestId("share-native");
    fireEvent.click(nativeBtn);
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share.mock.calls[0]?.[0]).toHaveProperty("url");
    // biome-ignore lint/suspicious/noExplicitAny: test cleanup
    (navigator as any).share = undefined;
  });

  it("closes and discards the token when the close button is clicked", async () => {
    render(() => <ShareSessionModal />);
    openShareModal();
    await screen.findByTestId("share-modal");

    fireEvent.click(screen.getByTestId("share-modal-close"));
    await waitFor(() => expect(screen.queryByTestId("share-modal")).toBeNull());
    // Re-opening mints a FRESH token (old one discarded on close).
    openShareModal();
    await screen.findByTestId("share-modal");
    expect(mintShareToken).toHaveBeenCalledTimes(2);
  });

  it("discards a mint that resolves AFTER the modal was closed (no stale token)", async () => {
    // First open: a mint that stays in flight until we resolve it by hand.
    let resolveMint: (v: { token: string; expires_at: string }) => void = () => {};
    mintShareToken.mockReset();
    mintShareToken.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveMint = res;
        }),
    );
    render(() => <ShareSessionModal />);
    openShareModal();
    await waitFor(() => expect(screen.getByTestId("share-modal")).toBeInTheDocument());
    // Still minting → no URL yet.
    expect(screen.queryByTestId("share-url")).toBeNull();

    // Close BEFORE the mint resolves, THEN let it resolve.
    closeShareModal();
    await waitFor(() => expect(screen.queryByTestId("share-modal")).toBeNull());
    resolveMint({ token: "LATE", expires_at: futureIso() });
    await Promise.resolve();

    // Reopen: the stale "LATE" token must NOT surface — a fresh mint runs.
    mintShareToken.mockResolvedValue({ token: "FRESH", expires_at: futureIso() });
    openShareModal();
    const url = (await screen.findByTestId("share-url")) as HTMLInputElement;
    expect(url.value).toContain("/share/FRESH");
    expect(url.value).not.toContain("LATE");
  });
});
