import { createRoot, createSignal } from "solid-js";

// #392 — session-share modal open/close. A module-singleton boolean signal
// (like serviceModal / umodeModal). The share is SESSION-WIDE (it shares the
// whole cic session across every network), so — unlike the per-network
// registration wizard — it carries NO argument, just open/closed.
//
// ONE modal instance is mounted in Shell; BOTH triggers flip this signal:
//   * the home pane's "open on another device" button (after the network list)
//   * the settings pane's "share session" button
// so there is a single source of truth for the share UI — one modal, two
// doors. (#392 reverses #335's sub-page back to a modal because the QR +
// countdown + native-share now warrant a focused overlay reachable from home.)
//
// Transient UI state, not identity-scoped survival — a logout unmounts the
// shell and the flag resets with it.

const exports_ = createRoot(() => {
  const [shareModalOpen, setShareModalOpen] = createSignal(false);
  const openShareModal = (): void => {
    setShareModalOpen(true);
  };
  const closeShareModal = (): void => {
    setShareModalOpen(false);
  };
  return { shareModalOpen, openShareModal, closeShareModal };
});

export const shareModalOpen = exports_.shareModalOpen;
export const openShareModal = exports_.openShareModal;
export const closeShareModal = exports_.closeShareModal;
