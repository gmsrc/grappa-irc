import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as api from "./api";
import { setToken } from "./auth";
import {
  directoryPage,
  directorySort,
  loadDirectory,
  loadMore,
  onDirectoryComplete,
  onDirectoryFailed,
  onDirectoryProgress,
  resetDirectory,
  setQuery,
  setSort,
  triggerRefresh,
} from "./channelDirectory";

// channelDirectory store — per-slug DirectoryPage + view (sort/q) signal
// store, identity-scoped. Tests assert outcome invariants, not call order.
//
// Token priming: token() is read at call time (reactive signal). beforeEach
// sets a test bearer via setToken so fetch verbs don't short-circuit on a
// null token. afterEach clears it back to null; the identity-change effect
// fires (prev != null && t !== prev) and resets pages + views so state
// doesn't leak across tests. Tests using slug "freenode" are isolated from
// the provided "libera" tests for the same reason.

const TOKEN = "test-bearer";

const makePage = (overrides: Partial<api.DirectoryPage> = {}): api.DirectoryPage => ({
  entries: [],
  next_cursor: null,
  total: 0,
  captured_at: null,
  status: "fresh" as api.DirectoryStatus,
  ...overrides,
});

describe("channelDirectory store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setToken(TOKEN);
  });
  afterEach(() => setToken(null));

  // --- provided test bodies (unchanged) ---

  test("loadDirectory populates the page for the network", async () => {
    vi.spyOn(api, "listDirectory").mockResolvedValue({
      entries: [{ name: "#a", topic: "t", user_count: 3, featured: false }],
      next_cursor: null,
      total: 1,
      captured_at: "2026-06-26T10:00:00Z",
      status: "fresh",
    });
    await loadDirectory("libera");
    expect(directoryPage("libera")?.total).toBe(1);
    expect(directoryPage("libera")?.entries[0]?.name).toBe("#a");
  });

  test("a progress ping re-GETs the current view", async () => {
    const spy = vi.spyOn(api, "listDirectory").mockResolvedValue({
      entries: [],
      next_cursor: null,
      total: 7,
      captured_at: null,
      status: "refreshing",
    });
    await loadDirectory("libera");
    spy.mockClear();
    await onDirectoryProgress("libera");
    expect(spy).toHaveBeenCalledOnce();
    expect(directoryPage("libera")?.total).toBe(7);
  });

  // --- additional coverage ---

  test("onDirectoryComplete re-GETs the current view", async () => {
    const spy = vi
      .spyOn(api, "listDirectory")
      .mockResolvedValue(makePage({ total: 3, status: "fresh" }));
    await loadDirectory("freenode");
    spy.mockClear();
    await onDirectoryComplete("freenode");
    expect(spy).toHaveBeenCalledOnce();
    expect(directoryPage("freenode")?.total).toBe(3);
  });

  test("onDirectoryFailed re-GETs the current view", async () => {
    const spy = vi
      .spyOn(api, "listDirectory")
      .mockResolvedValue(makePage({ total: 0, status: "empty" }));
    await loadDirectory("freenode");
    spy.mockClear();
    await onDirectoryFailed("freenode");
    expect(spy).toHaveBeenCalledOnce();
    expect(directoryPage("freenode")?.status).toBe("empty");
  });

  test("setQuery threads q into the api call", async () => {
    const spy = vi.spyOn(api, "listDirectory").mockResolvedValue(makePage({ total: 5 }));
    await setQuery("freenode", "cool");
    expect(spy).toHaveBeenCalledWith(TOKEN, "freenode", expect.objectContaining({ q: "cool" }));
    expect(directoryPage("freenode")?.total).toBe(5);
  });

  test("setSort threads sort into the api call", async () => {
    const spy = vi.spyOn(api, "listDirectory").mockResolvedValue(makePage({ total: 12 }));
    await setSort("freenode", "name");
    expect(spy).toHaveBeenCalledWith(TOKEN, "freenode", expect.objectContaining({ sort: "name" }));
    expect(directoryPage("freenode")?.total).toBe(12);
  });

  test("setQuery + subsequent loadDirectory uses the stored q", async () => {
    vi.spyOn(api, "listDirectory").mockResolvedValue(makePage({ total: 2 }));
    await setQuery("freenode", "rust");
    const spy = vi.spyOn(api, "listDirectory").mockResolvedValue(makePage({ total: 2 }));
    await loadDirectory("freenode");
    expect(spy).toHaveBeenCalledWith(TOKEN, "freenode", expect.objectContaining({ q: "rust" }));
  });

  test("triggerRefresh calls refreshDirectory with the current bearer", async () => {
    const spy = vi.spyOn(api, "refreshDirectory").mockResolvedValue(undefined);
    await triggerRefresh("freenode");
    expect(spy).toHaveBeenCalledWith(TOKEN, "freenode");
  });

  test("no-token short-circuits — loadDirectory makes no api call when token is null", async () => {
    setToken(null);
    const spy = vi.spyOn(api, "listDirectory");
    await loadDirectory("freenode");
    expect(spy).not.toHaveBeenCalled();
  });

  test("no-token short-circuits — triggerRefresh makes no api call when token is null", async () => {
    setToken(null);
    const spy = vi.spyOn(api, "refreshDirectory");
    await triggerRefresh("freenode");
    expect(spy).not.toHaveBeenCalled();
  });

  // --- #677 pagination: loadMore appends the next keyset page ---

  describe("loadMore (#677 pagination)", () => {
    const ROW = (name: string, users: number): api.DirectoryEntry => ({
      name,
      topic: null,
      user_count: users,
      featured: false,
    });

    test("appends the next page and threads the stored cursor back", async () => {
      const spy = vi.spyOn(api, "listDirectory");
      spy.mockResolvedValueOnce(
        makePage({ entries: [ROW("#a", 9)], next_cursor: "CUR2", total: 3 }),
      );
      await loadDirectory("lm1");
      spy.mockResolvedValueOnce(makePage({ entries: [ROW("#b", 8)], next_cursor: null, total: 3 }));
      await loadMore("lm1");

      // The page-1 cursor was fed back to the server verbatim (opaque).
      expect(spy).toHaveBeenLastCalledWith(
        TOKEN,
        "lm1",
        expect.objectContaining({ cursor: "CUR2" }),
      );
      // Rows ACCUMULATED (not replaced), cursor advanced to the new page's.
      const p = directoryPage("lm1");
      expect(p?.entries.map((e) => e.name)).toEqual(["#a", "#b"]);
      expect(p?.next_cursor).toBeNull();
    });

    test("no-op when next_cursor is null (already at the end)", async () => {
      const spy = vi
        .spyOn(api, "listDirectory")
        .mockResolvedValueOnce(makePage({ total: 1, next_cursor: null }));
      await loadDirectory("lm2");
      spy.mockClear();
      await loadMore("lm2");
      expect(spy).not.toHaveBeenCalled();
    });

    test("no-op when no page has been loaded yet", async () => {
      const spy = vi.spyOn(api, "listDirectory");
      spy.mockClear();
      await loadMore("lm3");
      expect(spy).not.toHaveBeenCalled();
    });

    test("no-op when token is null", async () => {
      const spy = vi
        .spyOn(api, "listDirectory")
        .mockResolvedValueOnce(makePage({ total: 5, next_cursor: "CUR2" }));
      await loadDirectory("lm4");
      setToken(null);
      spy.mockClear();
      await loadMore("lm4");
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // --- #677 clear-on-close: resetDirectory ---

  describe("resetDirectory (#677 clear-on-close)", () => {
    test("clears the search key and drops the cached page", async () => {
      vi.spyOn(api, "listDirectory").mockResolvedValue(makePage({ total: 4, next_cursor: "X" }));
      await setQuery("rd1", "rust");
      expect(directoryPage("rd1")).toBeDefined();

      resetDirectory("rd1");
      // Page dropped → a reopen re-fetches from the top.
      expect(directoryPage("rd1")).toBeUndefined();

      // q cleared → the reopen GET carries q: "" (unfiltered), NOT "rust".
      const spy = vi.spyOn(api, "listDirectory").mockResolvedValue(makePage({ total: 4 }));
      await loadDirectory("rd1");
      expect(spy).toHaveBeenCalledWith(TOKEN, "rd1", expect.objectContaining({ q: "" }));
    });

    test("preserves sort as a sticky preference across a reset", async () => {
      vi.spyOn(api, "listDirectory").mockResolvedValue(makePage({ total: 2 }));
      await setSort("rd2", "name");
      resetDirectory("rd2");
      expect(directorySort("rd2")).toBe("name");
    });
  });
});
