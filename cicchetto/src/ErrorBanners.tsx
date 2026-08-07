import { type Component, createEffect, For, Show } from "solid-js";
import BannerSlot from "./BannerSlot";
import {
  activeBanners,
  dismissBanner,
  entryId,
  rearmDismissed,
  sanitizeBanners,
  visibleBanners,
} from "./lib/errorBanners";

// #119 — unified stacked error-banner owner.
//
// Renders every active error source (device connectivity, WS health, bundle
// refresh; #120 will add service-worker-registration failure) as a vertical
// STACK inside ONE `position: fixed; top: 0` flex-column container. The
// children live in NORMAL FLOW inside the fixed container, so N banners stack
// without overlap — the fix for the pre-#119 bug where each banner was its own
// `position: fixed; top: 0` element and they all painted on the same
// coordinate.
//
// State is derived, never owned: `activeBanners()` projects the source signals
// (see `lib/errorBanners.ts`); `sanitizeBanners` enforces the closed-set
// source/severity contract at the render boundary; each entry renders through
// the pure `BannerSlot`. cic never originates banner state.
//
// #207 — the owner also holds the client-local dismiss state (in
// `lib/errorBanners.ts`). Render `visibleBanners()` (active minus dismissed);
// pass each slot an `onDismiss` that hides that source until it recovers. An
// effect calls `rearmDismissed(activeBanners())` whenever the active set
// changes, so a dismissed source that recovers and later re-fires surfaces
// again — a × must never permanently silence a real fault.

const ErrorBanners: Component = () => {
  const banners = (): ReturnType<typeof visibleBanners> => sanitizeBanners(visibleBanners());

  // Re-arm dismissed sources that are no longer active. Kept in an effect (not
  // the render derivation) so the conditional signal write stays out of the
  // tracked <For> scope — rearmDismissed no-ops when nothing changed, so this
  // converges without looping the reactive graph.
  createEffect(() => rearmDismissed(activeBanners()));

  return (
    <Show when={banners().length > 0}>
      {/* <section> with an accessible name is a region landmark — the
          semantic form of role="region" (biome a11y/useSemanticElements). */}
      <section class="error-banners" aria-label="Connection and app status">
        <For each={banners()}>
          {(entry) => (
            <BannerSlot
              entry={entry}
              // The × means "hide this until the fault recurs" — UNLESS the
              // source says otherwise. #459's push-optin decline (persisted in
              // localStorage) and #976's invite decline (a REST call the server
              // fans out) both do, and both now ride `entry.dismiss` rather
              // than a branch here.
              //
              // #976 reversed #902 on the invite specifically: its × used to
              // take this episode-scoped path deliberately, so a hidden invite
              // returned on the next reload. It is a real decline now.
              //
              // The default stays keyed per ENTRY, not per source, so hiding
              // one banner leaves its siblings — and any later one — alone.
              onDismiss={() =>
                entry.dismiss ? entry.dismiss.onAction() : dismissBanner(entryId(entry))
              }
            />
          )}
        </For>
      </section>
    </Show>
  );
};

export default ErrorBanners;
