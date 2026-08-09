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
// That leaves refresh with nowhere to live. It first went into the pane's
// own band, beside the close ×; #1073 moved it again, into the rail's
// actions — vjt: *"il refresh puo' tranquillamente stare tra le actions
// nel rail, non serve cosi' prominente"*. The band it was in is now the
// shared channel bar and carries no controls of its own at all.
//
// The wiring is a module-level signal rather than a context or a prop
// chain because there is exactly one AdminPane mounted at a time and
// exactly one tab active within it — the same argument `lib/adminEvents`
// makes for its own module singleton. A tab REGISTERS its refresh on
// mount and unregisters on cleanup, so the header renders the button
// only when the active tab actually has something to re-fetch (Events
// has no fetch at all, and correctly contributes nothing).
//
// The registration carries the tab's own `testId`, so wherever the button
// is rendered it is still `admin-visitors-refresh` /
// `admin-sessions-refresh` / … — the ids the tabs' own suites assert. The
// button has now moved twice; neither move renamed it, which is what keeps
// a relocation distinguishable from a removal.

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
 * On a phone it is a row in the rail's actions (`RailActions`), reached
 * through the console's ☰. #1073 — the pane's band carries no controls,
 * and a re-fetch does not earn one of the two slots it used to hold.
 *
 * On desktop the pane header is a wide, near-empty band and the card the
 * data actually lives in has its own right-aligned actions slot, so the
 * button belongs there — next to what it refreshes rather than up in the
 * window furniture.
 *
 * ONE button either way, carrying the tab's own testid. Rendering it in
 * both places and hiding one with CSS would put a duplicate
 * `admin-*-refresh` in the DOM, which is exactly what the e2e specs
 * click. The two renderers therefore read this predicate with opposite
 * polarity and nothing else decides: `AdminCard` on true, `RailActions`
 * on false.
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
