// #781 — warm a heavy module graph before the tests that re-import it.
//
// A test file that pairs `vi.resetModules()` with a per-test
// `await import("../lib/X")` pays vite's transform for that graph on the
// FIRST import only: `resetModules` clears the module registry, not the
// transform cache, so every later import in the same file costs single-digit
// ms. Measured on the four files that use this: ~0.33-0.6s isolated, 1.5-3s
// under 16-way worker contention — against a 5000ms `testTimeout`.
//
// Left inside a test, that first import can overrun the budget, and vitest's
// timeout RACES the promise rather than cancelling it: the test is failed
// while the import is still in flight, and the orphaned module evaluation
// completes during the NEXT test, after its `vi.clearAllMocks()` has zeroed
// the counters. That is the #781 "double join" — an assertion failure two
// tests away from its cause.
//
// Calling this from `beforeAll` does not abolish the budget, it moves the
// cost onto `hookTimeout` (10000ms default, unset in vitest.config.ts) — a
// 3-6x margin over the measured worst case instead of a 2-3x one. The bigger
// win is the failure SHAPE: a hook that overruns fails its whole file loudly
// with `Hook timed out`, instead of surfacing as a phantom logic bug in an
// unrelated test.
//
// PRECONDITION — the warmed graph MUST be inert at module scope. This hook
// runs before the first `beforeEach`, so `setupTests.ts`'s global stubs
// (localStorage / WebSocket / IntersectionObserver) are NOT installed yet,
// and mocked modules are shared across `vi.resetModules()`. In practice:
// no bearer in localStorage (every store keys its resources on `token`, so
// they never fetch) and no unmocked `lib/socket` in the graph (or the warm
// instance opens a real ws against jsdom). Break either and the warm
// instance corrupts spies shared with the tests — silently, which is the
// very failure class this fixes.
//
// Pass the module the tests import; transitive deps come for free, so
// warming a module its graph already pulls in is dead weight. A
// full-replacement `vi.mock(path, () => ({...}))` factory means the real
// file is never transformed at all — warming THAT path warms nothing.
export async function warmGraph(...loaders: Array<() => Promise<unknown>>): Promise<void> {
  for (const load of loaders) {
    await load();
  }
}
