import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConfirmModal from "../ConfirmModal";
import { type ConfirmAttachment, dismissConfirm, requestConfirm } from "../lib/confirmDialog";
import {
  __resetForTest,
  overlayEscapeDepth,
  runTopmostOverlayEscape,
} from "../lib/overlayScrollLock";

// #195 — the explicit confirm modal that replaces the removed #172
// hold-to-close gesture. Store-driven singleton: it renders whatever
// requestConfirm queued, fires the action ONLY on the affirmative button, and
// dismisses (without firing) on Cancel / backdrop / Esc.

describe("ConfirmModal (#195)", () => {
  afterEach(() => {
    dismissConfirm();
    __resetForTest();
  });

  it("renders nothing when no request is pending", () => {
    render(() => <ConfirmModal />);
    expect(screen.queryByTestId("confirm-modal")).toBeNull();
  });

  it("renders the title + interpolated body when a request is pending", () => {
    render(() => <ConfirmModal />);
    requestConfirm({
      title: "Leave channel",
      body: "Do you want to leave #italia?",
      confirmLabel: "Yes",
      onConfirm: vi.fn(),
      alternative: null,
      attachments: null,
    });
    expect(screen.getByTestId("confirm-modal")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-modal-body").textContent).toBe(
      "Do you want to leave #italia?",
    );
    // The affirmative button shows the caller's label.
    expect(screen.getByTestId("confirm-modal-confirm").textContent).toBe("Yes");
  });

  it("the affirmative button fires the action and closes", () => {
    const onConfirm = vi.fn();
    render(() => <ConfirmModal />);
    requestConfirm({
      title: "t",
      body: "b",
      confirmLabel: "Yes",
      onConfirm,
      alternative: null,
      attachments: null,
    });
    fireEvent.click(screen.getByTestId("confirm-modal-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("confirm-modal")).toBeNull();
  });

  it("Cancel dismisses WITHOUT firing the action", () => {
    const onConfirm = vi.fn();
    render(() => <ConfirmModal />);
    requestConfirm({
      title: "t",
      body: "b",
      confirmLabel: "Yes",
      onConfirm,
      alternative: null,
      attachments: null,
    });
    fireEvent.click(screen.getByTestId("confirm-modal-cancel"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-modal")).toBeNull();
  });

  it("backdrop click dismisses WITHOUT firing the action", () => {
    const onConfirm = vi.fn();
    render(() => <ConfirmModal />);
    requestConfirm({
      title: "t",
      body: "b",
      confirmLabel: "Yes",
      onConfirm,
      alternative: null,
      attachments: null,
    });
    fireEvent.click(screen.getByTestId("confirm-modal-backdrop"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-modal")).toBeNull();
  });

  // #232 — Esc dismisses via the shared overlay stack (dismissConfirm, the
  // safe close verb) and never fires the carried action. runTopmostOverlayEscape
  // is the exact verb the global keydown listener invokes (focus-independent).
  it("Escape dismisses WITHOUT firing the action (shared overlay stack)", async () => {
    const onConfirm = vi.fn();
    render(() => <ConfirmModal />);
    requestConfirm({
      title: "t",
      body: "b",
      confirmLabel: "Yes",
      onConfirm,
      alternative: null,
      attachments: null,
    });
    await waitFor(() => expect(overlayEscapeDepth()).toBe(1));
    expect(runTopmostOverlayEscape()).toBe(true);
    await waitFor(() => expect(screen.queryByTestId("confirm-modal")).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // #816 — the optional THIRD button. A request may carry an alternative way
  // to get what the operator wanted (the paste guard's "send it as a .txt
  // upload"), offered ALONGSIDE Cancel and the affirmative. Two-button
  // requests must be unchanged: the button appears only when the request
  // carries one.
  describe("#816 — the alternative button", () => {
    it("is absent when the request carries no alternative", () => {
      render(() => <ConfirmModal />);
      requestConfirm({
        title: "t",
        body: "b",
        confirmLabel: "Yes",
        onConfirm: vi.fn(),
        alternative: null,
        attachments: null,
      });
      expect(screen.queryByTestId("confirm-modal-alternative")).toBeNull();
    });

    it("renders the alternative's label and fires ONLY its action, then closes", () => {
      const onConfirm = vi.fn();
      const onSelect = vi.fn();
      render(() => <ConfirmModal />);
      requestConfirm({
        title: "t",
        body: "b",
        confirmLabel: "Paste",
        onConfirm,
        alternative: { label: "Upload as .txt", onSelect },
        attachments: null,
      });
      const btn = screen.getByTestId("confirm-modal-alternative");
      expect(btn.textContent).toBe("Upload as .txt");
      fireEvent.click(btn);
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
      expect(screen.queryByTestId("confirm-modal")).toBeNull();
    });
  });

  // 1883 — the OPTIONAL attachment list. A question about files cannot be
  // asked in a sentence: "Send this?" is only answerable if the operator can
  // see WHICH file. Text-only requests must be untouched — the list appears
  // only when the request carries one.
  describe("1883 — the attachment list", () => {
    const attachment = (over: Partial<ConfirmAttachment>): ConfirmAttachment => ({
      id: "a1",
      label: "cat.png",
      detail: "12 KB",
      thumbnail: null,
      ...over,
    });

    const withAttachments = (items: ConfirmAttachment[], onRemove: (id: string) => void): void => {
      requestConfirm({
        title: "Send to #a?",
        body: "b",
        confirmLabel: "Send",
        onConfirm: vi.fn(),
        alternative: null,
        attachments: { items: () => items, onRemove },
      });
    };

    it("is absent when the request carries no attachments", () => {
      render(() => <ConfirmModal />);
      requestConfirm({
        title: "t",
        body: "b",
        confirmLabel: "Yes",
        onConfirm: vi.fn(),
        alternative: null,
        attachments: null,
      });
      expect(screen.queryByTestId("confirm-modal-attachments")).toBeNull();
    });

    it("renders one row per attachment, with its label and detail", () => {
      render(() => <ConfirmModal />);
      withAttachments(
        [
          attachment({ id: "a1", label: "cat.png", detail: "12 KB" }),
          attachment({ id: "a2", label: "spec.pdf", detail: "2 KB" }),
        ],
        vi.fn(),
      );
      expect(screen.getAllByTestId("confirm-modal-attachment")).toHaveLength(2);
      expect(screen.getByText("spec.pdf")).toBeInTheDocument();
      expect(screen.getByText("2 KB")).toBeInTheDocument();
    });

    it("renders a thumbnail for a row that carries a blob, and none for one that does not", () => {
      render(() => <ConfirmModal />);
      withAttachments(
        [
          attachment({
            id: "a1",
            label: "cat.png",
            thumbnail: new Blob(["x"], { type: "image/png" }),
          }),
          attachment({ id: "a2", label: "spec.pdf", thumbnail: null }),
        ],
        vi.fn(),
      );
      const thumbs = screen.getAllByTestId("confirm-modal-attachment-thumb");
      expect(thumbs).toHaveLength(1);
      // A real object URL, not a data: placeholder — the row is showing the
      // operator's own bytes back to them.
      expect(thumbs[0]?.getAttribute("src")).toMatch(/^blob:/);
    });

    it("the remove button reports the row's id and does NOT resolve the dialog", () => {
      const onRemove = vi.fn();
      render(() => <ConfirmModal />);
      withAttachments([attachment({ id: "a2", label: "drop.png" })], onRemove);

      fireEvent.click(screen.getByRole("button", { name: /remove drop\.png/i }));

      expect(onRemove).toHaveBeenCalledWith("a2");
      // Removing a file is not answering the question — the dialog stays.
      expect(screen.getByTestId("confirm-modal")).toBeInTheDocument();
    });

    it("revokes a row's object URL when the dialog closes", () => {
      const revoke = vi.spyOn(URL, "revokeObjectURL");
      render(() => <ConfirmModal />);
      withAttachments([attachment({ thumbnail: new Blob(["x"], { type: "image/png" }) })], vi.fn());
      const src = screen.getByTestId("confirm-modal-attachment-thumb").getAttribute("src");
      expect(src).toMatch(/^blob:/);

      dismissConfirm();

      expect(revoke).toHaveBeenCalledWith(src);
      revoke.mockRestore();
    });
  });
});
