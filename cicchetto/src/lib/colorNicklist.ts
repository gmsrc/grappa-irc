import { createSignal } from "solid-js";
import { moduleRoot } from "./moduleRoot";

// #443 — "show colored nicklist" display preference. Boolean, OFF by
// default: the members pane renders nicks monochrome on purpose
// (MembersPane passes `noColor` to NickText) because there the color
// channel encodes the mode tier, not identity. A user can opt into per-nick
// colors; the mode-prefix glyph keeps its own tier color either way, so the
// tier signal survives.
//
// ## Why a signal (mirrors timeFormat.ts, NOT fontSize.ts)
//
// fontSize.ts applies its effect as a boot-time CSS-var write on <html>, so
// a plain localStorage read suffices. This flag is consumed at RENDER time
// by MembersPane, so a bare localStorage.getItem in the render path would
// not re-run when the setting changes. Backing it with a module-singleton
// Solid signal (createRoot, mirroring timeFormat.ts) makes it reactive:
// reading it inside a SolidJS render tracks the signal, so toggling it
// re-renders the open nicklist live. A CSS-only variant does not work here:
// with `noColor` there is no per-nick inline color to reveal — the color
// comes from the prop path, so the prop is what has to flip.
//
// ## Server-backed since #449 (localStorage is now the offline/write-through cache)
//
// This flag is one of the three server-backed display prefs (with #222
// presence filter + #217 time format), coordinated by `displayPrefs.ts` over
// `GET/PUT /me/settings/display-prefs` so a single account converges its UI
// across devices. localStorage is no longer the source of truth — it is the
// boot/offline cache for a FOUC-free first paint; the server wins on login (or
// is seeded up once when it has never persisted). `setColoredNicklist` stays
// LOCAL-only (signal + localStorage write-through); the coordinator's
// `syncedSetColoredNicklist` adds the PUT.

const STORAGE_KEY = "cicchetto.coloredNicklist";
const DEFAULT_ON = false;

function readStored(): boolean {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === null ? DEFAULT_ON : v === "true";
}

// Module-singleton signal seeded from storage. createRoot anchors it for the
// app lifetime (same shape as timeFormat.ts) — the preference is
// identity-agnostic, so no token-rotation reset arm is needed.
const { current, setCurrent } = moduleRoot(() => {
  const [current, setCurrent] = createSignal<boolean>(readStored());
  return { current, setCurrent };
});

export function getColoredNicklist(): boolean {
  return current();
}

export function setColoredNicklist(on: boolean): void {
  localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  setCurrent(on);
}
