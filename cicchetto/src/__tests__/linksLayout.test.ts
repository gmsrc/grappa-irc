import { describe, expect, it } from "vitest";
import type { LinksEntry } from "../lib/api";
import { DEFAULT_LAYOUT_OPTS, radialLayout } from "../lib/linksLayout";

// #238 — radialLayout is the PURE, DETERMINISTIC heart of the /links topology
// map: parsed 364/365 `links_bundle` entries → a positioned radial tidy-tree.
// These tests are the ground the whole feature stands on — the modal render and
// the e2e both assume this geometry. TDD teeth: exact node/edge COUNTS, the
// reconstructed parent edges, root selection priority, orphan re-parenting,
// cycle termination, and the root-at-centre invariant. Nothing is asserted by
// mirroring the impl — every check would FAIL if the reconstruction were wrong.
//
// All geometry constants derive from the production `DEFAULT_LAYOUT_OPTS` so a
// tuning change to ringGap/margin re-flows the expectations, never a stale
// magic number.

const { ringGap, margin } = DEFAULT_LAYOUT_OPTS;

// outer ring / centre / canvas size for a tree of a given max depth — the same
// formula radialLayout uses, restated once so the assertions read declaratively.
const centreFor = (maxDepth: number): number => maxDepth * ringGap + margin;
const sizeFor = (maxDepth: number): number => centreFor(maxDepth) * 2;

const entry = (over: Partial<LinksEntry>): LinksEntry => ({
  server: "irc.test.org",
  linked_to: null,
  hopcount: null,
  description: null,
  ...over,
});

const edgeKey = (from: string, to: string): string => `${from}->${to}`;
const edgeSet = (layout: ReturnType<typeof radialLayout>): Set<string> =>
  new Set(layout.edges.map((e) => edgeKey(e.from, e.to)));
const serverSet = (layout: ReturnType<typeof radialLayout>): string[] =>
  layout.nodes.map((n) => n.server);
const nodeBy = (layout: ReturnType<typeof radialLayout>, server: string) =>
  layout.nodes.find((n) => n.server === server);

describe("radialLayout (#238) — empty + single-node degenerate cases", () => {
  it("returns an empty layout for zero entries", () => {
    const layout = radialLayout([], DEFAULT_LAYOUT_OPTS);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
    expect(layout.maxDepth).toBe(0);
  });

  it("places a single self-linked node as the root, dead centre, with no edges", () => {
    const layout = radialLayout(
      [entry({ server: "hub", linked_to: "hub", hopcount: 0 })],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(layout.nodes).toHaveLength(1);
    expect(layout.edges).toHaveLength(0);
    const root = layout.nodes[0];
    expect(root?.isRoot).toBe(true);
    expect(root?.parent).toBeNull();
    expect(root?.depth).toBe(0);
    expect(root?.radius).toBe(0);
    // Root sits at the exact canvas centre (width/2 == height/2).
    expect(layout.width).toBe(sizeFor(0));
    expect(layout.height).toBe(sizeFor(0));
    expect(root?.x).toBe(layout.width / 2);
    expect(root?.y).toBe(layout.height / 2);
    expect(root?.x).toBe(centreFor(0));
  });

  it("treats a lone node with no self-link as the root anyway (no entry dropped)", () => {
    const layout = radialLayout(
      [entry({ server: "solo", linked_to: null, hopcount: null })],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]?.isRoot).toBe(true);
    expect(layout.edges).toHaveLength(0);
  });
});

describe("radialLayout (#238) — root selection priority", () => {
  it("prefers a self-linked node OVER a lower-hopcount peer", () => {
    // "a" has hopcount 0 (would win min-hopcount) but "hub" self-links with a
    // HIGHER hopcount — self-link must still win. Teeth: min-hopcount would
    // pick the wrong root.
    const layout = radialLayout(
      [
        entry({ server: "a", linked_to: "x", hopcount: 0 }),
        entry({ server: "hub", linked_to: "hub", hopcount: 5 }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(nodeBy(layout, "hub")?.isRoot).toBe(true);
    expect(nodeBy(layout, "a")?.isRoot).toBe(false);
    expect(layout.nodes).toHaveLength(2);
  });

  it("picks the minimum-hopcount node as root when no node self-links", () => {
    // "b" (hop 1) is neither first nor alphabetically first — only the
    // hopcount minimum. Teeth against a first-entry or alpha fallback.
    const layout = radialLayout(
      [
        entry({ server: "a", linked_to: "b", hopcount: 3 }),
        entry({ server: "b", linked_to: "c", hopcount: 1 }),
        entry({ server: "c", linked_to: "d", hopcount: 2 }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(nodeBy(layout, "b")?.isRoot).toBe(true);
    expect(nodeBy(layout, "b")?.depth).toBe(0);
  });

  it("falls back to the first entry when no self-link and all hopcounts are null", () => {
    // "z" is first but alphabetically LAST — first-entry fallback picks it,
    // proving it is not an alpha-min or a min-hopcount pick.
    const layout = radialLayout(
      [
        entry({ server: "z", linked_to: null, hopcount: null }),
        entry({ server: "a", linked_to: "z", hopcount: null }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(nodeBy(layout, "z")?.isRoot).toBe(true);
    expect(nodeBy(layout, "a")?.isRoot).toBe(false);
  });
});

describe("radialLayout (#238) — depth, edges, and geometry", () => {
  it("assigns depth from the reconstructed root and one edge per parent link", () => {
    // A three-hop chain: hub → mid → leaf.
    const layout = radialLayout(
      [
        entry({ server: "hub", linked_to: "hub", hopcount: 0 }),
        entry({ server: "mid", linked_to: "hub", hopcount: 1 }),
        entry({ server: "leaf", linked_to: "mid", hopcount: 2 }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(layout.nodes).toHaveLength(3);
    expect(nodeBy(layout, "hub")?.depth).toBe(0);
    expect(nodeBy(layout, "mid")?.depth).toBe(1);
    expect(nodeBy(layout, "leaf")?.depth).toBe(2);
    expect(layout.maxDepth).toBe(2);

    // Depth drives the ring radius.
    expect(nodeBy(layout, "hub")?.radius).toBe(0);
    expect(nodeBy(layout, "mid")?.radius).toBe(ringGap);
    expect(nodeBy(layout, "leaf")?.radius).toBe(2 * ringGap);

    // Exactly the two parent edges, no more.
    expect(layout.edges).toHaveLength(2);
    expect(edgeSet(layout)).toEqual(new Set([edgeKey("hub", "mid"), edgeKey("mid", "leaf")]));

    // Canvas fits maxDepth; root centred.
    expect(layout.width).toBe(sizeFor(2));
    expect(layout.height).toBe(sizeFor(2));
    expect(nodeBy(layout, "hub")?.x).toBe(centreFor(2));
    expect(nodeBy(layout, "hub")?.y).toBe(centreFor(2));
  });

  it("reconstructs a star: one root with N leaf edges", () => {
    const layout = radialLayout(
      [
        entry({ server: "hub", linked_to: "hub", hopcount: 0 }),
        entry({ server: "leafA", linked_to: "hub", hopcount: 1 }),
        entry({ server: "leafB", linked_to: "hub", hopcount: 1 }),
        entry({ server: "leafC", linked_to: "hub", hopcount: 1 }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(layout.nodes).toHaveLength(4);
    expect(layout.edges).toHaveLength(3);
    expect(edgeSet(layout)).toEqual(
      new Set([edgeKey("hub", "leafA"), edgeKey("hub", "leafB"), edgeKey("hub", "leafC")]),
    );
    // Every leaf is depth 1; maxDepth 1.
    expect(layout.maxDepth).toBe(1);
    for (const leaf of ["leafA", "leafB", "leafC"]) {
      expect(nodeBy(layout, leaf)?.depth).toBe(1);
    }
  });

  it("passes hopcount + description through verbatim onto the node", () => {
    const layout = radialLayout(
      [
        entry({ server: "hub", linked_to: "hub", hopcount: 0, description: "the hub" }),
        entry({ server: "leaf", linked_to: "hub", hopcount: 7, description: "a \x02leaf\x02" }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(nodeBy(layout, "leaf")?.hopcount).toBe(7);
    expect(nodeBy(layout, "leaf")?.description).toBe("a \x02leaf\x02");
    expect(nodeBy(layout, "hub")?.description).toBe("the hub");
  });
});

describe("radialLayout (#238) — resilience: orphans, dupes, cycles", () => {
  it("re-parents an orphan (uplink absent from the set) onto the root", () => {
    // "orphan" claims uplink "ghost" which never appears — it must NOT vanish;
    // the layout hangs it under the root so every server stays visible.
    const layout = radialLayout(
      [
        entry({ server: "hub", linked_to: "hub", hopcount: 0 }),
        entry({ server: "orphan", linked_to: "ghost", hopcount: 5 }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(layout.nodes).toHaveLength(2);
    // Tree edge attaches the orphan to the root...
    expect(edgeSet(layout)).toEqual(new Set([edgeKey("hub", "orphan")]));
    expect(nodeBy(layout, "orphan")?.depth).toBe(1);
    // ...while the node still reports the RAW uplink the server claimed (the
    // detail footer shows what upstream said, phantom or not).
    expect(nodeBy(layout, "orphan")?.parent).toBe("ghost");
  });

  it("de-dupes a repeated server (a malformed double 364) to a single node", () => {
    const layout = radialLayout(
      [
        entry({ server: "hub", linked_to: "hub", hopcount: 0 }),
        entry({ server: "leaf", linked_to: "hub", hopcount: 1, description: "first" }),
        entry({ server: "leaf", linked_to: "hub", hopcount: 1, description: "second" }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(layout.nodes).toHaveLength(2);
    // Last write wins.
    expect(nodeBy(layout, "leaf")?.description).toBe("second");
  });

  it("terminates on a mutual-uplink cycle and emits each node exactly once", () => {
    // a → b and b → a with no self-link. Without the visited-set guard the
    // depth walk would recurse forever; the layout must still terminate with
    // two unique nodes and a single edge.
    const layout = radialLayout(
      [
        entry({ server: "a", linked_to: "b", hopcount: 1 }),
        entry({ server: "b", linked_to: "a", hopcount: 1 }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    const servers = serverSet(layout);
    expect(servers).toHaveLength(2);
    expect(new Set(servers).size).toBe(2); // no duplicate node
    expect(layout.edges).toHaveLength(1);
  });

  it("never emits a duplicate node across a larger mixed topology", () => {
    const layout = radialLayout(
      [
        entry({ server: "hub", linked_to: "hub", hopcount: 0 }),
        entry({ server: "eu", linked_to: "hub", hopcount: 1 }),
        entry({ server: "us", linked_to: "hub", hopcount: 1 }),
        entry({ server: "eu-1", linked_to: "eu", hopcount: 2 }),
        entry({ server: "eu-2", linked_to: "eu", hopcount: 2 }),
        entry({ server: "us-1", linked_to: "us", hopcount: 2 }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    const servers = serverSet(layout);
    expect(servers).toHaveLength(6);
    expect(new Set(servers).size).toBe(6);
    // Every non-root node contributes exactly one edge → edges == nodes - 1.
    expect(layout.edges).toHaveLength(5);
    expect(layout.maxDepth).toBe(2);
  });
});
