import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import type { Network } from "../lib/api";
import ServerInfoCard from "../ServerInfoCard";

// #474 — the server-window rail card. Pure presentational: it takes the
// already-in-store `Network` + an injected `now` (epoch ms) so the rendered
// duration is deterministic. Facts-only — slug, nick, connection state (+
// reason), connected-since, services flavor. It deliberately does NOT show
// the dialled server address / TLS / registered state: those are NOT in the
// user-facing store (admin-only wire), and the #474 rule is "prefer leaving
// it out over showing a stale value confidently".

const now = Date.parse("2026-07-31T12:00:00.000Z");

const baseNet: Network = {
  kind: "user",
  id: 7,
  slug: "libera",
  services_flavor: "atheme",
  nick: "vjt",
  ident: "vjt",
  realname: "VJT",
  connection_state: "connected",
  connection_state_reason: null,
  connection_state_changed_at: new Date(now - (4 * 3600 + 12 * 60) * 1000).toISOString(),
  inserted_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

describe("ServerInfoCard", () => {
  it("renders the network slug, own nick, connected state, uptime and services", () => {
    render(() => <ServerInfoCard network={baseNet} now={now} />);
    const card = screen.getByTestId("rail-server-info");
    expect(card.textContent).toContain("libera"); // network slug (the only label)
    expect(card.textContent).toContain("vjt"); // own nick on this network
    expect(card.textContent).toContain("connected"); // connection-state word (a11y label)
    expect(card.textContent).toContain("4h 12m"); // connected-since duration
    expect(card.textContent).toContain("atheme"); // services flavor
  });

  it("shows NO uptime row when the state is parked, but shows the state + reason", () => {
    render(() => (
      <ServerInfoCard
        network={{
          ...baseNet,
          connection_state: "parked",
          connection_state_reason: "user /disconnect",
        }}
        now={now}
      />
    ));
    const card = screen.getByTestId("rail-server-info");
    expect(card.textContent).toContain("parked");
    expect(card.textContent).toContain("user /disconnect");
    // Honesty: a "connected for 4h 12m" line would be a lie while parked.
    expect(card.textContent).not.toContain("4h 12m");
  });

  it("shows the failed state with its reason", () => {
    render(() => (
      <ServerInfoCard
        network={{
          ...baseNet,
          connection_state: "failed",
          connection_state_reason: "SASL 904 authentication failed",
        }}
        now={now}
      />
    ));
    const card = screen.getByTestId("rail-server-info");
    expect(card.textContent).toContain("failed");
    expect(card.textContent).toContain("SASL 904 authentication failed");
  });

  it("omits the uptime row when connected but the timestamp is unknown (null)", () => {
    render(() => (
      <ServerInfoCard network={{ ...baseNet, connection_state_changed_at: null }} now={now} />
    ));
    const card = screen.getByTestId("rail-server-info");
    expect(card.textContent).toContain("connected");
    expect(card.textContent).not.toContain("4h 12m");
  });

  it("omits the services row when the flavor is unknown (no useful fact)", () => {
    render(() => <ServerInfoCard network={{ ...baseNet, services_flavor: "unknown" }} now={now} />);
    const card = screen.getByTestId("rail-server-info");
    expect(card.textContent).not.toContain("services");
  });
});
