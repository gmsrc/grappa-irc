/**
 * #348 — the auto-away debounce preference, cached client-side.
 *
 * The server owns the behaviour: it is the thing that waits and then
 * sends `AWAY` upstream. cic only reads the stored preference so the
 * settings control can render it, writes it when the user changes it,
 * and mirrors the server's push so a change made on the phone shows up
 * on the laptop without a reload.
 *
 * Three states in one value, matching the wire: `null` = no preference
 * (the server's own default applies — a number cic deliberately does
 * not know), `0` = off, `N` = seconds.
 */

import { createSignal } from "solid-js";
import { getAutoAwayDebounceSeconds, putAutoAwayDebounceSeconds } from "./userSettings";

const [autoAwayDebounce, setAutoAwayDebounceSignal] = createSignal<number | null>(null);

/** The cached preference: `null` (server default), `0` (off) or seconds. */
export function autoAwayDebounceValue(): number | null {
  return autoAwayDebounce();
}

/**
 * Load the stored preference into the cache. Errors are swallowed: the
 * cache stays at `null`, which renders as "use site default" — the same
 * thing the server does for a subject with no preference, so a failed
 * read shows the truth rather than a wrong number.
 */
export async function loadAutoAwayDebounce(token: string): Promise<void> {
  try {
    setAutoAwayDebounceSignal(await getAutoAwayDebounceSeconds(token));
  } catch {
    /* swallowed — the control falls back to "use site default" */
  }
}

/**
 * Persist a new preference and mirror what the server echoed back — not
 * what we sent. Throws `ApiError` on 4xx/5xx so the caller can surface
 * the server's message (which is where the accepted range is spelled).
 */
export async function saveAutoAwayDebounce(token: string, seconds: number | null): Promise<void> {
  setAutoAwayDebounceSignal(await putAutoAwayDebounceSeconds(token, seconds));
}

/**
 * Adopt a change the SERVER announced (the `auto_away_debounce_changed`
 * push, fired for every write including ones from another device). cic
 * never originates this state — it only mirrors it.
 */
export function applyAutoAwayDebounceFromWire(seconds: number | null): void {
  setAutoAwayDebounceSignal(seconds);
}

/** Test-only: drop the cache back to "no preference". */
export function resetAutoAwayDebounceForTests(): void {
  setAutoAwayDebounceSignal(null);
}
