// #1513 — the joined-channel projection, in a module of its OWN rather than in
// `windowState.ts`.
//
// It cannot stay in `compose.ts` (which imports `commands/*`, so exporting it
// there would close the cycle), and it does not belong INSIDE `windowState.ts`
// either: consumers mock that module wholesale as a state SOURCE, so derived
// logic placed there is swallowed by the mock and silently stops being
// exercised — measured, 22 reds in the #30 tab-complete and #431 fan-out tests
// the moment it went in. A derived read-model reads the store from outside it.
//
// Pure with respect to its input: the only thing it touches is the projection
// `windowStateByChannel` publishes.

import { type ChannelKey, decodeChannelKey } from "./channelKey";
import { windowStateByChannel } from "./windowState";

// #30 — the channel candidate set: every channel JOINED on the same
// network as the window being typed in. Derived from the server-owned
// `windowStateByChannel` projection (no parallel client-side list to
// drift); a pending / invited / parked / failed / kicked window is NOT
// offered, mirroring the nick rule that you complete who is actually
// here. Scope is deliberately narrower than the issue's "optionally
// channels seen via /list or mentioned in the buffer" — those are a
// separate cut. The decoded name is already ASCII-folded (channelKey
// folds at construction) and for channels the folded key IS the display
// (the #537/#525 channel invariant), so it is inserted verbatim.
//
// No sigil filter on the candidate name: this map mirrors the server's
// `Session.Server` `window_states`, which is channel-keyed by
// construction (a DM lives in `queryWindows`, not here), so a
// "joined" non-channel key cannot occur. A guard for it was written,
// measured against the suite at ZERO failing tests, and deleted.
export const joinedChannelsOnNetwork = (key: ChannelKey): string[] => {
  const here = decodeChannelKey(key);
  if (here === null) return [];
  const states = windowStateByChannel();
  const out: string[] = [];
  for (const [candidate, state] of Object.entries(states)) {
    if (state !== "joined") continue;
    const there = decodeChannelKey(candidate as ChannelKey);
    if (there === null || there.slug !== here.slug) continue;
    out.push(there.name);
  }
  return out;
};
