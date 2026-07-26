import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import LinksModal from "../LinksModal";
import type { LinksEntry, LinksReply } from "../lib/api";
import { dismissLinksModal, setLinksReply } from "../lib/linksModal";
import {
  __resetForTest,
  overlayEscapeDepth,
  runTopmostOverlayEscape,
} from "../lib/overlayScrollLock";
import { setSelectedChannel } from "../lib/selection";

// #238 — LinksModal renders the buffered /links topology (parsed 364/365
// `links_bundle`) as an interactive radial SVG map for the ACTIVE network:
// one <g data-testid="links-modal-node"> per server, one <line> per parent
// edge, a "network map — N servers" heading, a node-detail footer on
// select, and a dismiss on × / Esc. An EMPTY bundle opens the "hides
// topology" empty state. The geometry itself is unit-tested in
// linksLayout.test.ts; this file covers the render + interaction contract.

const SLUG = "azzurra";

const linkEntry = (over: Partial<LinksEntry>): LinksEntry => ({
  server: "irc.test.org",
  linked_to: null,
  hopcount: null,
  description: null,
  ...over,
});

const reply = (entries: LinksEntry[]): LinksReply => ({ network: SLUG, entries });

// A canonical three-server topology: hub (root, self-link) → mid → leaf.
const tripleReply = (): LinksReply =>
  reply([
    linkEntry({
      server: "hub.test.org",
      linked_to: "hub.test.org",
      hopcount: 0,
      description: "the hub",
    }),
    linkEntry({
      server: "mid.test.org",
      linked_to: "hub.test.org",
      hopcount: 1,
      description: "a middle",
    }),
    linkEntry({
      server: "leaf.test.org",
      linked_to: "mid.test.org",
      hopcount: 2,
      description: "a leaf",
    }),
  ]);

const focusNetwork = (): void =>
  setSelectedChannel({ networkSlug: SLUG, channelName: "$server", kind: "server" });

const nodeEls = (): HTMLElement[] => screen.getAllByTestId("links-modal-node");
const nodeFor = (server: string): HTMLElement | undefined =>
  nodeEls().find((el) => el.getAttribute("data-server") === server);

describe("LinksModal (#238)", () => {
  afterEach(() => {
    dismissLinksModal(SLUG);
    setSelectedChannel(null);
    __resetForTest();
  });

  it("renders the map with one node per server and one edge per parent link", () => {
    focusNetwork();
    setLinksReply(SLUG, tripleReply());
    const { container } = render(() => <LinksModal />);

    expect(screen.getByTestId("links-modal")).toBeInTheDocument();
    expect(screen.getByTestId("links-modal-svg")).toBeInTheDocument();
    // Three servers → three nodes, two parent edges (a tree of N nodes has
    // N-1 edges).
    expect(nodeEls()).toHaveLength(3);
    expect(container.querySelectorAll(".links-modal-edge")).toHaveLength(2);
  });

  it("renders the server-count heading (plural for a multi-server net)", () => {
    focusNetwork();
    setLinksReply(SLUG, tripleReply());
    render(() => <LinksModal />);
    expect(screen.getByTestId("links-modal").textContent).toContain("network map — 3 servers");
  });

  it("renders the singular heading for a lone server", () => {
    focusNetwork();
    setLinksReply(SLUG, reply([linkEntry({ server: "solo", linked_to: "solo", hopcount: 0 })]));
    render(() => <LinksModal />);
    expect(screen.getByTestId("links-modal").textContent).toContain("network map — 1 server");
    expect(nodeEls()).toHaveLength(1);
  });

  it("opens the detail footer on node click, showing server, hops and uplink", () => {
    focusNetwork();
    setLinksReply(SLUG, tripleReply());
    render(() => <LinksModal />);
    // No detail until a node is selected.
    expect(screen.queryByTestId("links-modal-detail")).not.toBeInTheDocument();

    const mid = nodeFor("mid.test.org");
    expect(mid).toBeDefined();
    fireEvent.click(mid as HTMLElement);

    const detail = screen.getByTestId("links-modal-detail");
    expect(detail.textContent).toContain("mid.test.org");
    expect(detail.textContent).toContain("1 hops");
    // The uplink arrow shows the reconstructed parent (the raw linked_to).
    expect(detail.textContent).toContain("hub.test.org");
  });

  it("renders the empty state (no svg) for a hidden topology", () => {
    focusNetwork();
    setLinksReply(SLUG, reply([]));
    render(() => <LinksModal />);
    expect(screen.getByTestId("links-modal")).toBeInTheDocument();
    expect(screen.getByTestId("links-modal-empty")).toBeInTheDocument();
    expect(screen.getByTestId("links-modal-empty").textContent).toContain(
      "this network hides its topology",
    );
    // The SVG canvas + nodes are absent — the empty state replaces them.
    expect(screen.queryByTestId("links-modal-svg")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("links-modal-node")).toHaveLength(0);
  });

  it("renders nothing when no topology is buffered for the active network", () => {
    focusNetwork();
    render(() => <LinksModal />);
    expect(screen.queryByTestId("links-modal")).not.toBeInTheDocument();
  });

  it("renders nothing when the buffered topology belongs to a DIFFERENT network", () => {
    // Bundle stored under another slug; the active network has none → closed.
    setLinksReply("libera", tripleReply());
    focusNetwork();
    render(() => <LinksModal />);
    expect(screen.queryByTestId("links-modal")).not.toBeInTheDocument();
  });

  it("dismisses on the close button (drops the store entry)", () => {
    focusNetwork();
    setLinksReply(SLUG, tripleReply());
    render(() => <LinksModal />);
    fireEvent.click(screen.getByLabelText("close links"));
    expect(screen.queryByTestId("links-modal")).not.toBeInTheDocument();
  });

  // #232 — Esc closes via the shared overlay stack (focus-independent), the
  // exact verb the global keydown listener invokes.
  it("closes on Escape via the shared overlay stack (focus-independent)", async () => {
    focusNetwork();
    setLinksReply(SLUG, tripleReply());
    render(() => <LinksModal />);
    await waitFor(() => expect(overlayEscapeDepth()).toBe(1));
    expect(runTopmostOverlayEscape()).toBe(true);
    await waitFor(() => expect(screen.queryByTestId("links-modal")).not.toBeInTheDocument());
  });
});
