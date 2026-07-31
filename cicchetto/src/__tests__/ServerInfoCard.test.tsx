import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import type { Network } from "../lib/api";
import ServerInfoCard from "../ServerInfoCard";

// #474 — the server-window rail card. Pure presentational: it takes the
// already-in-store `Network` + an injected `now` (epoch ms) so the rendered
// duration is deterministic. Facts-only — slug, nick, connection state (+
// reason), connected-since, services flavor, AND (scope B) the live upstream
// connection facts under `network.connection`: which box the socket dialled
// (`server:port`), whether it is TLS, and whether the nick is identified to
// services. `connection` is null when the session is not live (honesty), so
// those rows appear ONLY when there is a real connected socket.

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
  connection: { server: "89.31.72.10", port: 6697, tls: true, registered: true },
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
          connection: null,
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
          connection: null,
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

  it("renders the dialled server:port, a TLS lock and identified state (#474 B)", () => {
    render(() => <ServerInfoCard network={baseNet} now={now} />);
    const card = screen.getByTestId("rail-server-info");
    // The box the session actually landed on (round-robin triage).
    expect(card.textContent).toContain("89.31.72.10:6697");
    // TLS lock present on a secure link.
    expect(card.querySelector("[aria-label='TLS']")).not.toBeNull();
    // +r registered → identified to services.
    expect(card.querySelector("[data-testid=rail-server-info-identified]")?.textContent).toBe(
      "yes",
    );
  });

  it("shows the non-TLS + not-identified state honestly", () => {
    render(() => (
      <ServerInfoCard
        network={{
          ...baseNet,
          connection: { server: "127.0.0.1", port: 6667, tls: false, registered: false },
        }}
        now={now}
      />
    ));
    const card = screen.getByTestId("rail-server-info");
    expect(card.textContent).toContain("127.0.0.1:6667");
    // No lock on a plain-text socket.
    expect(card.querySelector("[aria-label='TLS']")).toBeNull();
    expect(card.querySelector("[data-testid=rail-server-info-identified]")?.textContent).toBe("no");
  });

  it("shows NO connection rows when connection is null (session not live)", () => {
    render(() => <ServerInfoCard network={{ ...baseNet, connection: null }} now={now} />);
    const card = screen.getByTestId("rail-server-info");
    expect(card.textContent).not.toContain("89.31.72.10");
    expect(card.querySelector("[aria-label='TLS']")).toBeNull();
    expect(card.querySelector("[data-testid=rail-server-info-identified]")).toBeNull();
  });
});
