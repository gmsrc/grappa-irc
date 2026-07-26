// #274 — deterministic rasterizer for the cicchetto PWA icon set.
//
// SINGLE SOURCE: `public/icon.svg`. This script derives every raster
// surface from it so a mark change is one file edit + one re-run:
//
//   public/icon.svg  (the ONLY hand-authored artifact)
//        │
//        ├── icon-192.png            192  purpose:any       (full-bleed)
//        ├── icon-512.png            512  purpose:any       (full-bleed)
//        ├── icon-192-maskable.png   192  purpose:maskable  (80% safe zone)
//        ├── icon-512-maskable.png   512  purpose:maskable  (80% safe zone)
//        ├── apple-touch-icon.png    180  iOS home screen   (opaque, no maskable)
//        └── favicon.ico             16/32/48 packed        (legacy tab)
//
// The `any` PNGs render the SVG edge-to-edge. The `maskable` PNGs render it
// into the central 80% of an opaque canvas so Android's circle/squircle
// crop can never clip the glyph (W3C maskable safe zone). apple-touch is
// full-bleed on the SVG's own opaque bg (iOS rounds corners itself and has
// no maskable/transparency support). The .ico embeds PNG payloads (Vista+).
//
// WHY headless Chrome and not a node SVG lib: the browser is the one
// renderer whose SVG output matches what the PWA actually paints, and it is
// already available to the worker over CDP. This runs on the HOST (Node 22+
// for the global WebSocket/fetch), NOT in the bun container — the container
// could not see the host's Chrome. CI never runs this; it consumes the
// committed PNGs. Regenerate with:
//
//   node cicchetto/scripts/gen-pwa-icons.mjs          # CDP at localhost:9222
//   CDP_URL=http://host.docker.internal:9222 node ... # from a container
//
// Idempotent: same icon.svg → byte-stable PNGs (deviceScaleFactor 1, exact
// clip). Exits non-zero with a clear message if the CDP endpoint is absent —
// the worker stops and reports rather than silently skipping the pixels.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");
const CDP_URL = process.env.CDP_URL ?? "http://localhost:9222";

const SVG = readFileSync(join(PUBLIC, "icon.svg"), "utf8");

// The maskable safe-zone fraction: the glyph lives in the central 80% of the
// canvas, matching the W3C maskable spec's guaranteed-visible circle.
const SAFE = 0.8;

// Full-bleed page: the SVG fills the whole NxN viewport, its own opaque bg
// reaching every edge. Used for `any`, apple-touch, and the favicon sizes.
const pageFullBleed = (n) =>
  `<!doctype html><meta charset="utf-8">` +
  `<style>html,body{margin:0;padding:0;background:#0a0a0a}` +
  `.wrap{width:${n}px;height:${n}px}.wrap>svg{display:block;width:100%;height:100%}</style>` +
  `<div class="wrap">${SVG}</div>`;

// Maskable page: opaque bg edge-to-edge, the SVG shrunk into the central
// SAFE box so the platform crop cannot clip the glyph.
const pageMaskable = (n) => {
  const inner = Math.round(n * SAFE);
  return (
    `<!doctype html><meta charset="utf-8">` +
    `<style>html,body{margin:0;padding:0}` +
    `.pad{width:${n}px;height:${n}px;background:#0a0a0a;` +
    `display:flex;align-items:center;justify-content:center}` +
    `.box{width:${inner}px;height:${inner}px}.box>svg{display:block;width:100%;height:100%}</style>` +
    `<div class="pad"><div class="box">${SVG}</div></div>`
  );
};

// --- Minimal CDP client over the raw DevTools WebSocket -----------------

async function cdpTarget() {
  let version;
  try {
    version = await fetch(`${CDP_URL}/json/version`).then((r) => r.json());
  } catch (err) {
    throw new Error(
      `CDP endpoint unreachable at ${CDP_URL} (${err.message}). ` +
        `Start Chrome with --remote-debugging-port=9222, or set CDP_URL. ` +
        `The worker does NOT generate the pixels elsewhere — report this.`,
    );
  }
  console.error(`CDP: ${version.Browser}`);
  // Open a dedicated blank tab so we never disturb the operator's session.
  const target = await fetch(`${CDP_URL}/json/new?about:blank`, {
    method: "PUT",
  }).then((r) => r.json());
  return target;
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", (e) =>
      reject(new Error(`CDP websocket error: ${e.message ?? e}`)),
    );
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.method}: ${msg.error.message}`));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  return { ready, send, close: () => ws.close() };
}

// Render one HTML page at exactly n×n and return the PNG bytes (dsf=1).
async function shot(cdp, html, n) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: n,
    height: n,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  await cdp.send("Page.navigate", { url: dataUrl });
  // Inline SVG has no external resources; a microtask yield is enough for
  // the layout to settle before we clip.
  await new Promise((r) => setTimeout(r, 60));
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width: n, height: n, scale: 1 },
    captureBeyondViewport: true,
  });
  return Buffer.from(data, "base64");
}

// --- ICO container: pack PNG payloads (Vista+ PNG-in-ICO) ---------------

function buildIco(pngs) {
  // pngs: [{ size, bytes }]. Header + one 16-byte dir entry each + payloads.
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, bytes } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 means 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // color count (0 = truecolor)
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(bytes.length, 8); // bytes in resource
    e.writeUInt32LE(offset, 12); // offset from file start
    offset += bytes.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.bytes)]);
}

// --- Orchestrate --------------------------------------------------------

async function main() {
  const target = await cdpTarget();
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");

  const write = (name, bytes) => {
    writeFileSync(join(PUBLIC, name), bytes);
    console.error(`  wrote ${name} (${bytes.length} bytes)`);
  };

  try {
    // any (full-bleed)
    write("icon-192.png", await shot(cdp, pageFullBleed(192), 192));
    write("icon-512.png", await shot(cdp, pageFullBleed(512), 512));
    // maskable (safe zone)
    write("icon-192-maskable.png", await shot(cdp, pageMaskable(192), 192));
    write("icon-512-maskable.png", await shot(cdp, pageMaskable(512), 512));
    // iOS home screen
    write("apple-touch-icon.png", await shot(cdp, pageFullBleed(180), 180));
    // favicon.ico from 16/32/48
    const icoSizes = [16, 32, 48];
    const pngs = [];
    for (const size of icoSizes) {
      pngs.push({ size, bytes: await shot(cdp, pageFullBleed(size), size) });
    }
    write("favicon.ico", buildIco(pngs));
  } finally {
    cdp.close();
    await fetch(`${CDP_URL}/json/close/${target.id}`).catch(() => {});
  }
  console.error("done.");
}

main().catch((err) => {
  console.error(`\ngen-pwa-icons FAILED: ${err.message}`);
  process.exit(1);
});
