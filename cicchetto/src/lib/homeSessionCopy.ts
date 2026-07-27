import type { HomeNetworkRow, MeResponse } from "./api";

// #496 — the home pane's copy, centralised here so the three per-subject
// session-lifetime truths stay honest to the server and unit-testable as a
// pure fn (jsdom can't prove viewport/layout, but it CAN pin exact strings).
// Copy is cic-owned (no-localized-strings-server-side): the server hands cic
// the structured data (`me.kind`, `me.registered`, per-network `{slug, nick}`)
// and cic writes the words.
//
// The facts, each verified against the server (do NOT reword away):
//   * unregistered visitor — 48h sliding inactivity TTL
//     (`Grappa.Visitors @anon_ttl_seconds = 48 * 3600`); on expiry the row +
//     its scrollback are CASCADE-deleted.
//   * registered visitor — no expiry: `Credentials.visitor_registered?/1`
//     (≥1 credential with a committed NickServ secret) short-circuits
//     `Visitors.touch/1`. Derived, NOT an `expires_at = NULL` flag.
//   * registered user — the IRC connection is kept up indefinitely, but the
//     per-DEVICE auth session slides 7 days of inactivity
//     (`Grappa.Accounts @idle_timeout_seconds = 7 * 24 * 3600`). A flat
//     "your session never expires" is FALSE — the 7-day device login fact
//     must survive any rewrite.

// Req #1 — the universal always-on value prop. Plain language for someone who
// has never heard the word "bouncer": the connection lives on the server, and
// reopening the app is enough to be back in the conversation.
export const HOME_ALWAYS_ON_COPY =
  "Grappa keeps you connected to IRC even while this app is closed. Just open it " +
  "and you're back in your conversations right where you left off — no reconnecting, " +
  "nothing lost.";

// Req #3 — the one-line intro above the networks list.
export const HOME_NETWORKS_INTRO_COPY = "Below are the IRC networks you can chat on.";

// Req #5 — the one-line intro above an operator-curated featured list. Only
// rendered when the list is non-empty (absent list, absent text).
export function homeFeaturedIntroCopy(slug: string): string {
  return `Channels worth a look on ${slug}:`;
}

export type SessionLifetimeCopy = {
  // Stable per-kind hook so the e2e can assert the RENDERED copy for each
  // subject without matching on brittle prose.
  testid: "home-session-user" | "home-session-visitor-registered" | "home-session-visitor-guest";
  text: string;
};

// Req #2 — the per-subject session-lifetime line. `networks` is only read to
// name a registered visitor's nick+network when they're on exactly one (see
// below); the ∞/48h/7-day truth itself keys purely on the subject.
export function homeSessionLifetime(
  me: MeResponse,
  networks: HomeNetworkRow[],
): SessionLifetimeCopy {
  if (me.kind === "user") {
    return {
      testid: "home-session-user",
      text:
        "Your chat stays connected — always. This device stays signed in for 7 days " +
        "of inactivity; after that you'll sign back in, but Grappa never drops your " +
        "IRC connection.",
    };
  }

  if (me.registered === true) {
    // Registration is identity-wide (`visitor_registered?/1` is true iff ANY
    // network holds a credential with a committed secret). Naming a SPECIFIC
    // "nick on network" is only honest when the visitor is on exactly one
    // network — then that network must be the registered one. With zero or
    // several networks we keep the ∞ claim but drop the per-network naming
    // (a second, anon network would make "registered on <it>" a lie).
    const only = networks.length === 1 ? networks[0] : undefined;
    const naming = only ? ` as ${only.nick} on ${only.slug}` : "";
    return {
      testid: "home-session-visitor-registered",
      text:
        `You're registered${naming}, so your session stays connected indefinitely — ` +
        "it won't expire while you're away.",
    };
  }

  return {
    testid: "home-session-visitor-guest",
    text:
      "You're chatting as a guest. Your session is kept alive for up to 48 hours of " +
      "inactivity — after that it expires and everything in it is gone.",
  };
}
