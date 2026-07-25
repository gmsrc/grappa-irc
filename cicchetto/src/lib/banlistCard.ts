import { createSignal } from "solid-js";
import type { BanlistBundle } from "./api";
import { identityScopedStore } from "./identityScopedStore";

// #376 — BANLIST card store. Holds at most one bundle per network slug.
// Populated by the `banlist_bundle` push event on the user-level Phoenix
// Channel topic (sent by Session.Server's apply_effects arm when 368
// RPL_ENDOFBANLIST arrives).
//
// Ephemeral — NOT persisted in scrollback. The bundle lives in this
// signal until replaced by the next /banlist on the same network OR
// explicitly dismissed by the user (close button on the rendered card).
// Identity-scoped: cleared on logout / token rotation.
//
// Mirror shape of `whowasCard.ts`. A channel's ban list is ONE logical
// entity (fits the card model per `feedback_card_vs_scrollback_ux`) that
// CONTAINS multiple rows — the bundle carries all `entries`. Keyed by
// network slug (one active banlist card at a time, like whowas); the
// bundle carries the folded `channel` so the card shows which channel.

const exports_ = identityScopedStore((onIdentityChange) => {
  const [banlistCardBySlug, setBanlistCardBySlug] = createSignal<Record<string, BanlistBundle>>({});

  onIdentityChange(() => setBanlistCardBySlug({}));

  const setBanlistBundle = (networkSlug: string, bundle: BanlistBundle): void => {
    setBanlistCardBySlug((prev) => ({ ...prev, [networkSlug]: bundle }));
  };

  const dismissBanlistCard = (networkSlug: string): void => {
    setBanlistCardBySlug((prev) => {
      const next = { ...prev };
      delete next[networkSlug];
      return next;
    });
  };

  return { banlistCardBySlug, setBanlistBundle, dismissBanlistCard };
});

export const banlistCardBySlug = exports_.banlistCardBySlug;
export const setBanlistBundle = exports_.setBanlistBundle;
export const dismissBanlistCard = exports_.dismissBanlistCard;
