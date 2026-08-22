import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";
import { createPresenceCooldown, PRESENCE_COOLDOWN_MS } from "../lib/presenceCooldown";

// #1680 — the cooldown that stands between "the user left this channel alone"
// and "the user flicked past it".
//
// The whole point of the window is that the SECOND case must never release a
// subscription. Every test below is about which of the two a given sequence
// of focus/blur events is.

const alice = channelKey("azzurra", "#alice");
const bob = channelKey("azzurra", "#bob");

describe("presenceCooldown (#1680)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases a channel the user left alone for the whole cooldown", () => {
    const release = vi.fn();
    const cd = createPresenceCooldown(release, PRESENCE_COOLDOWN_MS);

    cd.blurred(alice);
    vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS);

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(alice);
    cd.dispose();
  });

  it("does not release before the cooldown has fully elapsed", () => {
    const release = vi.fn();
    const cd = createPresenceCooldown(release, PRESENCE_COOLDOWN_MS);

    cd.blurred(alice);
    vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS - 1);

    expect(release).not.toHaveBeenCalled();
    cd.dispose();
  });

  // THE case the cooldown exists for. vjt, 2026-08-22: "a channel the user
  // flicks through and comes back to should never have left."
  it("never releases a channel the user came back to inside the window", () => {
    const release = vi.fn();
    const cd = createPresenceCooldown(release, PRESENCE_COOLDOWN_MS);

    cd.blurred(alice);
    vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS / 2);
    cd.focused(alice);
    vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS * 10);

    expect(release).not.toHaveBeenCalled();
    cd.dispose();
  });

  // The tour described in the issue: ten channels touched inside the window
  // hold ten subscriptions. That is the ACCEPTED trade, so it is asserted as
  // behaviour rather than left implicit — if someone "optimises" it into
  // one-at-a-time, this test says what was given up.
  it("holds every channel touched inside one window (the accepted trade)", () => {
    const release = vi.fn();
    const cd = createPresenceCooldown(release, PRESENCE_COOLDOWN_MS);
    const tour = Array.from({ length: 10 }, (_, i) => channelKey("azzurra", `#c${i}`));

    for (const key of tour) {
      cd.focused(key);
      vi.advanceTimersByTime(1000);
      cd.blurred(key);
    }

    expect(release).not.toHaveBeenCalled();
    expect(cd.pending().length).toBe(10);
    cd.dispose();
  });

  it("re-arms a fresh window on each blur instead of stacking timers", () => {
    const release = vi.fn();
    const cd = createPresenceCooldown(release, PRESENCE_COOLDOWN_MS);

    cd.blurred(alice);
    vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS / 2);
    cd.blurred(alice);
    vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS);

    // One release, not two: the second blur replaced the first window.
    expect(release).toHaveBeenCalledTimes(1);
    cd.dispose();
  });

  it("tracks each channel on its own window", () => {
    const release = vi.fn();
    const cd = createPresenceCooldown(release, PRESENCE_COOLDOWN_MS);

    cd.blurred(alice);
    vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS / 2);
    cd.blurred(bob);
    vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS / 2);

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(alice);

    vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS / 2);
    expect(release).toHaveBeenCalledWith(bob);
    cd.dispose();
  });

  it("focusing a channel with no pending window is a no-op", () => {
    const release = vi.fn();
    const cd = createPresenceCooldown(release, PRESENCE_COOLDOWN_MS);

    cd.focused(alice);
    vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS * 2);

    expect(release).not.toHaveBeenCalled();
    cd.dispose();
  });

  it("dispose cancels every pending window (teardown leaks no release)", () => {
    const release = vi.fn();
    const cd = createPresenceCooldown(release, PRESENCE_COOLDOWN_MS);

    cd.blurred(alice);
    cd.blurred(bob);
    cd.dispose();
    vi.advanceTimersByTime(PRESENCE_COOLDOWN_MS * 2);

    expect(release).not.toHaveBeenCalled();
    expect(cd.pending()).toEqual([]);
  });

  // THE MUTANT (orchestrator's ask). Zero the cooldown and the flick test
  // above inverts: the channel the user came straight back to has already
  // been released. This is what proves the window is load-bearing and not
  // decoration — if `createPresenceCooldown` ever ignored its cooldownMs,
  // the flick test would still pass and only this one would fail.
  it("MUTANT: with a zero cooldown the flicked channel is released anyway", () => {
    const release = vi.fn();
    const cd = createPresenceCooldown(release, 0);

    cd.blurred(alice);
    vi.advanceTimersByTime(0);
    cd.focused(alice);

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(alice);
    cd.dispose();
  });

  it("the shipped window is two minutes, and it is a chosen number", () => {
    // Guards the ONE named place. If someone tunes it, they tune it here and
    // this line is the review surface — not a literal buried in a caller.
    expect(PRESENCE_COOLDOWN_MS).toBe(120_000);
  });
});
