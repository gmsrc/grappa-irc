import { createEffect } from "solid-js";
import { token } from "./auth";
import type { ChannelKey } from "./channelKey";
import { getColoredNicklist, setColoredNicklist } from "./colorNicklist";
import {
  getAllPresencePrefs,
  type PresencePref,
  replacePresencePrefs,
  setChannelPresencePref,
} from "./presenceFilter";
import { getTimeFormat, setTimeFormat, type TimeFormatKey } from "./timeFormat";
import { type DisplayPrefs, getDisplayPrefs, putDisplayPrefs } from "./userSettings";

// #449 — the display-prefs coordinator. The three prefs (presence filter #222,
// time format #217, colored nicklist #443) were localStorage-only and never
// converged across one account's devices (a desktop toggle stayed invisible on
// the iOS PWA — reported by Hypnotize). This module makes them server-backed
// WITHOUT collapsing the three owner modules: each keeps its signal +
// localStorage cache (the FOUC-free boot mirror); this coordinator adds the
// server round-trip on top.
//
// ## The THEME sync shape, not the notification-prefs shape
//
// These are boot-APPLIED UI state (like the custom theme), not a form the user
// submits and forgets (like notification-prefs). So this mirrors
// `customTheme.ts`: boot seeds localStorage synchronously (each owner module's
// `readStored()` at import), then `mountDisplayPrefsSync` reconciles with the
// server on login. There is deliberately NO reactive-PUT effect — apply and
// PUT are separate verbs, so a server-wins apply can never feed back into a PUT.
//
// ## Seed-up-once (Fork B), never clobber
//
// On login the coordinator GETs. `persisted: false` (server never wrote) ⇒ push
// the local values up once, preserving the config the operator already built on
// this device. `persisted: true` ⇒ the server wins. A client "migrated" flag
// was rejected: a fresh browser with default-local would PUT defaults and wipe
// another device's saved prefs. The discriminator lives on the SERVER because
// `get_display_prefs/1` always returns a complete default shape — the payload
// alone cannot tell "never written" from "written == defaults".
//
// ## Tri-state (NON-NEGOTIABLE)
//
// `presence_filter` values are `"show" | "hide"`; UNSET is the ABSENCE of a
// channel key. `applyServerPrefs` does a FULL replace (not merge), so a channel
// the server does not pin returns to unset — absence round-trips as absence.

// Read the three owner modules into the wire shape (the seed-up + every PUT
// body). Pure snapshot; no reactivity intended.
export function buildWireMap(): DisplayPrefs {
  return {
    time_format: getTimeFormat(),
    colored_nicklist: getColoredNicklist(),
    presence_filter: getAllPresencePrefs(),
  };
}

// Distribute a server-authoritative payload into the three owner modules'
// LOCAL setters (write-through to signal + localStorage). No re-PUT — this is
// the server-wins apply path only. The presence map is a full replace so unset
// channels stay unset.
export function applyServerPrefs(prefs: DisplayPrefs): void {
  setTimeFormat(prefs.time_format);
  setColoredNicklist(prefs.colored_nicklist);
  replacePresencePrefs(prefs.presence_filter);
}

// Reactive server sync — re-runs on every `token()` change (registered inside a
// `createRoot` by main.tsx, mirroring `mountCustomThemeSync`). On login: GET,
// then server-wins apply (`persisted`) OR seed-up PUT (`!persisted`). On
// logout: NO-OP — display prefs are identity-agnostic habits, so the cache
// persists untouched and the next login's GET reconciles (unlike the theme,
// which is account chrome and clears on logout). An offline / transient failure
// keeps the boot-cached apply + `console.warn`s for observability.
export function mountDisplayPrefsSync(): void {
  createEffect(() => {
    const t = token();
    if (!t) return;
    void getDisplayPrefs(t)
      .then((resp) => {
        // Token rotated mid-flight — a later effect run owns the state now.
        if (token() !== t) return;
        if (resp.persisted) {
          applyServerPrefs(resp.display_prefs); // server wins
        } else {
          // Seed-up-once: the server has never persisted (or is a pre-#449
          // build that omits `persisted`). Push the local values up so the
          // operator's existing config survives + converges. Fire-and-forget;
          // a failure just retries on the next login.
          void putDisplayPrefs(t, buildWireMap()).catch((e) => {
            console.warn("displayPrefs: seed-up PUT failed", e);
          });
        }
      })
      .catch((e) => {
        // Offline / transient / a persistent 5xx — keep the boot-cached apply.
        // Logged so a real server error isn't fully invisible.
        console.warn("displayPrefs: refresh failed", e);
      });
  });
}

// Push the current full wire map to the server. Fire-and-forget: the optimistic
// local set already applied, and on failure it STAYS (no hard-revert — the next
// login GET reconciles, matching notification-prefs). `console.warn` gives
// observability for the offline / 401 / DOS-bound-422 paths. Reads `token()`
// itself so call sites pass no token; a logged-out toggle is local-only and
// converges on the next login.
function pushDisplayPrefs(): void {
  const t = token();
  if (!t) return;
  void putDisplayPrefs(t, buildWireMap()).catch((e) => {
    console.warn("displayPrefs: PUT failed", e);
  });
}

// User-action setters — optimistic LOCAL set + full-map PUT. Call sites swap
// their bare `set*` for these (the owner-module setters stay local-only so the
// coordinator is the single PUT authority — "one feature, one code path").
export function syncedSetTimeFormat(key: TimeFormatKey): void {
  setTimeFormat(key);
  pushDisplayPrefs();
}

export function syncedSetColoredNicklist(on: boolean): void {
  setColoredNicklist(on);
  pushDisplayPrefs();
}

export function syncedSetChannelPresencePref(key: ChannelKey, pref: PresencePref): void {
  setChannelPresencePref(key, pref);
  pushDisplayPrefs();
}
