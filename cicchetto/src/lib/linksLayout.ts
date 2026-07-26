// #238 — LINKS topology layout. A PURE, DETERMINISTIC function turning the
// parsed 364/365 `links_bundle` entries (server + uplink + hopcount) into a
// positioned radial tidy-tree: nodes at polar coordinates, one edge per
// parent→child link.
//
// WHY a tree, not a force-directed graph: an IRC network is a SPANNING TREE by
// protocol (no loops). Each 364 carries the node's uplink (`linked_to`), so we
// reconstruct the real parent edges — the topology IS a hierarchy, and a
// deterministic radial layout renders it more readably than a force sim thrown
// at hierarchical data. Deterministic also means the layout is unit-testable
// and the e2e can assert exact node/edge counts from parsed numerics (a force
// sim's random jitter makes both impossible). Zero dependencies — this is
// plain geometry the house style prefers over a WebGL/d3 dep in the PWA.
//
// The layout is pure geometry only: depth colouring, node radii, hover state,
// zoom/pan all live in `LinksModal.tsx` (the display concerns).

import type { LinksEntry } from "./api";

export type LayoutNode = {
  server: string;
  description: string | null;
  // Hopcount as reported by the ircd (distance from the server grappa is
  // connected to). May differ from `depth` when the reply is partial/masked;
  // both are surfaced — `depth` drives geometry, `hopcount` is shown verbatim.
  hopcount: number | null;
  // Tree depth from the reconstructed root (root = 0). Drives the ring radius.
  depth: number;
  // Uplink server name (null only for the root). The parent EDGE key.
  parent: string | null;
  isRoot: boolean;
  angle: number;
  radius: number;
  x: number;
  y: number;
};

export type LayoutEdge = {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type Layout = {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  // Bounding box the SVG viewBox fits (origin at 0,0; the root sits at the
  // centre). Deterministic from maxDepth + ringGap + margin.
  width: number;
  height: number;
  maxDepth: number;
};

export type LayoutOpts = {
  // Radial distance between successive depth rings.
  ringGap: number;
  // Padding around the outermost ring so node glyphs + labels are not clipped.
  margin: number;
};

export const DEFAULT_LAYOUT_OPTS: LayoutOpts = { ringGap: 120, margin: 80 };

// Internal tree node built before geometry is assigned.
type TreeNode = {
  server: string;
  entry: LinksEntry;
  children: TreeNode[];
  depth: number;
  angle: number;
};

// Reconstruct the spanning tree from the flat entry list.
//
// Root selection (in priority order, all deterministic):
//   1. a self-linked node (`server === linked_to`) — the canonical ircd root;
//   2. else the node with the smallest hopcount;
//   3. else (empty hopcounts) the first entry.
// A node whose `linked_to` is absent from the set (a masked/partial reply)
// is re-parented to the root as an orphan, so no node is ever dropped. Cycles
// (a server listing itself or a mutual pair as uplinks) are broken by a
// visited-set during the depth walk — every node appears exactly once.
function buildTree(entries: LinksEntry[]): TreeNode | null {
  if (entries.length === 0) return null;

  // De-dupe by server name (last write wins — a repeated 364 is malformed but
  // must not fork the node). Keyed on the raw server string; IRC server names
  // are compared case-insensitively but the topology only needs identity here.
  const byServer = new Map<string, LinksEntry>();
  for (const e of entries) byServer.set(e.server, e);

  const rootEntry = selectRoot([...byServer.values()]);

  // Build children lists keyed by parent server. Deterministic child order:
  // sort by server name so the leaf-angle assignment is stable.
  const childrenOf = new Map<string, LinksEntry[]>();
  for (const e of byServer.values()) {
    if (e.server === rootEntry.server) continue;
    const parent =
      e.linked_to !== null && e.linked_to !== e.server && byServer.has(e.linked_to)
        ? e.linked_to
        : rootEntry.server; // orphan → attach to root
    const list = childrenOf.get(parent) ?? [];
    list.push(e);
    childrenOf.set(parent, list);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0));
  }

  const visited = new Set<string>();
  const build = (entry: LinksEntry, depth: number): TreeNode => {
    visited.add(entry.server);
    const kids = childrenOf.get(entry.server) ?? [];
    const children = kids
      .filter((k) => !visited.has(k.server)) // cycle break
      .map((k) => build(k, depth + 1));
    return { server: entry.server, entry, children, depth, angle: 0 };
  };

  return build(rootEntry, 0);
}

function selectRoot(entries: LinksEntry[]): LinksEntry {
  // buildTree only calls this on a de-duped, non-empty list — make that
  // contract explicit so the first-entry fallback is a real LinksEntry, not
  // `T | undefined` under noUncheckedIndexedAccess.
  const first = entries[0];
  if (first === undefined) throw new Error("selectRoot: empty entries (buildTree guards this)");

  const selfLinked = entries.find((e) => e.linked_to === e.server);
  if (selfLinked !== undefined) return selfLinked;

  let best: LinksEntry | undefined;
  for (const e of entries) {
    if (e.hopcount === null) continue;
    if (best === undefined || best.hopcount === null || e.hopcount < best.hopcount) best = e;
  }
  return best ?? first;
}

// Assign a radial angle to every node: leaves get an equal slice of the full
// circle in DFS order; each internal node sits at the mean of its children's
// angles (the polar Reingold–Tilford tidy-tree simplification). Returns the
// leaf count so callers know the angular granularity.
function assignAngles(root: TreeNode): void {
  const leaves: TreeNode[] = [];
  const collectLeaves = (n: TreeNode): void => {
    if (n.children.length === 0) leaves.push(n);
    else for (const c of n.children) collectLeaves(c);
  };
  collectLeaves(root);

  // A lone root (no children) sits at angle 0 (placed at centre anyway).
  const leafCount = Math.max(leaves.length, 1);
  leaves.forEach((leaf, i) => {
    leaf.angle = ((i + 0.5) / leafCount) * Math.PI * 2;
  });

  // Post-order: internal node angle = mean of its children's (already set).
  const setInternal = (n: TreeNode): number => {
    if (n.children.length === 0) return n.angle;
    const sum = n.children.reduce((acc, c) => acc + setInternal(c), 0);
    n.angle = sum / n.children.length;
    return n.angle;
  };
  setInternal(root);
}

// Public entry point: entries → fully positioned layout. Empty input yields an
// empty layout (the modal renders the "hidden topology" empty state instead).
export function radialLayout(entries: LinksEntry[], opts: LayoutOpts): Layout {
  const root = buildTree(entries);
  if (root === null) {
    return { nodes: [], edges: [], width: 0, height: 0, maxDepth: 0 };
  }

  assignAngles(root);

  let maxDepth = 0;
  const flat: TreeNode[] = [];
  const walk = (n: TreeNode): void => {
    flat.push(n);
    if (n.depth > maxDepth) maxDepth = n.depth;
    for (const c of n.children) walk(c);
  };
  walk(root);

  const outer = maxDepth * opts.ringGap + opts.margin;
  const cx = outer;
  const cy = outer;
  const size = outer * 2;

  const nodes: LayoutNode[] = flat.map((n) => {
    const radius = n.depth * opts.ringGap;
    // Root sits dead centre (radius 0); cos/sin of its angle is irrelevant.
    const x = cx + radius * Math.cos(n.angle);
    const y = cy + radius * Math.sin(n.angle);
    return {
      server: n.server,
      description: n.entry.description,
      hopcount: n.entry.hopcount,
      depth: n.depth,
      parent: n.depth === 0 ? null : n.entry.linked_to,
      isRoot: n.depth === 0,
      angle: n.angle,
      radius,
      x,
      y,
    };
  });

  const posByServer = new Map(nodes.map((n) => [n.server, n]));
  const edges: LayoutEdge[] = [];
  const addEdges = (n: TreeNode): void => {
    const from = posByServer.get(n.server);
    for (const c of n.children) {
      const to = posByServer.get(c.server);
      if (from !== undefined && to !== undefined) {
        edges.push({ from: n.server, to: c.server, x1: from.x, y1: from.y, x2: to.x, y2: to.y });
      }
      addEdges(c);
    }
  };
  addEdges(root);

  return { nodes, edges, width: size, height: size, maxDepth };
}
