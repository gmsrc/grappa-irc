import { createSignal } from "solid-js";
import { moduleRoot } from "./moduleRoot";

// #1773 — the credits easter egg's open/close state, plus the one preference
// it carries.
//
// A module-singleton signal, like `shareModal` / `serviceModal`: ONE modal
// instance is mounted in Shell and the settings drawer's credits entry flips
// this flag. It cannot live inside SettingsDrawer, and that is a constraint
// rather than a style choice — `.settings-drawer` animates on `transform`,
// which makes it the containing block for any `position: fixed` descendant,
// so a full-screen modal rendered inside it would be clipped to the drawer.
//
// `creditsMuted` is session-scoped and NOT persisted. It is a transient UI
// preference for a surface you open on purpose; writing it to the settings
// store would put an easter egg in the operator's saved preferences, and
// re-reading it there is a round trip for a thing you re-decide in one tap.
// It does survive close-and-reopen within a session, which is the case that
// actually annoys.

/** The affordance's name, declared once beside the signal that opens it. */
export const CREDITS_LABEL = "credits";

const exports_ = moduleRoot(() => {
  const [creditsModalOpen, setCreditsModalOpen] = createSignal(false);
  const [creditsMuted, setCreditsMuted] = createSignal(false);

  const openCreditsModal = (): void => {
    setCreditsModalOpen(true);
  };
  const closeCreditsModal = (): void => {
    setCreditsModalOpen(false);
  };
  const toggleCreditsMuted = (): void => {
    setCreditsMuted((muted) => !muted);
  };

  return {
    creditsModalOpen,
    openCreditsModal,
    closeCreditsModal,
    creditsMuted,
    toggleCreditsMuted,
  };
});

export const creditsModalOpen = exports_.creditsModalOpen;
export const openCreditsModal = exports_.openCreditsModal;
export const closeCreditsModal = exports_.closeCreditsModal;
export const creditsMuted = exports_.creditsMuted;
export const toggleCreditsMuted = exports_.toggleCreditsMuted;
