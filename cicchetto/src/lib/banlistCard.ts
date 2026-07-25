import { createSignal } from "solid-js";
import type { BanlistBundle } from "./api";
import { identityScopedStore } from "./identityScopedStore";

// #376/#386 — BANLIST bundle store. Holds at most one bundle per network
// slug. Populated by the `banlist_bundle` push event on the user-level
// Phoenix Channel topic (sent by Session.Server's apply_effects arm when 368
// RPL_ENDOFBANLIST arrives).
//
// #386: consumed by the interactive BanlistModal (the `/banlist` surface that
// superseded the original #376 inline card). The modal re-queries on open +
// on demand, and this store is the last-write-wins projection it renders.
//
// Ephemeral — NOT persisted in scrollback. The bundle lives in this signal
// until replaced by the next /banlist on the same network. Identity-scoped:
// cleared on logout / token rotation.
//
// A channel's ban list is ONE logical entity that CONTAINS multiple rows —
// the bundle carries all `entries`. Keyed by network slug (one active banlist
// at a time, like whowas); the bundle carries the folded `channel` so the
// modal shows which channel (and can guard a stale prior-channel bundle).

const exports_ = identityScopedStore((onIdentityChange) => {
  const [banlistCardBySlug, setBanlistCardBySlug] = createSignal<Record<string, BanlistBundle>>({});

  onIdentityChange(() => setBanlistCardBySlug({}));

  const setBanlistBundle = (networkSlug: string, bundle: BanlistBundle): void => {
    setBanlistCardBySlug((prev) => ({ ...prev, [networkSlug]: bundle }));
  };

  return { banlistCardBySlug, setBanlistBundle };
});

export const banlistCardBySlug = exports_.banlistCardBySlug;
export const setBanlistBundle = exports_.setBanlistBundle;
