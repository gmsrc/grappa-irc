import { createSignal } from "solid-js";
import type { LinksReply } from "./api";
import { identityScopedStore } from "./identityScopedStore";

// #238 — /links topology modal store. Holds at most one topology snapshot per
// network slug. Populated by the `links_bundle` push event on the user-level
// Phoenix Channel topic (Session.Server's apply_effects arm when 365
// RPL_ENDOFLINKS drains a pending /links request).
//
// Ephemeral — NOT persisted in scrollback. The snapshot lives in this signal
// until replaced by the next /links on the same network OR explicitly
// dismissed (close button, Esc, backdrop). Identity-scoped: cleared on logout
// / token rotation. Mirrors whoModal.ts / namesModal.ts exactly; the only
// difference is the render surface (an interactive SVG topology map vs a
// flat table). An EMPTY `entries` snapshot is still a snapshot — the modal
// opens and renders the "this network hides its topology" empty state.

const exports_ = identityScopedStore((onIdentityChange) => {
  const [linksModalBySlug, setLinksModalBySlug] = createSignal<Record<string, LinksReply>>({});

  onIdentityChange(() => setLinksModalBySlug({}));

  const setLinksReply = (networkSlug: string, reply: LinksReply): void => {
    setLinksModalBySlug((prev) => ({ ...prev, [networkSlug]: reply }));
  };

  const dismissLinksModal = (networkSlug: string): void => {
    setLinksModalBySlug((prev) => {
      const next = { ...prev };
      delete next[networkSlug];
      return next;
    });
  };

  return { linksModalBySlug, setLinksReply, dismissLinksModal };
});

export const linksModalBySlug = exports_.linksModalBySlug;
export const setLinksReply = exports_.setLinksReply;
export const dismissLinksModal = exports_.dismissLinksModal;
