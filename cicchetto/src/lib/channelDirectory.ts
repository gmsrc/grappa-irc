import { createSignal } from "solid-js";
import * as api from "./api";
import { token } from "./auth";
import { identityScopedStore } from "./identityScopedStore";

// Per-slug directory view preferences: sort order + text filter.
// Default = user-count sort, no filter.
type View = { sort: "users" | "name"; q: string };

// Per-network channel-directory store.
//
// Holds the last-fetched DirectoryPage and the active view (sort + q) per
// network slug. Re-GETs on load, view-change, and on each server-side
// directory ping (progress / complete / failed). Identity-scoped so a
// bearer rotation clears the prior tenant's snapshot (two resets, one per
// signal map — same shape as windowState.ts).
//
// The three ping hooks today all do the same re-GET. They are distinct
// exports so task D4 (userTopic dispatch) can wire each one independently
// and future divergence (e.g. "failed" surfaces an error toast, "complete"
// scrolls back to the top) is additive — no call-site changes required.
//
// fetchInto is the shared private primitive: fetches page 1 (no cursor) of
// the current view (sort + q) for the given slug and REPLACES the stored
// page. Every top-of-view event routes through it — load, sort-change,
// query-change, and the three server pings — so all of those correctly
// reset the accumulation back to page 1 (#677 constraint 3).
//
// loadMore (#677) is the SEPARATE append primitive: it fetches the NEXT
// keyset page (cursor = the stored page's next_cursor) and APPENDS its
// rows. It deliberately does NOT go through fetchInto — routing it there
// would wipe the accumulated pages the user has scrolled through.
//
// Server-ping posture (#677 constraint 2): a progress/complete/failed ping
// re-GETs page 1 via fetchInto, discarding any accumulated pages. This is
// the honest behaviour — a ping means a NEW upstream LIST capture landed,
// so the old pages' keyset cursors belong to a prior snapshot and can't be
// spliced onto the new one. Reset-to-page-1 beats stitching two captures.
const exports_ = identityScopedStore((onIdentityChange) => {
  const [pages, setPages] = createSignal<Record<string, api.DirectoryPage>>({});
  const [views, setViews] = createSignal<Record<string, View>>({});
  // Per-slug load-more in-flight guard. Doubles as the sentinel's spinner
  // source (isLoadingMore). Prevents a burst of IntersectionObserver fires
  // from stacking concurrent page-2 GETs. Identity-scoped like the rest.
  const [loadingMore, setLoadingMore] = createSignal<Record<string, boolean>>({});

  onIdentityChange(() => setPages({}));
  onIdentityChange(() => setViews({}));
  onIdentityChange(() => setLoadingMore({}));

  const currentView = (slug: string): View => views()[slug] ?? { sort: "users", q: "" };

  const fetchInto = async (slug: string): Promise<void> => {
    const t = token();
    if (!t) return;
    const view = currentView(slug);
    const page = await api.listDirectory(t, slug, { sort: view.sort, q: view.q });
    setPages((prev) => ({ ...prev, [slug]: page }));
  };

  const directoryPage = (slug: string): api.DirectoryPage | undefined => pages()[slug];

  // #677 — the sort a reopened pane should rehydrate its toggle from. Sort
  // is a sticky PREFERENCE (unlike the search key, which is cleared on
  // close); the pane reads this so the toggle label matches the sorted list
  // fetchInto produces on reopen. Defaults to "users".
  const directorySort = (slug: string): "users" | "name" => currentView(slug).sort;

  // #677 — true while a loadMore for `slug` is in flight (sentinel spinner).
  const isLoadingMore = (slug: string): boolean => loadingMore()[slug] ?? false;

  // #677 — fetch the NEXT keyset page and APPEND. No-op when: no token, no
  // page yet (nothing to page from), no next_cursor (already at the end),
  // or a load is already in flight for this slug. The cursor is opaque —
  // fed straight back to the server, which encodes sort into it.
  const loadMore = async (slug: string): Promise<void> => {
    const t = token();
    if (!t) return;
    const current = pages()[slug];
    if (!current || current.next_cursor === null) return;
    if (loadingMore()[slug]) return;
    setLoadingMore((prev) => ({ ...prev, [slug]: true }));
    try {
      const view = currentView(slug);
      const next = await api.listDirectory(t, slug, {
        sort: view.sort,
        q: view.q,
        cursor: current.next_cursor,
      });
      // Merge: keep the accumulated entries, append the new page's rows,
      // and adopt the new page's cursor/total/captured_at/status. Re-read
      // pages()[slug] inside the setter so a fetchInto that landed while
      // this GET was in flight isn't clobbered (append only when the base
      // is still the page we started from).
      setPages((prev) => {
        const base = prev[slug];
        if (!base || base.next_cursor !== current.next_cursor) return prev;
        return { ...prev, [slug]: { ...next, entries: [...base.entries, ...next.entries] } };
      });
    } finally {
      setLoadingMore((prev) => ({ ...prev, [slug]: false }));
    }
  };

  // #677 — reset the per-slug browse state on window close. Clears the
  // search key (the filter is NOT sticky — vjt's call) and DROPS the cached
  // page so a reopen re-fetches page 1 fresh + unfiltered (the drop also
  // discards the accumulated pages, so a reopened directory never inherits a
  // deep scroll's worth of rows). Sort is preserved as a sticky preference.
  const resetDirectory = (slug: string): void => {
    setViews((prev) => ({ ...prev, [slug]: { ...currentView(slug), q: "" } }));
    setPages((prev) => {
      const { [slug]: _dropped, ...rest } = prev;
      return rest;
    });
    setLoadingMore((prev) => {
      const { [slug]: _dropped, ...rest } = prev;
      return rest;
    });
  };

  const loadDirectory = (slug: string): Promise<void> => fetchInto(slug);

  const setSort = async (slug: string, sort: "users" | "name"): Promise<void> => {
    setViews((prev) => ({ ...prev, [slug]: { ...currentView(slug), sort } }));
    await fetchInto(slug);
  };

  const setQuery = async (slug: string, q: string): Promise<void> => {
    setViews((prev) => ({ ...prev, [slug]: { ...currentView(slug), q } }));
    await fetchInto(slug);
  };

  const triggerRefresh = async (slug: string): Promise<void> => {
    const t = token();
    if (!t) return;
    await api.refreshDirectory(t, slug);
  };

  const onDirectoryProgress = (slug: string): Promise<void> => fetchInto(slug);
  const onDirectoryComplete = (slug: string): Promise<void> => fetchInto(slug);
  const onDirectoryFailed = (slug: string): Promise<void> => fetchInto(slug);

  return {
    directoryPage,
    directorySort,
    isLoadingMore,
    loadDirectory,
    loadMore,
    resetDirectory,
    setSort,
    setQuery,
    triggerRefresh,
    onDirectoryProgress,
    onDirectoryComplete,
    onDirectoryFailed,
  };
});

export const directoryPage = exports_.directoryPage;
export const directorySort = exports_.directorySort;
export const isLoadingMore = exports_.isLoadingMore;
export const loadDirectory = exports_.loadDirectory;
export const loadMore = exports_.loadMore;
export const resetDirectory = exports_.resetDirectory;
export const setSort = exports_.setSort;
export const setQuery = exports_.setQuery;
export const triggerRefresh = exports_.triggerRefresh;
export const onDirectoryProgress = exports_.onDirectoryProgress;
export const onDirectoryComplete = exports_.onDirectoryComplete;
export const onDirectoryFailed = exports_.onDirectoryFailed;
