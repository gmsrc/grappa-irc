import { createSignal } from "solid-js";
import type { WhoisBundle } from "./api";
import { identityScopedStore } from "./identityScopedStore";
import { nickEquals } from "./nickEquals";

// C2 — WHOIS card store. Holds at most one bundle per network slug.
// Populated by the `whois_bundle` push event on the user-level Phoenix
// Channel topic (sent by Session.Server's apply_effects arm when 318
// RPL_ENDOFWHOIS arrives).
//
// Per spec #2: ephemeral — NOT persisted in scrollback. The bundle
// lives in this signal until replaced by the next /whois on the same
// network OR explicitly dismissed by the user (close button on the
// rendered card). Identity-scoped: cleared on logout / token rotation.
//
// One card per network is enough for the irssi-like UX — the user
// issues /whois, sees the result, dismisses or runs another /whois.
// The card replaces in-place; running /whois twice on the same network
// drops the first bundle silently.

const exports_ = identityScopedStore((onIdentityChange) => {
  const [whoisCardBySlug, setWhoisCardBySlug] = createSignal<Record<string, WhoisBundle>>({});

  onIdentityChange(() => setWhoisCardBySlug({}));

  const setWhoisBundle = (networkSlug: string, bundle: WhoisBundle): void => {
    setWhoisCardBySlug((prev) => ({ ...prev, [networkSlug]: bundle }));
  };

  const dismissWhoisCard = (networkSlug: string): void => {
    setWhoisCardBySlug((prev) => {
      const next = { ...prev };
      delete next[networkSlug];
      return next;
    });
  };

  // M3b — `whois_avatar_ready` incremental patch: a peer's CTCP AVATAR
  // fetch (`Grappa.Avatars.fetch_and_cache/3`) is a server-side HTTP
  // round-trip that routinely completes AFTER the `whois_bundle` this
  // card was built from. Silent no-op if no card is open for this
  // network, or the open card is for a DIFFERENT nick (the operator ran
  // another /whois while the fetch was in flight) — this is a patch,
  // never a substitute bundle.
  const patchWhoisAvatarUrl = (networkSlug: string, nick: string, avatarUrl: string): void => {
    setWhoisCardBySlug((prev) => {
      const current = prev[networkSlug];
      if (!current || !nickEquals(current.target, nick)) return prev;
      return { ...prev, [networkSlug]: { ...current, avatar_url: avatarUrl } };
    });
  };

  return { whoisCardBySlug, setWhoisBundle, dismissWhoisCard, patchWhoisAvatarUrl };
});

export const whoisCardBySlug = exports_.whoisCardBySlug;
export const setWhoisBundle = exports_.setWhoisBundle;
export const dismissWhoisCard = exports_.dismissWhoisCard;
export const patchWhoisAvatarUrl = exports_.patchWhoisAvatarUrl;
