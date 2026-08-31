import { type Component, createEffect, For, onCleanup, Show } from "solid-js";
import {
  acceptConfirm,
  type ConfirmAttachment,
  chooseAlternative,
  confirmRequest,
  dismissConfirm,
} from "./lib/confirmDialog";
import { createOverlayLock } from "./lib/overlayScrollLock";

// #195 — explicit confirm modal for destructive window actions (leave
// channel, disconnect network). Store-driven singleton (lib/confirmDialog);
// mounted once per Shell layout branch (mobile + desktop). Replaces the
// removed #172 hold-to-close gesture.
//
// Cancel is the SAFE default: it takes initial focus (so a stray Enter
// dismisses, never leaves), and backdrop-click + Esc both dismiss without
// firing. Only the explicit affirmative button runs the carried action.
// Structure mirrors DeleteAccountModal (backdrop-nested dialog + overlay
// scroll-lock), the closest existing confirm-shaped modal.
//
// 1883 — an OPTIONAL attachment list sits between the body and the buttons,
// for requests whose question is about FILES. It is the same chrome, not a
// second modal: the file-upload confirm gets the same scrim, the same Esc, the
// same Cancel-first focus order as every other confirm in cic, and cic gains
// no new overlay to keep consistent. The rows arrive pre-formatted (see
// ConfirmAttachment) — this component decides layout and object-URL lifetime,
// nothing else.

// One attachment row. Its OWN component so the object URL can be minted and
// revoked by the row's lifecycle: `onCleanup` here fires when the row leaves —
// whether that is a per-file removal, a Send, or a dismiss — which is the only
// place that knows the URL is finished with. Doing it in the store would need
// a dismiss hook the store deliberately does not have; doing it in the caller
// would leak on every path it forgot.
const AttachmentRow: Component<{
  item: ConfirmAttachment;
  onRemove: (id: string) => void;
}> = (props) => {
  // Read once, not reactively: `<For>` hands each row a stable item object, so
  // a row's blob never changes under it — a re-mint would only churn URLs.
  const blob = props.item.thumbnail;
  const src = blob === null ? null : URL.createObjectURL(blob);
  if (src !== null) onCleanup(() => URL.revokeObjectURL(src));

  return (
    <li class="confirm-modal-attachment" data-testid="confirm-modal-attachment">
      <Show
        when={src}
        fallback={
          <span class="confirm-modal-attachment-icon" aria-hidden="true">
            {/* No picture to show — a neutral placeholder keeps the rows the
                same height so a mixed batch does not read as ragged. */}
            &#9744;
          </span>
        }
      >
        {(url) => (
          <img
            class="confirm-modal-attachment-thumb"
            data-testid="confirm-modal-attachment-thumb"
            src={url()}
            // The filename beside it is the accessible label; announcing the
            // picture too would read the same file twice.
            alt=""
          />
        )}
      </Show>
      <span class="confirm-modal-attachment-text">
        <span class="confirm-modal-attachment-name">{props.item.label}</span>
        <span class="confirm-modal-attachment-detail">{props.item.detail}</span>
      </span>
      <button
        type="button"
        class="confirm-modal-attachment-remove"
        // Named per file: three bare × buttons are indistinguishable to a
        // screen reader, and picking the wrong one is the very mistake this
        // dialog exists to catch.
        aria-label={`Remove ${props.item.label}`}
        onClick={() => props.onRemove(props.item.id)}
      >
        &times;
      </button>
    </li>
  );
};

const ConfirmModal: Component = () => {
  let cancelBtn: HTMLButtonElement | undefined;

  // Overlay scroll-lock + #232 shared Esc-to-close. dismissConfirm is the
  // same SAFE close verb Cancel / backdrop use — Esc never fires the carried
  // action (topmost-first, focus-independent).
  createOverlayLock(() => confirmRequest() !== null, ".confirm-modal", dismissConfirm);

  // Autofocus Cancel on open — the non-destructive default per #195 (a stray
  // Enter dismisses, never confirms). Edge-triggered so a re-render with the
  // same open value doesn't re-steal focus.
  let wasOpen = false;
  createEffect(() => {
    const open = confirmRequest() !== null;
    if (open && !wasOpen) {
      wasOpen = true;
      queueMicrotask(() => cancelBtn?.focus());
    } else if (!open && wasOpen) {
      wasOpen = false;
    }
  });

  return (
    <Show when={confirmRequest()}>
      {(req) => (
        // Modal nested INSIDE the backdrop (flex-centered child): a click on
        // the modal lands on the modal, a click on the scrim dismisses.
        // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc via the shared overlay stack (keybindings → runTopmostOverlayEscape)
        // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is a non-interactive scrim
        <div
          class="modal-backdrop modal-backdrop-full confirm-modal-backdrop"
          onClick={dismissConfirm}
          data-testid="confirm-modal-backdrop"
        >
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: inner dialog onClick only stops backdrop-click propagation; Esc closes via the shared overlay stack */}
          <div
            class="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-label={req().title}
            data-testid="confirm-modal"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 class="confirm-modal-title">{req().title}</h2>
            <p class="confirm-modal-body" data-testid="confirm-modal-body">
              {req().body}
            </p>
            {/* 1883 — the file list, when the request carries one. Between
                the question and the buttons: the operator reads what is
                about to happen, sees WHAT it happens to, then answers. */}
            <Show when={req().attachments}>
              {(atts) => (
                <ul class="confirm-modal-attachments" data-testid="confirm-modal-attachments">
                  <For each={atts().items()}>
                    {(item) => <AttachmentRow item={item} onRemove={atts().onRemove} />}
                  </For>
                </ul>
              )}
            </Show>
            <div class="confirm-modal-actions">
              <button
                ref={cancelBtn}
                type="button"
                class="confirm-modal-cancel"
                data-testid="confirm-modal-cancel"
                onClick={dismissConfirm}
              >
                Cancel
              </button>
              {/* #816 — the optional third door, between Cancel and the
                  affirmative: a DIFFERENT route to what the operator wanted,
                  not a softer yes. Placed here so the affirmative keeps the
                  last (default-reading) slot and Cancel keeps the first. */}
              <Show when={req().alternative}>
                {(alt) => (
                  <button
                    type="button"
                    class="confirm-modal-alternative"
                    data-testid="confirm-modal-alternative"
                    onClick={chooseAlternative}
                  >
                    {alt().label}
                  </button>
                )}
              </Show>
              <button
                type="button"
                class="confirm-modal-confirm"
                data-testid="confirm-modal-confirm"
                onClick={acceptConfirm}
              >
                {req().confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default ConfirmModal;
