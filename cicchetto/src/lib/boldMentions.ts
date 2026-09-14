import { createSignal } from "solid-js";
import { moduleRoot } from "./moduleRoot";

// issue 2167 — "bold on own-nick mention rows" display preference. Boolean, ON
// by default: the rows render exactly as they do today and the opt-out is a
// choice, never a default change.
//
// Reported on IRC as genuinely contested — one user called the bold annoying
// and another "comodissimo" in the same channel — which is the argument for a
// preference rather than flipping the default. The ask that produced it was a
// free-form CUSTOM CSS block; vjt ruled that down (option A) in favour of
// first-class validated preferences, reason given: "così sono accessibili a
// tutti" — a real preference is usable by everyone, a CSS block only by people
// who write CSS.
//
// ## The bold CARRIES WEIGHT — this is the constraint, not a detail
//
// `.scrollback-line.scrollback-highlight` (watchlist match) is deliberately
// NOT bold so the two states read differently, and the stylesheet says so. So
// removing the bold must not make a mention row and a highlight row identical.
// It does not: the mention keeps the flat `--mention` background while the
// highlight takes a 12% `--accent` mix, and the highlight paints a 2px accent
// bar in the gutter (#1298) that the mention has no counterpart for. Two axes
// survive, and `mentionBoldDistinction.test.ts` fails if a later edit lets
// this preference reach either of them.
//
// ## SHAPE: showBottomBar.ts, not stripFormatting.ts
//
// Both are #449 synced booleans, but this default is TRUE, so the read is
// showBottomBar.ts's `v !== "false"` rather than stripFormatting.ts's
// `v === "true"`. Not a style choice: with a default of ON, `v === "true"`
// reads unparseable storage as OFF and hands the opt-out to anyone whose
// localStorage carries a stale or corrupted value.
//
// ## POSTURE: synced, on #1766's criterion rather than a coin toss
//
// A per-device toggle is right when the complaint is about a VIEWPORT (#914's
// `hideNextActive`; fontSize.ts, which is a screen-size property) and wrong
// when it is about the ACCOUNT. "The bold annoys me" is identical on a phone
// and on a desktop — the account axis — and the nearest neighbour by shape,
// `strip_formatting` (#2029), is synced for that same reason. Two adjacent
// checkboxes in one fieldset that persist differently is the surprise this
// avoids. localStorage is the boot/offline cache for a FOUC-free first paint,
// not the source of truth: the server wins on login, or is seeded up once when
// it has never persisted. `setBoldMentions` stays LOCAL-only; the
// coordinator's `syncedSetBoldMentions` adds the PUT.
//
// ## Why a CSS custom property AND a signal
//
// The property is what removes the weight: one write on `<html>` restyles
// every mention row already in the DOM, with no re-render, no per-row class
// and no scrollback churn — which is what makes "toggle it back without a
// reconnect" true. The signal exists for the SettingsDrawer checkbox, which
// binds to the accessor directly (no drawer-local mirror, same as its two
// neighbours). Neither alone suffices: a bare property write leaves the
// checkbox stale, a bare signal leaves the rows bold.

const STORAGE_KEY = "cicchetto.boldMentions";
const DEFAULT_BOLD = true;

// The property the stylesheet reads as `var(--mention-font-weight, bold)`. The
// fallback there is what covers the pre-boot frame, so this module never has
// to race the first paint — it only has to agree with it.
const PREF_VAR = "--mention-font-weight";

function readStored(): boolean {
  const v = localStorage.getItem(STORAGE_KEY);
  // Anything that is not the literal "false" reads as bold — the default is
  // the conservative side here, since the alternative is silently taking a
  // visual cue away from a reader who never asked.
  return v === null ? DEFAULT_BOLD : v !== "false";
}

function writeCssVar(on: boolean): void {
  document.documentElement.style.setProperty(PREF_VAR, on ? "bold" : "normal");
}

// Module-singleton signal seeded from storage. createRoot anchors it for the
// app lifetime (same shape as showBottomBar.ts) — the preference is
// identity-agnostic, so no token-rotation reset arm is needed.
const { current, setCurrent } = moduleRoot(() => {
  const [current, setCurrent] = createSignal<boolean>(readStored());
  return { current, setCurrent };
});

export function getBoldMentions(): boolean {
  return current();
}

export function setBoldMentions(on: boolean): void {
  localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  setCurrent(on);
  writeCssVar(on);
}

// Boot-time entry. Reads the stored preference (falling back to bold) and
// writes the property on `<html>` so the first frame already carries the
// reader's choice — the FOUC-free mirror, same job as fontSize.ts's
// `applyFontSizeFromStorage`.
export function applyBoldMentionsFromStorage(): void {
  writeCssVar(readStored());
}
