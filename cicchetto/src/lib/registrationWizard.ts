import { createRoot, createSignal } from "solid-js";
import { serviceMirrorRows } from "./serviceModal";

// #349 — NickServ registration wizard open/close + step store.
//
// Holds the whole wizard's transient state — or `null` when closed. The
// wizard walks six steps for one network:
//   1. intro   — "why register matters" copy.
//   2. email   — collect + format-validate the email.
//   3. password — collect + length-validate the password.
//   4. register — send `buildRegister(pw, email)` to NickServ, mirror the
//                 raw NOTICE replies; USER-advanced (+ a timeout guard),
//                 because REGISTER has no structural success terminator
//                 (register-accepted ≠ +r; +r only arrives after verify).
//   5. code    — collect the emailed confirmation code.
//   6. verify  — send `buildVerify(nick, code)`, mirror replies, and
//                auto-complete when the +r umode flips (the real, no-parse
//                terminator — same signal that hides the launch button).
//
// Module-singleton signal (like serviceModal / umodeModal) — transient
// UI, not identity-scoped survival state. A logout unmounts the shell so
// a stale-open wizard disappears with it.
//
// SECURITY: `email` + `password` live here for the modal's lifetime ONLY.
// `closeRegistrationWizard` drops the whole state (→ null), so the
// secrets never outlive the modal. They are never logged and never
// channel-echoed — the REGISTER send goes wire-only (the server's
// services-target path persists nothing). The `code` is the emailed
// confirmation token, not a long-term secret, but rides the same
// drop-on-close lifecycle.
//
// cic NEVER originates state: `stepSinceId` is a display bound (mirror
// NOTICEs arriving WHILE a send-step is open), and the only success
// signal the wizard reacts to is the server-pushed +r umode — no
// optimistic success, no client-side parse of NickServ text.

export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;

export const FIRST_STEP: WizardStep = 1;
export const LAST_STEP: WizardStep = 6;

export type RegistrationWizardState = {
  networkSlug: string;
  step: WizardStep;
  email: string;
  password: string;
  code: string;
  // High-water mirror message id captured when a send-step (4 / 6)
  // fires (via `setStepSince`). The modal mirrors NickServ NOTICEs with
  // `id > stepSinceId` — a structural bound on "replies to THIS step",
  // NOT a parse of their text (#91 no-scraping rule).
  stepSinceId: number;
  // In-flight send guard for a step's REST call (drives the spinner).
  pending: boolean;
  // Inline, per-step error text (validation or send failure). Cleared on
  // navigation + on a fresh input edit.
  error: string | null;
};

const clampStep = (n: number): WizardStep => {
  if (n <= FIRST_STEP) return FIRST_STEP;
  if (n >= LAST_STEP) return LAST_STEP;
  return n as WizardStep;
};

const exports_ = createRoot(() => {
  const [registrationWizardState, setRegistrationWizardState] =
    createSignal<RegistrationWizardState | null>(null);

  // Apply `fn` to the current open state; no-op when the wizard is
  // closed (a setter firing after close must not resurrect it).
  const patch = (fn: (st: RegistrationWizardState) => RegistrationWizardState): void => {
    setRegistrationWizardState((prev) => (prev === null ? null : fn(prev)));
  };

  const openRegistrationWizard = (networkSlug: string): void => {
    setRegistrationWizardState({
      networkSlug,
      step: FIRST_STEP,
      email: "",
      password: "",
      code: "",
      stepSinceId: 0,
      pending: false,
      error: null,
    });
  };

  const closeRegistrationWizard = (): void => {
    // Drops email + password + code with the state — secrets never
    // outlive the modal.
    setRegistrationWizardState(null);
  };

  const wizardNext = (): void => {
    patch((st) => ({ ...st, step: clampStep(st.step + 1), error: null }));
  };

  const wizardBack = (): void => {
    patch((st) => ({ ...st, step: clampStep(st.step - 1), error: null }));
  };

  // Capture the mirror high-water mark for the wizard's network so the modal's
  // NOTICE mirror shows only replies that arrive AFTER this send-step fired.
  // Shares `serviceMirrorRows` with `openServiceModal` — same capture, and the
  // same #400/#661 reason for spanning both windows: with the operator's
  // NickServ query window open the server re-keys every REGISTER/VERIFY reply
  // THERE, so a `$server`-only high-water both misses the replies and leaves
  // the query's pre-open history above the bound. `service` is the network's
  // services nick (the wizard's `template.servicesNick`), passed in by the
  // caller that already resolved the template.
  const setStepSince = (service: string): void => {
    patch((st) => {
      const rows = serviceMirrorRows(st.networkSlug, service);
      const stepSinceId = rows.reduce((max, m) => (m.id > max ? m.id : max), 0);
      return { ...st, stepSinceId };
    });
  };

  const setWizardEmail = (email: string): void => {
    patch((st) => ({ ...st, email, error: null }));
  };

  const setWizardPassword = (password: string): void => {
    patch((st) => ({ ...st, password, error: null }));
  };

  const setWizardCode = (code: string): void => {
    patch((st) => ({ ...st, code, error: null }));
  };

  const setWizardError = (error: string | null): void => {
    patch((st) => ({ ...st, error }));
  };

  const setWizardPending = (pending: boolean): void => {
    patch((st) => ({ ...st, pending }));
  };

  return {
    registrationWizardState,
    openRegistrationWizard,
    closeRegistrationWizard,
    wizardNext,
    wizardBack,
    setStepSince,
    setWizardEmail,
    setWizardPassword,
    setWizardCode,
    setWizardError,
    setWizardPending,
  };
});

export const registrationWizardState = exports_.registrationWizardState;
export const openRegistrationWizard = exports_.openRegistrationWizard;
export const closeRegistrationWizard = exports_.closeRegistrationWizard;
export const wizardNext = exports_.wizardNext;
export const wizardBack = exports_.wizardBack;
export const setStepSince = exports_.setStepSince;
export const setWizardEmail = exports_.setWizardEmail;
export const setWizardPassword = exports_.setWizardPassword;
export const setWizardCode = exports_.setWizardCode;
export const setWizardError = exports_.setWizardError;
export const setWizardPending = exports_.setWizardPending;
