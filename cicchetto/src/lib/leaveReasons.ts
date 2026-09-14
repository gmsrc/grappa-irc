/**
 * issue 2150 — the two remembered leave reasons, cached client-side.
 *
 *   * `quitPartReason` — what goes on the wire when the subject leaves
 *     without typing a message (`/quit`, `/part`, the sidebar ×).
 *   * `autoAwayReason` — what the bouncer sends when IT marks them away
 *     after the auto-away debounce fires.
 *
 * The server owns the BEHAVIOUR for both: it resolves the stored value at
 * the moment it builds the wire line, so cic never injects either string
 * into a request. This module exists only so the settings controls can
 * render what is stored, write it when the user changes it, and mirror the
 * server's push so a change made on the phone shows up on the laptop.
 *
 * That is why they live together and away from `autoAway.ts`: the debounce
 * there is a NUMBER the control has to interpret (three states in one
 * scalar), while these two are opaque text with one shared rule.
 *
 * ## `null` is a value, and `""` is not a third state
 *
 * `null` means "nothing stored". For the quit/part reason the server then
 * falls back to its own literal; for the auto-away reason it keeps its own
 * constant — a string cic deliberately does NOT know, for the same reason
 * it does not know the default debounce: a copy here drifts the day the
 * server's changes.
 *
 * The empty string is not a separate state. The server normalises `""` to
 * `null` and deletes the key, so emptying the input IS the clear gesture
 * and needs no second verb.
 */

import { createSignal } from "solid-js";
import {
  getAutoAwayReason,
  getQuitPartReason,
  putAutoAwayReason,
  putQuitPartReason,
} from "./userSettings";

const [quitPartReason, setQuitPartReasonSignal] = createSignal<string | null>(null);
const [autoAwayReason, setAutoAwayReasonSignal] = createSignal<string | null>(null);

/** The cached QUIT/PART default: `null` when the subject has none. */
export function quitPartReasonValue(): string | null {
  return quitPartReason();
}

/** The cached auto-away reason: `null` when the subject has none. */
export function autoAwayReasonValue(): string | null {
  return autoAwayReason();
}

/**
 * Load the stored QUIT/PART default into the cache. Errors are swallowed:
 * the cache stays at `null`, which renders as an empty field — the same
 * thing the server reports for a subject with no default, so a failed read
 * shows the truth rather than a wrong string.
 */
export async function loadQuitPartReason(token: string): Promise<void> {
  try {
    setQuitPartReasonSignal(await getQuitPartReason(token));
  } catch {
    /* swallowed — the control falls back to "no default" */
  }
}

/** Load the stored auto-away reason. Same swallow rule as above. */
export async function loadAutoAwayReason(token: string): Promise<void> {
  try {
    setAutoAwayReasonSignal(await getAutoAwayReason(token));
  } catch {
    /* swallowed — the control falls back to "no default" */
  }
}

/**
 * Persist a new QUIT/PART default and mirror what the server echoed back —
 * not what we sent. The distinction is load-bearing: post `""` and the
 * server answers `null`, and the control must show the cleared state
 * rather than an empty string it invented.
 *
 * Throws `ApiError` on 4xx/5xx so the caller can surface the server's
 * message, which is where the byte ceiling and the CRLF rule are spelled.
 */
export async function saveQuitPartReason(token: string, reason: string | null): Promise<void> {
  setQuitPartReasonSignal(await putQuitPartReason(token, reason));
}

/** Persist a new auto-away reason. Same echo-back rule as above. */
export async function saveAutoAwayReason(token: string, reason: string | null): Promise<void> {
  setAutoAwayReasonSignal(await putAutoAwayReason(token, reason));
}

/**
 * Adopt a change the SERVER announced (the `quit_part_reason_changed`
 * push, fired for every write including ones from another device). cic
 * never originates this state — it only mirrors it.
 */
export function applyQuitPartReasonFromWire(reason: string | null): void {
  setQuitPartReasonSignal(reason);
}

/** Adopt a server-announced `auto_away_reason_changed`. */
export function applyAutoAwayReasonFromWire(reason: string | null): void {
  setAutoAwayReasonSignal(reason);
}

/** Test-only: drop both caches back to "no default". */
export function resetLeaveReasonsForTests(): void {
  setQuitPartReasonSignal(null);
  setAutoAwayReasonSignal(null);
}
