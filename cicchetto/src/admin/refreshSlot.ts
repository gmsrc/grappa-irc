import { createSignal, onCleanup, onMount } from "solid-js";
import { isMobile } from "../lib/theme";

// Admin redesign (2026-08-07 mobile review) — the active tab's refresh
// action, hoisted into the pane header.
//
// Most tabs had a toolbar whose entire content was the tab's own name
// and a refresh button. The name is redundant — the nav above already
// says which tab you are in — so the whole band was a wasted row that
// pushed the actual data down. The toolbar survives ONLY where it
// carries something the nav cannot (Networks: the Sweep-visitors verb
// plus a line explaining what the caps column means).
//
// That leaves refresh with nowhere to live, and it belongs next to the
// pane's close button: one row of chrome, at the top, always in the
// same place regardless of tab.
//
// The wiring is a module-level signal rather than a context or a prop
// chain because there is exactly one AdminPane mounted at a time and
// exactly one tab active within it — the same argument `lib/adminEvents`
// makes for its own module singleton. A tab REGISTERS its refresh on
// mount and unregisters on cleanup, so the header renders the button
// only when the active tab actually has something to re-fetch (Events
// has no fetch at all, and correctly contributes nothing).
//
// The registration carries the tab's own `testId`, so the button in the
// header is still `admin-visitors-refresh` / `admin-sessions-refresh` /
// … — the ids the e2e specs click. Moving the button must not rename it.

export type RefreshRegistration = {
  onRefresh: () => void;
  busy: () => boolean;
  /** Accessible name, e.g. "refresh visitors list". */
  label: string;
  /** The tab's pre-existing refresh testid. */
  testId: string;
};

const [registration, setRegistration] = createSignal<RefreshRegistration | null>(null);

export const refreshSlot = registration;

/**
 * Where the registered refresh button is rendered.
 *
 * On a phone it goes in the pane header, beside the close ×: there is
 * one row of chrome up there and no room for anything else.
 *
 * On desktop the pane header is a wide, near-empty band and the card the
 * data actually lives in has its own right-aligned actions slot, so the
 * button belongs there — next to what it refreshes rather than up in the
 * window furniture.
 *
 * ONE button either way, carrying the tab's own testid. Rendering it in
 * both places and hiding one with CSS would put a duplicate
 * `admin-*-refresh` in the DOM, which is exactly what the e2e specs
 * click.
 */
export function refreshInCardHead(): boolean {
  return !isMobile();
}

/**
 * Publish this tab's refresh action to the pane header for as long as the
 * tab is mounted. Call once from the component body.
 *
 * The cleanup compares identity before clearing: on a tab switch Solid
 * mounts the incoming tab before disposing the outgoing one, so an
 * unconditional clear would wipe the new tab's registration.
 */
export function useRefreshSlot(reg: RefreshRegistration): void {
  onMount(() => setRegistration(reg));
  onCleanup(() => setRegistration((cur) => (cur === reg ? null : cur)));
}
