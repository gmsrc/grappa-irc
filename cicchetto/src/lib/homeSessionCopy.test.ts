import { describe, expect, it } from "vitest";
import type { HomeNetworkRow, MeResponse } from "./api";
import { HOME_ALWAYS_ON_COPY, homeSessionLifetime } from "./homeSessionCopy";

// #496 — the home pane's per-subject session-lifetime copy is a PURE fn so
// the three audience truths (unregistered visitor 48h / registered visitor ∞
// / registered user ∞ + 7-day device login) are unit-testable without a real
// DOM, and stay honest to the server:
//   * unregistered visitor — `@anon_ttl_seconds` = 48h sliding TTL
//     (Grappa.Visitors).
//   * registered visitor — no expiry: `Credentials.visitor_registered?/1`
//     short-circuits `Visitors.touch/1` (NOT an `expires_at = NULL` flag).
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

describe("homeSessionLifetime — registered visitor (∞)", () => {
  it("names nick + network when the visitor is on exactly one network", () => {
    const copy = homeSessionLifetime(visitorMe({ registered: true }), [row("azzurra", "alice")]);
    expect(copy.testid).toBe("home-session-visitor-registered");
    expect(copy.text).toMatch(/indefinitely/i);
    expect(copy.text).toContain("alice");
    expect(copy.text).toContain("azzurra");
  });

  it("stays general (still ∞) with zero networks", () => {
    const copy = homeSessionLifetime(visitorMe({ registered: true }), []);
    expect(copy.testid).toBe("home-session-visitor-registered");
    expect(copy.text).toMatch(/indefinitely/i);
  });

  it("stays general (still ∞) with multiple networks — no false per-network claim", () => {
    const copy = homeSessionLifetime(visitorMe({ registered: true }), [
      row("azzurra", "alice"),
      row("libera", "bob"),
    ]);
    expect(copy.testid).toBe("home-session-visitor-registered");
    expect(copy.text).toMatch(/indefinitely/i);
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
