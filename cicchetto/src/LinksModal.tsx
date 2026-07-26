import { type Component, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { DEFAULT_LAYOUT_OPTS, type LayoutNode, radialLayout } from "./lib/linksLayout";
import { dismissLinksModal, linksModalBySlug } from "./lib/linksModal";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { selectedChannel } from "./lib/selection";
import { MircBody } from "./MircText";

// #238 — /links topology visualizer. A covering modal (mirrors WhoModal /
// NamesModal scaffolding: backdrop + role=dialog + overlay-lock + Esc) whose
// body renders the parsed 364/365 `links_bundle` as an INTERACTIVE radial
// tidy-tree of the IRC server mesh.
//
// WHY a hand-rolled SVG tree and not a graph library: an IRC network is a
// spanning TREE by protocol; each 364 carries the node's uplink, so the
// topology is a hierarchy, laid out DETERMINISTICALLY by `radialLayout`
// (`lib/linksLayout.ts`) — no WebGL/d3 dependency in the PWA, and the
// geometry is unit-testable + e2e-assertable (a force sim's jitter is
// neither). Nodes are coloured by tree depth; the root sits at centre; each
// ring is one hop out. Pan (pointer drag), zoom (wheel + pinch + buttons),
// and node select (tap/click → detail footer) make it legible on desktop AND
// device. An EMPTY topology (a restricted/oper-only network that answered a
// bare 365 with no 364 rows) renders the "this network hides its topology"
// empty state.
//
// Reads the topology for the CURRENTLY-ACTIVE network
// (`selectedChannel()?.networkSlug`) from the per-slug `linksModalBySlug`
// store. Ephemeral — dismissing drops the store entry (× / Esc / backdrop).

const MIN_SCALE = 0.25;
const MAX_SCALE = 6;
// Above this node count, per-node labels are shown only for the root + the
// hovered/selected node (avoids an unreadable label pile-up on large nets like
// Libera). Pan+zoom + tap-to-inspect cover the rest.
const LABEL_ALL_THRESHOLD = 22;

// Depth → hue ramp (teal root → violet leaves). Display-only; the layout is
// pure geometry. cic owns all colour/label strings (no server display text).
const depthColor = (depth: number, maxDepth: number): string => {
  const t = maxDepth === 0 ? 0 : depth / maxDepth;
  const hue = 190 + t * 160; // 190 (teal) → 350 (magenta)
  return `hsl(${hue} 68% 58%)`;
};

// Short label: the leftmost DNS label of the server name (irc.azzurra.org →
// "irc"), which reads better in the dense tree. The full name + description
// live in the detail footer on select/hover.
const shortLabel = (server: string): string => {
  const dot = server.indexOf(".");
  return dot === -1 ? server : server.slice(0, dot);
};

const LinksModal: Component = () => {
  const activeSlug = (): string | undefined => selectedChannel()?.networkSlug;
  const bundle = () => {
    const slug = activeSlug();
    return slug === undefined ? undefined : linksModalBySlug()[slug];
  };

  const close = (): void => {
    const slug = activeSlug();
    if (slug !== undefined) dismissLinksModal(slug);
  };

  // Refcounted overlay scroll-lock — same wiring as WhoModal. The scroller is
  // `.links-modal-body` (header + footer pinned). Esc routes through the shared
  // topmost-first overlay stack.
  createOverlayLock(() => bundle() !== undefined, ".links-modal-body", close);

  // Pan/zoom transform state (viewBox units). translate(tx ty) scale(k) on the
  // inner <g>; translate is in viewBox space so it is scale-independent.
  const [tx, setTx] = createSignal(0);
  const [ty, setTy] = createSignal(0);
  const [k, setK] = createSignal(1);
  const [selected, setSelected] = createSignal<LayoutNode | null>(null);
  const [hovered, setHovered] = createSignal<string | null>(null);

  let svgEl: SVGSVGElement | undefined;
  // Active pointers for drag-pan + two-finger pinch.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;

  const resetView = (): void => {
    setTx(0);
    setTy(0);
    setK(1);
    setSelected(null);
  };

  // Client px → viewBox units (the SVG auto-fits its viewBox to its client
  // box; preserveAspectRatio keeps x/y scales equal, so width ratio suffices).
  const vbPerPx = (vbWidth: number): number => {
    const w = svgEl?.clientWidth ?? 0;
    return w === 0 ? 1 : vbWidth / w;
  };

  // Zoom around a fixed viewBox point (keeps that point under the cursor/pinch
  // centre). worldPoint = (vbPoint - t)/k is invariant across the zoom.
  const zoomAround = (vbx: number, vby: number, factor: number): void => {
    const oldK = k();
    const newK = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldK * factor));
    if (newK === oldK) return;
    setTx(vbx - (newK / oldK) * (vbx - tx()));
    setTy(vby - (newK / oldK) * (vby - ty()));
    setK(newK);
  };

  const onWheel = (e: WheelEvent, vbWidth: number, vbHeight: number): void => {
    e.preventDefault();
    if (svgEl === undefined) return;
    const rect = svgEl.getBoundingClientRect();
    const vbx = (e.clientX - rect.left) * vbPerPx(vbWidth);
    const vby = (e.clientY - rect.top) * (vbHeight / (svgEl.clientHeight || 1));
    zoomAround(vbx, vby, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  };

  const onPointerDown = (e: PointerEvent): void => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      if (a !== undefined && b !== undefined) pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  const onPointerMove = (e: PointerEvent, vbWidth: number, vbHeight: number): void => {
    const prev = pointers.get(e.pointerId);
    if (prev === undefined) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);

    if (pointers.size >= 2) {
      // Pinch-zoom around the two-pointer midpoint.
      const [a, b] = [...pointers.values()];
      if (a === undefined || b === undefined) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && svgEl !== undefined) {
        const rect = svgEl.getBoundingClientRect();
        const midX = ((a.x + b.x) / 2 - rect.left) * vbPerPx(vbWidth);
        const midY = ((a.y + b.y) / 2 - rect.top) * (vbHeight / (svgEl.clientHeight || 1));
        zoomAround(midX, midY, dist / pinchDist);
      }
      pinchDist = dist;
      return;
    }

    // Single-pointer drag → pan (viewBox units; translate is scale-independent).
    const factor = vbPerPx(vbWidth);
    setTx(tx() + (cur.x - prev.x) * factor);
    setTy(ty() + (cur.y - prev.y) * factor);
  };

  const onPointerUp = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
  };

  // Belt-and-braces: never leak captured pointers if the modal unmounts mid-drag.
  onCleanup(() => pointers.clear());

  return (
    <Show when={bundle()} keyed>
      {(b) => {
        const layout = createMemo(() => radialLayout(b.entries, DEFAULT_LAYOUT_OPTS));
        const nodeCount = (): number => b.entries.length;
        const showAllLabels = (): boolean => nodeCount() <= LABEL_ALL_THRESHOLD;
        const detail = (): LayoutNode | null => {
          const sel = selected();
          if (sel !== null) return sel;
          const hov = hovered();
          if (hov === null) return null;
          return layout().nodes.find((n) => n.server === hov) ?? null;
        };

        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc via the shared overlay stack (keybindings → runTopmostOverlayEscape)
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim
          <div class="links-modal-backdrop" onClick={close}>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: inner dialog onClick only stops backdrop-click propagation; Esc closes via the shared overlay stack */}
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="links-modal-title"
              class="links-modal"
              data-testid="links-modal"
              onClick={(e) => e.stopPropagation()}
              tabIndex={-1}
            >
              <header class="links-modal-header">
                <h2 id="links-modal-title">
                  network map — {nodeCount()} {nodeCount() === 1 ? "server" : "servers"}
                </h2>
                <div class="links-modal-controls">
                  <button
                    type="button"
                    class="links-modal-zoom"
                    aria-label="zoom out"
                    onClick={() => zoomAround(layout().width / 2, layout().height / 2, 1 / 1.3)}
                  >
                    −
                  </button>
                  <button
                    type="button"
                    class="links-modal-zoom"
                    aria-label="reset view"
                    onClick={resetView}
                  >
                    ⊙
                  </button>
                  <button
                    type="button"
                    class="links-modal-zoom"
                    aria-label="zoom in"
                    onClick={() => zoomAround(layout().width / 2, layout().height / 2, 1.3)}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    class="links-modal-close"
                    aria-label="close links"
                    onClick={close}
                  >
                    ×
                  </button>
                </div>
              </header>

              <div class="links-modal-body">
                <Show
                  when={nodeCount() > 0}
                  fallback={
                    <div class="links-modal-empty" data-testid="links-modal-empty">
                      <p>this network hides its topology</p>
                      <p class="links-modal-empty-sub">
                        LINKS returned no servers — many networks restrict it to operators.
                      </p>
                    </div>
                  }
                >
                  <svg
                    ref={svgEl}
                    class="links-modal-svg"
                    data-testid="links-modal-svg"
                    viewBox={`0 0 ${layout().width} ${layout().height}`}
                    preserveAspectRatio="xMidYMid meet"
                    role="img"
                    aria-label={`network topology, ${nodeCount()} servers`}
                    onWheel={(e) => onWheel(e, layout().width, layout().height)}
                    onPointerDown={onPointerDown}
                    onPointerMove={(e) => onPointerMove(e, layout().width, layout().height)}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                  >
                    <g transform={`translate(${tx()} ${ty()}) scale(${k()})`}>
                      <g class="links-modal-edges">
                        <For each={layout().edges}>
                          {(edge) => (
                            <line
                              class="links-modal-edge"
                              x1={edge.x1}
                              y1={edge.y1}
                              x2={edge.x2}
                              y2={edge.y2}
                            />
                          )}
                        </For>
                      </g>
                      <g class="links-modal-nodes">
                        <For each={layout().nodes}>
                          {(node) => {
                            const isActive = (): boolean =>
                              selected()?.server === node.server || hovered() === node.server;
                            const labelled = (): boolean =>
                              node.isRoot || showAllLabels() || isActive();
                            return (
                              // biome-ignore lint/a11y/noStaticElementInteractions: SVG node glyph is a pointer-first inspect target (tap/hover), not a control; keyboard nav is a documented INC-3 follow-up
                              <g
                                class="links-modal-node"
                                classList={{
                                  "links-modal-node-root": node.isRoot,
                                  "links-modal-node-active": isActive(),
                                }}
                                transform={`translate(${node.x} ${node.y})`}
                                data-testid="links-modal-node"
                                data-server={node.server}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelected((cur) => (cur?.server === node.server ? null : node));
                                }}
                                onPointerEnter={() => setHovered(node.server)}
                                onPointerLeave={() =>
                                  setHovered((cur) => (cur === node.server ? null : cur))
                                }
                              >
                                <title>
                                  {node.server}
                                  {node.hopcount !== null ? ` (${node.hopcount} hops)` : ""}
                                </title>
                                <circle
                                  class="links-modal-dot"
                                  r={node.isRoot ? 11 : 7}
                                  style={{ fill: depthColor(node.depth, layout().maxDepth) }}
                                />
                                <Show when={labelled()}>
                                  <text class="links-modal-label" x={node.isRoot ? 0 : 11} y={-11}>
                                    {shortLabel(node.server)}
                                  </text>
                                </Show>
                              </g>
                            );
                          }}
                        </For>
                      </g>
                    </g>
                  </svg>
                </Show>
              </div>

              <footer class="links-modal-footer">
                <Show
                  when={detail()}
                  fallback={
                    <span class="links-modal-hint">
                      {nodeCount() > 0
                        ? "drag to pan · scroll or pinch to zoom · tap a server for detail"
                        : "End of /LINKS list"}
                    </span>
                  }
                >
                  {(d) => (
                    <div class="links-modal-detail" data-testid="links-modal-detail">
                      <span class="links-modal-detail-name">{d().server}</span>
                      <Show when={d().hopcount !== null}>
                        <span class="links-modal-detail-hops">{d().hopcount} hops</span>
                      </Show>
                      <Show when={d().parent !== null}>
                        <span class="links-modal-detail-uplink">↑ {d().parent}</span>
                      </Show>
                      <Show when={d().description}>
                        <span class="links-modal-detail-desc">
                          <MircBody body={d().description ?? ""} />
                        </span>
                      </Show>
                    </div>
                  )}
                </Show>
              </footer>
            </div>
          </div>
        );
      }}
    </Show>
  );
};

export default LinksModal;
