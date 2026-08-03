import { createSignal } from "solid-js";
import type { RecoverOutcome, RecoverStatus, RecoverStep, WireUserEvent } from "./api";
import { moduleRoot } from "./moduleRoot";

// #581 — "recover my identity" progress store.
//
// Holds the whole recovery's transient state — or `null` when closed. The
// server drives a short sequence of steps (identify → register → nick →
// recover → release), each transitioning running → ok/failed, then a single
// TERMINAL result (succeeded / failed). cic mirrors the server-pushed events
// into this store; the RecoverModal renders it.
//
// cic NEVER originates recovery state (CLAUDE.md hard invariant): there is no
// optimistic open, no client-side step machine, no success/failure guessed
// from anything cic computes. The FIRST `recover_progress` event OPENS the
// modal; subsequent progress events accumulate/update the step list; the
// `recover_result` event concludes it. `patch` no-ops when closed EXCEPT the
// opening event — a `recover_result` (or a late progress update) that lands
// after the user dismissed the modal MUST NOT resurrect it.
//
// Module-singleton signal (like serviceModal / registrationWizard) — transient
// UI, not identity-scoped survival state. A logout unmounts the shell so a
// stale-open modal disappears with it.
//
// A `recover_result` arriving while CLOSED is dropped (patch no-op): either the
// user dismissed mid-flight (don't reopen a modal they closed) or the progress
// events were never seen this session (nothing to conclude). The dominant path
// — progress-then-result on a modal the user just opened via /recover — is
// unaffected.

export type RecoverStepEntry = {
  step: RecoverStep;
  status: RecoverStatus;
  reason: string | null;
};

export type RecoverState = {
  networkSlug: string;
  // Steps in server-arrival order; each `step` appears once (later events for
  // the same step UPDATE it in place — a running row flips to ok/failed).
  steps: RecoverStepEntry[];
  // null while in flight; set by the terminal `recover_result` event.
  outcome: RecoverOutcome | null;
  // The failure reason token (cic-localized in RecoverModal), or null.
  reason: string | null;
};

type RecoverProgressEvent = Extract<WireUserEvent, { kind: "recover_progress" }>;
type RecoverResultEvent = Extract<WireUserEvent, { kind: "recover_result" }>;

// Upsert a step by name: update the existing row in place, else append. Keeps
// each step to a single row so a running → ok/failed transition replaces rather
// than duplicating (the modal renders one row per step).
function upsertStep(steps: RecoverStepEntry[], evt: RecoverProgressEvent): RecoverStepEntry[] {
  const entry: RecoverStepEntry = { step: evt.step, status: evt.status, reason: evt.reason };
  const idx = steps.findIndex((s) => s.step === evt.step);
  if (idx === -1) return [...steps, entry];
  const next = steps.slice();
  next[idx] = entry;
  return next;
}

const exports_ = moduleRoot(() => {
  const [recoverState, setRecoverState] = createSignal<RecoverState | null>(null);

  // Apply `fn` to the current open state; no-op when closed (a late event must
  // not resurrect a dismissed modal). The opening event (first progress)
  // bypasses this via setRecoverState directly.
  const patch = (fn: (st: RecoverState) => RecoverState): void => {
    setRecoverState((prev) => (prev === null ? null : fn(prev)));
  };

  // First `recover_progress` OPENS the modal (the sole cic-originated
  // transition: presence of the modal mirrors the server sending recover
  // events); subsequent events accumulate/update the step list.
  const applyRecoverProgress = (evt: RecoverProgressEvent): void => {
    setRecoverState((prev) => {
      // The first progress OPENS the modal for its network.
      if (prev === null) {
        return {
          networkSlug: evt.network,
          steps: [{ step: evt.step, status: evt.status, reason: evt.reason }],
          outcome: null,
          reason: null,
        };
      }
      // Per-network isolation (review-#3): an event for a DIFFERENT network
      // than the open modal is not ours to apply — a multi-network visitor
      // could have a recover in flight on network A while a stray B event
      // lands. Ignore it rather than mix two networks' steps into one modal.
      if (evt.network !== prev.networkSlug) return prev;
      return { ...prev, steps: upsertStep(prev.steps, evt) };
    });
  };

  // Terminal outcome. Routed through `patch` so it no-ops when the modal is
  // closed (dismissed mid-flight, or never opened this session). The
  // per-network guard mirrors applyRecoverProgress: only the open modal's OWN
  // network concludes it (review-#3).
  const applyRecoverResult = (evt: RecoverResultEvent): void => {
    patch((st) =>
      evt.network === st.networkSlug ? { ...st, outcome: evt.outcome, reason: evt.reason } : st,
    );
  };

  const dismissRecover = (): void => {
    setRecoverState(null);
  };

  return { recoverState, applyRecoverProgress, applyRecoverResult, dismissRecover };
});

export const recoverState = exports_.recoverState;
export const applyRecoverProgress = exports_.applyRecoverProgress;
export const applyRecoverResult = exports_.applyRecoverResult;
export const dismissRecover = exports_.dismissRecover;
