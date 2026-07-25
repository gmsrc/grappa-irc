// #385 — cic-side single source of truth for user-defined command aliases.
//
// Like the keyword highlight list (highlightList.ts), aliases live in the
// server's user_settings with NO broadcast: this signal mirrors whatever the
// last server round-trip returned, so BOTH the /alias command AND the aliases
// settings sub-page read ONE state that can't drift. The compose-box expander
// (slashCommands.ts) reads this same signal to expand aliases before the
// DISPATCH lookup.
//
// Full-map PUT, no add/del endpoints (mirrors notification_prefs) — so
// addAlias/delAlias do a read-modify-write and PUT the WHOLE map. They fetch
// the server's current map FIRST rather than merging onto the local mirror:
// a /alias typed from compose without ever opening the settings page would
// otherwise merge onto a stale/empty mirror and clobber the user's other
// aliases on the server. The server returns the NORMALIZED map (names
// lowercased/trimmed), which becomes the new mirror.
//
// cic NEVER originates state: the signal only holds what the last server
// round-trip returned (CLAUDE.md window-state invariant family). Identity-
// scoped: a logout/account-switch clears the mirror (no broadcast self-heals
// it) so a switched-in account starts empty and refreshes to its own aliases.

import { createSignal } from "solid-js";
import { token } from "./auth";
import { identityScopedStore } from "./identityScopedStore";
import { type Aliases, getAliases, putAliases } from "./userSettings";

const exports_ = identityScopedStore((onIdentityChange) => {
  const [aliases, setAliases] = createSignal<Aliases>({});

  // Logout / account switch — clear the mirror (no broadcast self-heals it).
  onIdentityChange(() => setAliases({}));

  const requireToken = (): string => {
    const t = token();
    if (t === null) throw new Error("no session");
    return t;
  };

  // Fetch the current map (settings sub-page open). Mirror + return it.
  const refreshAliases = async (): Promise<Aliases> => {
    const map = await getAliases(requireToken());
    setAliases(map);
    return map;
  };

  // Define/overwrite one alias. Read-modify-write against the SERVER's
  // current map (not the local mirror) so a stale mirror never clobbers
  // sibling aliases. Server normalizes + validates; the returned map is
  // authoritative.
  const addAlias = async (name: string, expansion: string): Promise<Aliases> => {
    const t = requireToken();
    const current = await getAliases(t);
    // Lowercase the merge key at this one choke-point. The server map is
    // already lowercased, and the compose path lowercases in parseAlias — but
    // the settings form passes the raw name. Without this, re-adding `WII`
    // when `wii` exists would PUT two keys (`wii` + `WII`); the server folds
    // both to `wii` via Map.put over an unordered list, so the winner is
    // term-order-dependent and the new expansion could be silently dropped.
    const map = await putAliases(t, { ...current, [name.toLowerCase()]: expansion });
    setAliases(map);
    return map;
  };

  // Remove one alias. Same fresh-read-before-write discipline as addAlias.
  const delAlias = async (name: string): Promise<Aliases> => {
    const t = requireToken();
    const current = await getAliases(t);
    const next = { ...current };
    delete next[name.toLowerCase()]; // server keys are lowercase; match them
    const map = await putAliases(t, next);
    setAliases(map);
    return map;
  };

  return { aliases, addAlias, delAlias, refreshAliases };
});

export const aliases = exports_.aliases;
export const addAlias = exports_.addAlias;
export const delAlias = exports_.delAlias;
export const refreshAliases = exports_.refreshAliases;
