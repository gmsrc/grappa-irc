import { beforeEach, describe, expect, it, vi } from "vitest";

// 1883 — the gallery-pick confirm. Between "the native picker returned a
// file" and "the bytes are on their way to the channel" there is now one
// deliberate step: a confirm that SHOWS what is about to be sent and where.
//
// The orchestrator is the boundary (mocked): what this file proves is
// exactly WHEN it is reached and with WHAT — never before the operator has
// said Send, and never with a file they took back. `channelKey` is mocked
// to the same `${slug} ${name}` shape dropUpload.test.ts uses so the
// assertions read plainly.

vi.mock("../lib/uploadOrchestrator", () => ({
  triggerUploads: vi.fn(),
}));

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

import {
  acceptConfirm,
  type ConfirmAttachment,
  confirmRequest,
  dismissConfirm,
} from "../lib/confirmDialog";
import { pickerUpload } from "../lib/pickerUpload";
import { triggerUploads } from "../lib/uploadOrchestrator";

const png = (name: string): File =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });
const pdf = (name: string): File =>
  new File([new Uint8Array(2048)], name, { type: "application/pdf" });
// iOS labels a .m4r ringtone octet-stream; `categoryOf` rejects that MIME.
// The picker deliberately does NOT pre-filter — `normalizeUploadFile` in the
// orchestrator is what rescues it (ComposeBox.onPickerChange's contract).
const ringtone = (): File =>
  new File([new Uint8Array(8)], "ring.m4r", { type: "application/octet-stream" });

const attachments = (): ConfirmAttachment[] => confirmRequest()?.attachments?.items() ?? [];

beforeEach(() => {
  vi.clearAllMocks();
  dismissConfirm();
});

describe("pickerUpload — the confirm step (1883)", () => {
  it("an empty pick opens no dialog and uploads nothing", () => {
    pickerUpload([], "freenode", "#a");
    expect(confirmRequest()).toBeNull();
    expect(triggerUploads).not.toHaveBeenCalled();
  });

  it("a pick opens a confirm and uploads NOTHING until it is answered", () => {
    pickerUpload([png("cat.png")], "freenode", "#a");
    const req = confirmRequest();
    expect(req).not.toBeNull();
    // The destination is on screen — this is the whole point of the step. It
    // lives in the title, which is also the dialog's aria-label.
    expect(req?.title).toContain("#a");
    expect(req?.confirmLabel).toBe("Send");
    expect(triggerUploads).not.toHaveBeenCalled();
  });

  it("the confirm lists every picked file by name and size", () => {
    pickerUpload([png("cat.png"), pdf("spec.pdf")], "freenode", "#a");
    expect(attachments().map((a) => a.label)).toEqual(["cat.png", "spec.pdf"]);
    // Size is spelled by the ONE cap/size formatter (#411), not re-invented.
    expect(attachments()[1]?.detail).toBe("2 KB");
  });

  it("an image carries a thumbnail source; a non-image carries none", () => {
    const cat = png("cat.png");
    pickerUpload([cat, pdf("spec.pdf")], "freenode", "#a");
    expect(attachments()[0]?.thumbnail).toBe(cat);
    expect(attachments()[1]?.thumbnail).toBeNull();
  });

  it("Send uploads exactly the picked files to the picked window", () => {
    const a = png("a.png");
    const b = png("b.png");
    pickerUpload([a, b], "freenode", "#a");

    acceptConfirm();

    expect(triggerUploads).toHaveBeenCalledWith("freenode #a", "freenode", "#a", [a, b]);
  });

  it("Cancel / Esc / backdrop upload NOTHING", () => {
    pickerUpload([png("oops.png")], "freenode", "#a");

    dismissConfirm();

    expect(triggerUploads).not.toHaveBeenCalled();
    expect(confirmRequest()).toBeNull();
  });

  it("removing one file drops it from the batch — Send posts only the rest", () => {
    const keep = png("keep.png");
    const drop = png("drop.png");
    pickerUpload([keep, drop], "freenode", "#a");

    const removed = attachments()[1];
    expect(removed?.label).toBe("drop.png");
    confirmRequest()?.attachments?.onRemove(removed?.id ?? "");

    expect(attachments().map((a) => a.label)).toEqual(["keep.png"]);
    acceptConfirm();
    expect(triggerUploads).toHaveBeenCalledWith("freenode #a", "freenode", "#a", [keep]);
  });

  it("removing the LAST file closes the dialog and uploads nothing", () => {
    pickerUpload([png("only.png")], "freenode", "#a");

    confirmRequest()?.attachments?.onRemove(attachments()[0]?.id ?? "");

    expect(confirmRequest()).toBeNull();
    expect(triggerUploads).not.toHaveBeenCalled();
  });

  it("two picks with the same filename stay separately removable", () => {
    const first = png("IMG_0001.png");
    const second = png("IMG_0001.png");
    pickerUpload([first, second], "freenode", "#a");

    const ids = attachments().map((a) => a.id);
    expect(new Set(ids).size).toBe(2);
    confirmRequest()?.attachments?.onRemove(ids[0] ?? "");

    acceptConfirm();
    expect(triggerUploads).toHaveBeenCalledWith("freenode #a", "freenode", "#a", [second]);
  });

  it("does NOT pre-filter by category — an iOS .m4r still reaches the orchestrator", () => {
    const m4r = ringtone();
    pickerUpload([m4r], "freenode", "#a");
    expect(attachments()).toHaveLength(1);

    acceptConfirm();

    expect(triggerUploads).toHaveBeenCalledWith("freenode #a", "freenode", "#a", [m4r]);
  });

  it("a second pick replaces the pending confirm rather than stacking one", () => {
    pickerUpload([png("first.png")], "freenode", "#a");
    pickerUpload([png("second.png")], "freenode", "#b");
    expect(attachments().map((a) => a.label)).toEqual(["second.png"]);

    acceptConfirm();

    expect(triggerUploads).toHaveBeenCalledTimes(1);
    expect(triggerUploads).toHaveBeenCalledWith("freenode #b", "freenode", "#b", [
      expect.objectContaining({ name: "second.png" }),
    ]);
  });
});
