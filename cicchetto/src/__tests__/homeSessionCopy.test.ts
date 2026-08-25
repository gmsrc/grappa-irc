import { describe, expect, it } from "vitest";
import type { HomeNetworkRow, MeResponse } from "../lib/api";
import { HOME_ALWAYS_ON_COPY, homeSessionLifetime } from "../lib/homeSessionCopy";

// #496 — the home pane's per-subject session-lifetime copy is a PURE fn so
// the three audience truths (unregistered visitor 48h / registered visitor
// ∞ identity + 7-day device login / registered user ∞ IRC + 7-day device
// login) are unit-testable without a real DOM, and stay honest to the server:
//   * unregistered visitor — `@anon_ttl_seconds` = 48h sliding TTL
//     (Grappa.Visitors).
//   * registered visitor — the identity + scrollback never expire
//     (`Credentials.visitor_registered?/1` short-circuits `Visitors.touch/1`,
//     NOT an `expires_at = NULL` flag), but the DEVICE auth session STILL
//     slides the SAME 7 days as a user's (`Accounts.check_idle/1` is
//     subject-blind) — so the copy names the 7-day device login too.
//   * registered user — the IRC connection is ∞, but the DEVICE auth session
//     slides 7 days (`Grappa.Accounts @idle_timeout_seconds = 7 * 24 * 3600`).
// The rendered proof (per real subject) lives in the Playwright e2e
// (issue496-home-restyle.spec.ts); these tests pin the exact copy + facts.

function userMe(overrides: Partial<Extract<MeResponse, { kind: "user" }>> = {}): MeResponse {
  return {
    kind: "user",
    id: "u-1",
    name: "vjt",
    is_admin: false,
    inserted_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function visitorMe(overrides: Partial<Extract<MeResponse, { kind: "visitor" }>> = {}): MeResponse {
  return {
    kind: "visitor",
    id: "v-1",
    expires_at: "2026-01-03T00:00:00Z",
    ...overrides,
  };
}

function row(slug: string, nick: string): HomeNetworkRow {
  return {
    slug,
    nick,
    connection_state: "connected",
    connection_state_reason: null,
    connection_state_changed_at: null,
    recoverable: false,
  };
}

describe("HOME_ALWAYS_ON_COPY (the always-on value prop, req #1)", () => {
  it("explains the connection stays up and reopening the app is enough", () => {
    // Plain-language, no jargon ("bouncer" is fine as a label elsewhere but
    // the value prop must land for someone who's never heard the term).
    expect(HOME_ALWAYS_ON_COPY).toMatch(/connected/i);
    expect(HOME_ALWAYS_ON_COPY).toMatch(/open/i);
    expect(HOME_ALWAYS_ON_COPY).toMatch(/no reconnect|nothing lost|where you left off/i);
  });
});

describe("homeSessionLifetime — registered user (∞ IRC + 7-day device login)", () => {
  it("names the 7-day device idle and that the connection never drops", () => {
    const copy = homeSessionLifetime(userMe(), [row("bahamut-test", "vjt-grappa")]);
    expect(copy.testid).toBe("home-session-user");
    expect(copy.text).toMatch(/7 days/i);
    // The 7-day fact MUST survive: it's the device login, not the IRC session.
    expect(copy.text).toMatch(/always|never/i);
    // Honest: NOT "never expires" flat — that would be false.
    expect(copy.text).not.toMatch(/session never expires/i);
  });
});

describe("homeSessionLifetime — registered visitor (∞ identity + 7-day device login)", () => {
  it("states BOTH truths + names nick + network on exactly one network", () => {
    const copy = homeSessionLifetime(visitorMe({ registered: true }), [row("azzurra", "alice")]);
    expect(copy.testid).toBe("home-session-visitor-registered");
    // Two truths, both true TODAY (no server change): the chat stays connected
    // AND the per-DEVICE login slides 7 days (`Accounts.check_idle` is
    // subject-blind, so a registered visitor's bearer expires at 7 days just
    // like a user's).
    expect(copy.text).toMatch(/connected/i);
    expect(copy.text).toMatch(/7 days/i);
    // Honest: NOT a flat "indefinitely"/"won't expire while away" — the device
    // bearer DOES expire while away, only the identity + history are forever.
    expect(copy.text).not.toMatch(/indefinitely|won't expire while/i);
    expect(copy.text).toContain("alice");
    expect(copy.text).toContain("azzurra");
  });

  it("still states both truths with zero networks (no per-network naming)", () => {
    const copy = homeSessionLifetime(visitorMe({ registered: true }), []);
    expect(copy.testid).toBe("home-session-visitor-registered");
    expect(copy.text).toMatch(/connected/i);
    expect(copy.text).toMatch(/7 days/i);
  });

  it("stays general with multiple networks — no false per-network claim", () => {
    const copy = homeSessionLifetime(visitorMe({ registered: true }), [
      row("azzurra", "alice"),
      row("libera", "bob"),
    ]);
    expect(copy.testid).toBe("home-session-visitor-registered");
    expect(copy.text).toMatch(/7 days/i);
    expect(copy.text).not.toContain("azzurra");
    expect(copy.text).not.toContain("libera");
  });
});

describe("homeSessionLifetime — unregistered visitor (48h sliding TTL)", () => {
  it("names the 48-hour inactivity expiry and that everything is then gone", () => {
    const copy = homeSessionLifetime(visitorMe({ registered: false }), [row("azzurra", "guest42")]);
    expect(copy.testid).toBe("home-session-visitor-guest");
    expect(copy.text).toMatch(/48 hours/i);
    expect(copy.text).toMatch(/gone|expires/i);
  });

  it("treats an absent `registered` field as unregistered (test-mock / legacy /me)", () => {
    const copy = homeSessionLifetime(visitorMe(), []);
    expect(copy.testid).toBe("home-session-visitor-guest");
    expect(copy.text).toMatch(/48 hours/i);
  });
});
