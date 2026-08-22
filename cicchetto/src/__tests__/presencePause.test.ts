import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";
import { PRESENCE_COOLDOWN_MS } from "../lib/presenceCooldown";
import { SUPPRESSED_PRESENCE_KINDS } from "../lib/presenceFilter";
import { createPresencePause, PAUSABLE_PRESENCE_KINDS } from "../lib/presencePause";

const alice = channelKey("azzurra", "#alice");
const bob = channelKey("azzurra", "#bob");

describe("presencePause (#1680)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("what a paused channel is allowed to swallow", () => {
    // The guard against inheriting a kind by accident. If the server twin
    // grows a sixth presence kind, `SUPPRESSED_PRESENCE_KINDS` follows it
    // (it is byte-pinned by presence_filter_test.exs) — and this assertion
    // keeps that from silently widening what a paused channel drops.
    it("drops only a strict subset of the presence kinds", () => {
      for (const kind of PAUSABLE_PRESENCE_KINDS) {
        expect(SUPPRESSED_PRESENCE_KINDS.has(kind)).toBe(true);
      }
      expect(PAUSABLE_PRESENCE_KINDS.size).toBeLessThan(SUPPRESSED_PRESENCE_KINDS.size);
    });

    // Named individually rather than by set-difference: these two are
    // excluded for REASONS (the #372/#373 migration, channel-mode state),
    // and a test that just recomputed the difference would happily follow
    // someone deleting one of them.
    it("never drops nick_change — it drives the #372/#373 cache migration", () => {
      expect(PAUSABLE_PRESENCE_KINDS.has("nick_change")).toBe(false);
    });

    it("never drops mode", () => {
      expect(PAUSABLE_PRESENCE_KINDS.has("mode")).toBe(false);
    });
  });

  describe("the drop predicate", () => {
    it("drops a peer join/part/quit once the channel is paused", () => {
      const pause = createPresencePause(vi.fn(), PRESENCE_COOLDOWN_MS);
      pause.focus(alice);
      pause.focus(bob);
      vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS);

      expect(pause.isPaused(alice)).toBe(true);
      for (const kind of ["join", "part", "quit"] as const) {
        expect(pause.shouldDrop(alice, kind, false)).toBe(true);
      }
      pause.dispose();
    });

    it("drops nothing before the window elapses", () => {
      const pause = createPresencePause(vi.fn(), PRESENCE_COOLDOWN_MS);
      pause.focus(alice);
      pause.focus(bob);
      vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS - 1);

      expect(pause.shouldDrop(alice, "join", false)).toBe(false);
      pause.dispose();
    });

    it("never drops OUR OWN presence, however long the channel sat paused", () => {
      const pause = createPresencePause(vi.fn(), PRESENCE_COOLDOWN_MS);
      pause.focus(alice);
      pause.focus(bob);
      vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS * 10);

      // An own PART tears the window down (#200); swallowing it would leak
      // the subscription and strand a dead window.
      expect(pause.shouldDrop(alice, "part", true)).toBe(false);
      expect(pause.shouldDrop(alice, "join", true)).toBe(false);
      pause.dispose();
    });

    it("never drops a message, whatever the pause state", () => {
      const pause = createPresencePause(vi.fn(), PRESENCE_COOLDOWN_MS);
      pause.focus(alice);
      pause.focus(bob);
      vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS);

      // vjt, 2026-08-22: messages must not be lost. Quiet, not blind.
      for (const kind of ["privmsg", "notice", "action"] as const) {
        expect(pause.shouldDrop(alice, kind, false)).toBe(false);
      }
      pause.dispose();
    });

    it("never drops on the focused channel", () => {
      const pause = createPresencePause(vi.fn(), PRESENCE_COOLDOWN_MS);
      pause.focus(alice);
      vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS * 10);

      expect(pause.shouldDrop(alice, "join", false)).toBe(false);
      pause.dispose();
    });
  });

  describe("the resume seam", () => {
    it("refetches exactly when presence was actually missed", () => {
      const onResume = vi.fn();
      const pause = createPresencePause(onResume, PRESENCE_COOLDOWN_MS);

      pause.focus(alice);
      pause.focus(bob);
      vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS);
      expect(pause.isPaused(alice)).toBe(true);

      pause.focus(alice);
      expect(onResume).toHaveBeenCalledTimes(1);
      expect(onResume).toHaveBeenCalledWith(alice);
      expect(pause.isPaused(alice)).toBe(false);
      pause.dispose();
    });

    // The flick again, from the other side: nothing was dropped, so there is
    // nothing to rebuild and the refetch must NOT fire. A resume that fired
    // on every re-focus would BE the refetch storm the cooldown exists to
    // prevent — #1679's failure mode, reintroduced at the other end.
    it("does not refetch for a channel that was never paused", () => {
      const onResume = vi.fn();
      const pause = createPresencePause(onResume, PRESENCE_COOLDOWN_MS);

      pause.focus(alice);
      pause.focus(bob);
      vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS / 2);
      pause.focus(alice);

      expect(onResume).not.toHaveBeenCalled();
      pause.dispose();
    });

    it("re-focusing the already-focused channel is a no-op", () => {
      const onResume = vi.fn();
      const pause = createPresencePause(onResume, PRESENCE_COOLDOWN_MS);

      pause.focus(alice);
      pause.focus(alice);
      vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS * 2);

      // Still focused, so still never paused — a repeated selection event
      // must not arm its own window.
      expect(pause.isPaused(alice)).toBe(false);
      expect(onResume).not.toHaveBeenCalled();
      pause.dispose();
    });
  });

  describe("selection leaving channel-shaped windows", () => {
    it("arms the window when selection goes to null", () => {
      const pause = createPresencePause(vi.fn(), PRESENCE_COOLDOWN_MS);
      pause.focus(alice);
      pause.focus(null);
      vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS);

      expect(pause.isPaused(alice)).toBe(true);
      pause.dispose();
    });
  });

  it("dispose un-pauses everything and cancels pending windows", () => {
    const onResume = vi.fn();
    const pause = createPresencePause(onResume, PRESENCE_COOLDOWN_MS);

    pause.focus(alice);
    pause.focus(bob);
    pause.dispose();
    vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS * 2);

    expect(pause.paused()).toEqual([]);
    expect(pause.shouldDrop(alice, "join", false)).toBe(false);
    expect(onResume).not.toHaveBeenCalled();
  });
});
