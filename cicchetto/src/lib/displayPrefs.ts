import { createEffect } from "solid-js";
import { token } from "./auth";
import { getBoldMentions, setBoldMentions } from "./boldMentions";
import { type ChannelKey, decodeChannelKey } from "./channelKey";
import { getColoredNicklist, setColoredNicklist } from "./colorNicklist";
import { type DateFormatKey, getDateFormat, setDateFormat } from "./dateFormat";
import { getShowEventBadge, setShowEventBadge } from "./eventBadge";
import { identityMoved } from "./identityMoved";
import {
  getAllPresencePrefs,
  type PresencePref,
  replacePresencePrefs,
  setChannelPresencePref,
} from "./presenceFilter";
import { loadInitialScrollback, purgeScrollback } from "./scrollback";
import { getShowBottomBar, setShowBottomBar } from "./showBottomBar";
import { getStripFormatting, setStripFormatting } from "./stripFormatting";
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
// #1766 added a FOURTH owner module (`showBottomBar.ts`) on exactly that shape,
// and #2029 a FIFTH (`stripFormatting.ts`), and #2037 a SIXTH
// (`eventBadge.ts`), and issue 2167 a SEVENTH (`boldMentions.ts`), and issue 2270 an EIGHTH
// (`dateFormat.ts` — the first closed-set STRING since `timeFormat.ts`
// itself). Every
// function below that names the
// wire map has to grow with it — the default baseline, `buildWireMap`,
// `applyServerPrefs` and a `syncedSet*` — and the server's
// `default_display_prefs/0` is the authority for the default. Four touch points
// per key, none of them optional: miss the baseline and logout leaves a
// residual pref, miss `buildWireMap` and every PUT silently resets the key to
// the server's default.
//
// The seventh key is the first whose default is TRUE while being an OPT-OUT of
// something visible, which flips the sign on two of those four touch points:
// the `??` coalesce must land on `true`, and the value worth asserting in a
// test is `false`. See the comments at each site.
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

// The reset baseline — mirror of the server's `default_display_prefs/0`
// (the authoritative default). Used by the logout clear so a logged-out
// browser holds no subject's residual prefs.
const DEFAULT_DISPLAY_PREFS: Required<DisplayPrefs> = {
  time_format: "hms",
  colored_nicklist: false,
  presence_filter: {},
  show_bottom_bar: true,
  strip_formatting: false,
  show_event_badge: false,
  bold_mentions: true,
  date_format: "auto",
};

// #449 (issue222 regression fix) — the "unconfirmed local write" marker.
//
// A `syncedSet*` applies OPTIMISTICALLY to the owner module (signal +
// localStorage) and fires a fire-and-forget PUT. If that PUT is not ACKed
// before a reload (the navigation aborts it, offline, or CPU starvation), the
// next reconcile's `applyServerPrefs` — a FULL replace that rewrites the signal
// AND the localStorage boot cache — would CLOBBER the just-set pref with the
// stale server value: the pref vanishes for good (the e2e caught the presence
// join/part rows reappearing after reload). This flag is DURABLE (localStorage,
// so it survives the reload): while set, the reconcile PUSHES the local state up
// (the seed-up path) instead of letting the server win, so an in-flight write is
// never lost. Cleared on the PUT's success (the server now holds it → server-
// wins is safe again) and on logout (a logged-out browser holds no pending
// write). Same family as the #449 cross-account seed-up leak: the local cache is
// a WRITE source, so it needs a sync-status marker, not blind server-wins.
const UNSYNCED_KEY = "cic.displayPrefs.unsynced";

function markUnsynced(): void {
  localStorage.setItem(UNSYNCED_KEY, "1");
}

function clearUnsynced(): void {
  localStorage.removeItem(UNSYNCED_KEY);
}

function hasUnsyncedWrite(): boolean {
  return localStorage.getItem(UNSYNCED_KEY) === "1";
}

// Read the seven owner modules into the wire shape (the seed-up + every PUT
// body). Pure snapshot; no reactivity intended. `show_bottom_bar` (#1766) and
// `strip_formatting` (#2029) are OPTIONAL on the type (an older server omits
// them on the way IN) but always populated here — cic is the writer, and it
// knows the keys.
export function buildWireMap(): Required<DisplayPrefs> {
  return {
    time_format: getTimeFormat(),
    colored_nicklist: getColoredNicklist(),
    presence_filter: getAllPresencePrefs(),
    show_bottom_bar: getShowBottomBar(),
    strip_formatting: getStripFormatting(),
    show_event_badge: getShowEventBadge(),
    bold_mentions: getBoldMentions(),
    date_format: getDateFormat(),
  };
}

// Distribute a server-authoritative payload into the seven owner modules'
// LOCAL setters (write-through to signal + localStorage). No re-PUT — this is
// the server-wins apply path only. The presence map is a full replace so unset
// channels stay unset.
//
// #1766 — `show_bottom_bar` is coalesced against the baseline rather than
// passed through. This is a full-replace apply that runs on EVERY login
// reconcile, so a server that does not carry the key yet (this bundle shipped
// ahead of it, which `--cic` allows) would otherwise write `undefined` into the
// owner module and take the primary mobile navigation away from everyone. `??`
// and not `||`: a genuine `false` from the server must survive.
export function applyServerPrefs(prefs: DisplayPrefs): void {
  setTimeFormat(prefs.time_format);
  setColoredNicklist(prefs.colored_nicklist);
  replacePresencePrefs(prefs.presence_filter);
  setShowBottomBar(prefs.show_bottom_bar ?? DEFAULT_DISPLAY_PREFS.show_bottom_bar);
  // #2029 — coalesced for the same reason, in the same direction: this bundle
  // can ship AHEAD of the server (`--cic`), and a full-replace apply that
  // passed the absent value through would write `undefined` into the owner
  // module. `??` and not `||`: a server-sent `false` is a real preference —
  // here it is even the DEFAULT one, so `||` would make the pref impossible to
  // turn back off from a second device.
  setStripFormatting(prefs.strip_formatting ?? DEFAULT_DISPLAY_PREFS.strip_formatting);
  // #2037 B — coalesced for the third time and for the same reason (`--cic`
  // ships this bundle ahead of the server). `??` and not `||` matters MORE
  // here than for its two predecessors: `false` is this pref's default, so
  // `||` would make it impossible to turn the badge back OFF from a second
  // device once any device had turned it on.
  setShowEventBadge(prefs.show_event_badge ?? DEFAULT_DISPLAY_PREFS.show_event_badge);
  // issue 2167 — coalesced for the fourth time, same `--cic` skew, but the
  // SAFE value runs the other way: this default is TRUE, so an older server
  // omitting the key must land on bold rather than take it away. And `??`
  // rather than `||` matters MOST here of the four: with a `true` default,
  // `||` would send a server-sent `false` straight back to `true`, making the
  // preference impossible to turn on from a second device — the exact
  // cross-device failure #449 was built to end.
  setBoldMentions(prefs.bold_mentions ?? DEFAULT_DISPLAY_PREFS.bold_mentions);
  // issue 2270 — coalesced for the fifth time, same `--cic` skew, and the
  // first of them whose absent value is a STRING rather than a boolean. `??`
  // stays the operator for uniformity, not because `||` would break here:
  // `"auto"` is truthy, so the two agree TODAY. Writing `||` would encode a
  // fact about this key's default instead of the rule the other four follow,
  // and the next key added beside it would inherit the wrong shape.
  setDateFormat(prefs.date_format ?? DEFAULT_DISPLAY_PREFS.date_format);
}

// Reactive server sync — re-runs on every `token()` change (registered inside a
// `createRoot` by main.tsx, mirroring `mountCustomThemeSync`). On login: GET,
// then server-wins apply (`persisted`) OR seed-up PUT (`!persisted`). On
// logout: CLEAR the cache back to defaults (parity with `mountCustomThemeSync`).
// This is load-bearing, NOT cosmetic: keep-cache-on-logout was safe while the
// cache was read-only display state, but the seed-up made it a WRITE source —
// on a shared browser (or the visitor→user upgrade) subject B's never-persisted
// login would `buildWireMap()` subject A's residual cache and PUT it onto B's
// server account, sticky across B's devices. Clearing on logout means B seeds
// up genuine defaults; A's own next login GET restores A from the server. A
// logged-in reload never hits this branch (the auth signal already holds the
// stored token before this effect first runs), so the FOUC-free boot cache is
// preserved. An offline / transient failure keeps the boot-cached apply +
// `console.warn`s for observability.
export function mountDisplayPrefsSync(): void {
  createEffect(() => {
    const t = token();
    if (!t) {
      clearUnsynced(); // a logged-out browser holds no pending write
      applyServerPrefs(DEFAULT_DISPLAY_PREFS);
      return;
    }
    void getDisplayPrefs(t)
      .then((resp) => {
        // Token rotated mid-flight — a later effect run owns the state now,
        // and the seed-up PUT below would carry a retired bearer (#837).
        if (identityMoved(t)) return;
        // PUSH the LOCAL state up (never let the server clobber it) when either:
        //   * an earlier `syncedSet*` write is still UNCONFIRMED (its PUT never
        //     ACKed — e.g. a reload raced the fire-and-forget PUT). Without this
        //     the full-replace below wipes the just-set pref for good (#222); OR
        //   * the server has NEVER persisted (seed-up-once, Fork B): preserve
        //     the config the operator already built on this device.
        // buildWireMap carries the boot-cached local prefs; on success the
        // server holds them, so the unsynced marker clears and server-wins
        // resumes (a later cross-device change propagates normally).
        if (hasUnsyncedWrite() || !resp.persisted) {
          void putDisplayPrefs(t, buildWireMap())
            .then(clearUnsynced)
            .catch((e) => {
              console.warn("displayPrefs: seed-up/re-push PUT failed", e);
            });
        } else {
          applyServerPrefs(resp.display_prefs); // server wins
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
// Returns a promise that resolves when the PUT settles (success OR handled
// failure). Callers that must READ-THEIR-WRITE (the #458 reveal refetch) await
// it; the fire-and-forget callers ignore it. The returned promise never
// rejects — an offline/4xx PUT is caught here and logged, so a dependent
// refetch still proceeds (degraded: local applied, server converges next login).
function pushDisplayPrefs(): Promise<void> {
  const t = token();
  if (!t) return Promise.resolve();
  // Mark the write UNCONFIRMED before the PUT so a reload racing this
  // fire-and-forget request re-pushes local on reconcile instead of losing it
  // to a stale server value (#222). Cleared once the server ACKs.
  markUnsynced();
  return putDisplayPrefs(t, buildWireMap())
    .then(clearUnsynced)
    .catch((e) => {
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

export function syncedSetShowBottomBar(on: boolean): void {
  setShowBottomBar(on);
  pushDisplayPrefs();
}

export function syncedSetStripFormatting(on: boolean): void {
  setStripFormatting(on);
  pushDisplayPrefs();
}

export function syncedSetShowEventBadge(on: boolean): void {
  setShowEventBadge(on);
  pushDisplayPrefs();
}

export function syncedSetBoldMentions(on: boolean): void {
  setBoldMentions(on);
  pushDisplayPrefs();
}

export function syncedSetDateFormat(key: DateFormatKey): void {
  setDateFormat(key);
  pushDisplayPrefs();
}

export function syncedSetChannelPresencePref(key: ChannelKey, pref: PresencePref): void {
  setChannelPresencePref(key, pref);
  const pushed = pushDisplayPrefs();
  // #458 — Option 1 filters join/part/quit/nick_change/mode out of the REST page
  // SERVER-SIDE when this channel's pref hides them (so `limit` counts VISIBLE
  // rows, not raw ones). Its one accepted consequence: revealing presence needs
  // rows the server never sent. So on "show" we purge the (filtered) page and
  // cold-reload — the reload's fetch now re-includes presence. "hide" is free:
  // the render filter simply drops rows already in the store, no refetch.
  //
  // The refetch MUST wait for the PUT to settle: the server resolves
  // hide_presence from the PERSISTED pref, so a refetch racing the PUT could
  // read a still-"hide" pref and return content-only rows — nothing to reveal
  // (a nondeterministic silent failure). Awaiting `pushed` guarantees
  // read-your-write. Within the refetch, the purge MUST precede the reload:
  // loadInitialScrollback's load-once gate skips a key still in
  // `loadedChannels`, and purge is what drops it. This hook lives in the
  // coordinator (not RailActions) so every door onto the synced write refetches
  // identically — "one feature, one code path".
  if (pref === "show") {
    const decoded = decodeChannelKey(key);
    if (decoded) {
      void pushed.then(() => {
        purgeScrollback(key);
        void loadInitialScrollback(decoded.slug, decoded.name);
      });
    }
  }
}
