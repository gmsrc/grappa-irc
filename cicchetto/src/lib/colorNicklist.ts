import { createRoot, createSignal } from "solid-js";

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
// localStorage only — cic owns UI/display preferences client-side; no
// server-side persistence. #449 will move display prefs (presence filter,
// timestamp format, this flag) to a server-backed full-map path so they
// converge across devices; until then all three stay on localStorage, one
// consistent pattern, migrated together.

const STORAGE_KEY = "cicchetto.coloredNicklist";
const DEFAULT_ON = false;

function readStored(): boolean {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === null ? DEFAULT_ON : v === "true";
}

// Module-singleton signal seeded from storage. createRoot anchors it for the
// app lifetime (same shape as timeFormat.ts) — the preference is
// identity-agnostic, so no token-rotation reset arm is needed.
const { current, setCurrent } = createRoot(() => {
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
