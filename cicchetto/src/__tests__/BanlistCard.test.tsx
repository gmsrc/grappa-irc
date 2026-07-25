import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import BanlistCard from "../BanlistCard";
import { setBanlistBundle } from "../lib/banlistCard";

// #376 — BANLIST card component. Render assertions only — wire dispatch
// is covered by userTopic.test.ts.
//
// The card is ONE surface (a channel's ban list = one logical entity)
// that CONTAINS multiple ban ROWS (mask · set-by · set-time). The core
// regression it guards: a ban entry must render the banmask + setter,
// NOT a bare set-timestamp (the #376 leak).
//
// Test isolation: store accumulates per-network with last-write-wins
// semantics. Each test uses a unique network slug to avoid cross-test
// contamination.

// 1784572878 → mid-2026 regardless of timezone; safe to assert the year.
const FULL_BUNDLE = {
  network: "net-full",
  channel: "#test",
  entries: [
    { mask: "*!*@banned.host", setter: "op!u@h", set_ts: "1784572878" },
    { mask: "evil!*@spam.net", setter: "mod!u@h", set_ts: "1784564620" },
  ],
};

describe("BanlistCard", () => {
  it("renders no DOM node when no bundle exists for the network", () => {
    const { container } = render(() => <BanlistCard networkSlug="net-empty" />);
    expect(container.querySelector("[data-testid='banlist-card']")).toBeNull();
  });

  it("renders one row per ban with mask + setter (not a bare timestamp)", () => {
    setBanlistBundle("net-full", FULL_BUNDLE);
    render(() => <BanlistCard networkSlug="net-full" />);
    const card = screen.getByTestId("banlist-card");
    // channel header
    expect(card.textContent).toContain("#test");
    // both masks
    expect(card.textContent).toContain("*!*@banned.host");
    expect(card.textContent).toContain("evil!*@spam.net");
    // setters
    expect(card.textContent).toContain("op!u@h");
    expect(card.textContent).toContain("mod!u@h");
    // #376 core: the bare unix timestamp is NEVER shown; it is formatted.
    expect(card.textContent).not.toContain("1784572878");
    expect(card.textContent).toContain("2026");
  });

  it("renders an empty state when the channel has no bans", () => {
    setBanlistBundle("net-nobans", { network: "net-nobans", channel: "#quiet", entries: [] });
    render(() => <BanlistCard networkSlug="net-nobans" />);
    const card = screen.getByTestId("banlist-card");
    expect(card.textContent).toContain("#quiet");
    expect(card.textContent?.toLowerCase()).toContain("no bans");
  });

  it("renders a ban with nil setter/set_ts (older ircd) showing only the mask", () => {
    setBanlistBundle("net-old", {
      network: "net-old",
      channel: "#old",
      entries: [{ mask: "*!*@old.host", setter: null, set_ts: null }],
    });
    render(() => <BanlistCard networkSlug="net-old" />);
    const card = screen.getByTestId("banlist-card");
    expect(card.textContent).toContain("*!*@old.host");
  });

  it("does not render for a different network", () => {
    setBanlistBundle("net-x", FULL_BUNDLE);
    const { container } = render(() => <BanlistCard networkSlug="net-other" />);
    expect(container.querySelector("[data-testid='banlist-card']")).toBeNull();
  });
});
