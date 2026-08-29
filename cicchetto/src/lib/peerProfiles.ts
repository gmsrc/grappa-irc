/**
 * M2 — the `show_peer_profiles` opt-in, cached client-side.
 *
 * Whether this subject has opted in to grappa querying OTHER users' CTCP
 * USERINFO profile — the source of the member-list gender badge. Default
 * `false`. Unlike `autoAway.ts`'s twin, there is no server push to mirror:
 * the setting only gates a future outbound query, so a live session picks
 * up a change on its next (re)spawn rather than instantly — see
 * `Grappa.UserSettings.get_show_peer_profiles/1`'s doc for why that
 * asymmetry is deliberate, not an oversight.
 */

import { createSignal } from "solid-js";
import { getShowPeerProfiles, putShowPeerProfiles } from "./userSettings";

const [showPeerProfiles, setShowPeerProfilesSignal] = createSignal(false);

/** The cached preference. */
export function showPeerProfilesValue(): boolean {
  return showPeerProfiles();
}

/**
 * Load the stored preference into the cache. Errors are swallowed: the
 * cache stays at `false`, the same default the server applies to a
 * subject it has never heard an opinion from.
 */
export async function loadShowPeerProfiles(token: string): Promise<void> {
  try {
    setShowPeerProfilesSignal(await getShowPeerProfiles(token));
  } catch {
    /* swallowed — the toggle falls back to off */
  }
}

/**
 * Persist a new preference and mirror what the server echoed back.
 * Throws `ApiError` on 4xx/5xx.
 */
export async function saveShowPeerProfiles(token: string, enabled: boolean): Promise<void> {
  setShowPeerProfilesSignal(await putShowPeerProfiles(token, enabled));
}

/** Test-only: drop the cache back to the default. */
export function resetShowPeerProfilesForTests(): void {
  setShowPeerProfilesSignal(false);
}
