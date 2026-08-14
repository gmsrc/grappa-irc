import { createSignal } from "solid-js";
import { moduleRoot } from "./moduleRoot";

// #392 — session-share modal open/close. A module-singleton boolean signal
// (like serviceModal / umodeModal). The share is SESSION-WIDE (it shares the
// whole cic session across every network), so — unlike the per-network
// registration wizard — it carries NO argument, just open/closed.
//
// ONE modal instance is mounted in Shell; BOTH triggers flip this signal:
//   * the home pane's "open on another device" button (after the network list)
//   * the settings pane's share entry
// so there is a single source of truth for the share UI — one modal, two
// doors. (#392 reverses #335's sub-page back to a modal because the QR +
// countdown + native-share now warrant a focused overlay reachable from home.)
//
// Transient UI state, not identity-scoped survival — a logout unmounts the
// shell and the flag resets with it.

// #462 — the affordance's NAME, declared once beside the signal that opens
// it. Three surfaces render it (home button, settings entry, modal title) and
// each used to spell it itself; the settings one said "share session" while
// the other two said "open on another device", which is what the issue
// reports. A shared constant is the only shape in which three renderings of
// one name cannot disagree. Not inside `moduleRoot` — that scopes REACTIVE
// state to a root; a frozen string has no lifecycle to scope.
export const SHARE_SESSION_LABEL = "open on another device";

// #1306 — the ONE gate question behind both doors: may THIS subject be
// shared to a second device? It used to be spelled `isVisitor() &&
// !isIncognito()` in each of the two callers, because the server 403'd a
// password subject. It mints for a user now, so the visitor half is gone
// and the incognito half (#363 — an ephemeral session must not be made
// portable) is the whole rule.
//
// Single-sourced rather than repeated per caller: the two doors read
// DIFFERENT subject sources (the home pane reads the /me resource so a
// mid-session refetch is honoured, the settings drawer reads the persisted
// subject), but they must answer the same question, and a gate that drifts
// between two entry points to one modal shows a button on one screen and
// hides it on the other. Structural parameter so both sources fit without
// either importing the other's type.
//
// A null subject is NOT shareable: "not loaded yet" is not "allowed".
export function isShareableSubject(
  subject: { kind: "user" } | { kind: "visitor"; incognito?: boolean } | null | undefined,
): boolean {
  if (subject === null || subject === undefined) return false;
  return !(subject.kind === "visitor" && subject.incognito === true);
}

const exports_ = moduleRoot(() => {
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
