import { createSignal } from "solid-js";
import { channelKey } from "./channelKey";
import { type ConfirmAttachment, dismissConfirm, requestConfirm } from "./confirmDialog";
import { formatBytes } from "./formatBytes";
import { categoryOf } from "./uploadCategory";
import { triggerUploads } from "./uploadOrchestrator";

// 1883 — the file-picker's confirm step.
//
// Picking a photo from the gallery used to reach the wire with no stop
// anywhere: `onPickerChange` handed `input.files` straight to
// `triggerUploads`. The only gate was the privacy modal, which is one-shot per
// host — so for every operator who has ticked "remember", the sequence was
// tap paperclip -> tap photo -> it is public. On a phone the gallery grid is
// dense and the thumbnails are small; a mis-tap picks the wrong photo and
// there is no undo, because the bytes are already on someone else's server and
// the link is already in the channel.
//
// This module is that missing step, and it is the PICKER's door only. Drop
// (DropUploadZone) and paste (pasteRoute) keep going straight through
// `dropUpload`: a drag onto a visible target is a gesture the operator aimed,
// and Ctrl-V is one they typed. A gallery tap is neither — the OS chose the
// grid, and the only thing between two adjacent thumbnails is a few
// millimetres. Extending the guard to those doors later is a call to
// `pickerUpload` from them; nothing here is picker-shaped except the call
// site (the name mirrors `dropUpload`, its sibling door, not a restriction).
//
// Deliberately NOT in `triggerUploads`: the orchestrator owns the queue, and a
// batch the operator has not authorised yet has no business being in it — it
// would take the channel's single upload slot, show an "(i/N)" counter for
// files that may never be sent, and make "cancel" mean two different things.
// The question is asked BEFORE the queue, and only the answer enters it.
//
// Deliberately NOT `dropUpload`, either, even though the shape is close: the
// picker path does NOT pre-filter by `categoryOf`, because iOS labels a .m4r
// ringtone `application/octet-stream` and `normalizeUploadFile` inside the
// orchestrator is what rescues it. Reusing `dropUpload` here would silently
// re-introduce that filter and drop the file before the rescue could run.
//
// There is no "don't ask again". A remembered opt-out is exactly the shape of
// the privacy flag that produced this defect: a gate that every returning
// operator has already switched off is not a gate. If the friction proves too
// high the answer is fewer taps, not a way to disarm it permanently.

// Row identity. Filenames are not unique (a gallery multi-select routinely
// yields two `IMG_0001.png`) and neither is the File object across two picks
// of the same photo, so the id is minted here and never derived.
let nextAttachmentId = 0;

type StagedFile = { id: string; file: File };

/**
 * Ask before uploading. Opens a confirm listing `files` with the destination
 * named, and calls `triggerUploads` with whatever survives — the full set on
 * Send, nothing at all on Cancel/Esc/backdrop, the remainder if rows were
 * removed. An empty `files` opens no dialog.
 *
 * Fire-and-forget: everything observable flows through the confirm store and,
 * after Send, through the orchestrator's own upload state.
 */
export function pickerUpload(files: File[], networkSlug: string, channelName: string): void {
  if (files.length === 0) return;

  const [staged, setStaged] = createSignal<StagedFile[]>(
    files.map((file) => {
      nextAttachmentId += 1;
      return { id: `picked-${nextAttachmentId}`, file };
    }),
  );

  requestConfirm({
    // The destination goes in the TITLE, which is also the dialog's
    // `aria-label` — the one string a screen reader announces on open, and the
    // one fact a mis-tap most needs to see. Target-neutral "to X" rather than
    // "in the channel": `channelName` is a nick on a query window.
    title: `Send to ${channelName}?`,
    // Count-free on purpose: the rows below ARE the count, and a number baked
    // into this string would start lying the moment a row is removed (the
    // request is not re-issued on removal — see ConfirmAttachments.items).
    body: "Each file below is uploaded and its link is posted there. This cannot be taken back.",
    confirmLabel: "Send",
    onConfirm: () => {
      triggerUploads(
        channelKey(networkSlug, channelName),
        networkSlug,
        channelName,
        staged().map((s) => s.file),
      );
    },
    // No third door: there is no other route to "post this file here". Cancel
    // and Send are the whole question.
    alternative: null,
    attachments: {
      items: (): ConfirmAttachment[] => staged().map(toAttachment),
      onRemove: (id: string): void => {
        const rest = staged().filter((s) => s.id !== id);
        setStaged(rest);
        // Removing the last row is the same answer as Cancel — an empty dialog
        // asking "send these?" has nothing to affirm. Dismiss rather than
        // leaving a Send button that would be a no-op.
        if (rest.length === 0) dismissConfirm();
      },
    },
  });
}

// A picture is the only preview worth showing: for every other category the
// bytes say nothing a human can check at a glance, and the name is what
// distinguishes `contract-final.pdf` from `contract-draft.pdf`. The blob is
// handed over raw — ConfirmModal mints and revokes the object URL, because the
// row's unmount is the only event that knows when it stops being needed.
function toAttachment(staged: StagedFile): ConfirmAttachment {
  return {
    id: staged.id,
    label: staged.file.name,
    detail: formatBytes(staged.file.size),
    thumbnail: categoryOf(staged.file.type) === "image" ? staged.file : null,
  };
}
