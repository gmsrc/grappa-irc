// #1861 — the slug-keyed door to the network's advertised CASEMAPPING.
//
// `isupport.ts` owns the fact and keys it by network ID, like every other
// 005 fact. Most of cic, however, is keyed by network SLUG (ChannelKey,
// the selection, the per-slug caches), so the fold resolution needs the
// `slug → id → casemapping` hop. That hop was open-coded once already for
// CHANTYPES= (`compose.sigilsFor`); a nick fold is needed in a dozen
// modules, so it lives here instead of a dozen private copies.
//
// It is its OWN module rather than a function in `isupport.ts` because
// this is the only edge that needs `networks.ts`: keeping it out of
// `isupport.ts` leaves that store a leaf (chantypes + moduleRoot +
// wireTypes) and keeps the pure fold in `nickEquals.ts` free of the
// solid-js resource graph.

import { type Casemapping, casemappingForNetwork } from "./isupport";
import { networkIdBySlug } from "./networks";

/**
 * How the network behind `slug` folds identifiers, or `"ascii"` when the
 * slug names no known network (boot before the networks resource lands, a
 * stale selection, a pseudo-window).
 *
 * `"ascii"` is the safe fallback in both directions: it is the pre-005
 * default the server itself uses, and it is the NARROWER fold, so a wrong
 * guess never merges two identities the ircd keeps apart.
 */
export const casemappingForSlug = (slug: string): Casemapping =>
  casemappingForNetwork(networkIdBySlug(slug) ?? null);
