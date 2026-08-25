#!/usr/bin/env bun
// #1739 — mirror every curated station's artwork into `public/radio-logos/`,
// so the picker draws it from OUR origin and no viewer ever contacts the
// station's host.
//
// WHY VENDOR RATHER THAN PROXY, which is what the issue's title proposed.
// vjt ruled B on 2026-08-25: no runtime fetch at all, and the fallback decided
// at BUILD time. The argument is `radioStations.ts`'s own, one level down —
// that file already refused to read the catalogue at render time ("a cosmetic
// pixel is a thin reason to put a third party in the render path", "when
// somafm is unreachable the picker still draws the logos it drew yesterday").
// A proxy would have reintroduced exactly that failure mode, merely relocated
// from the client to the server, where it is per-VIEWER rather than
// per-client-cache. Privacy — the strongest argument on the issue — is
// delivered identically by both. What this gives up, stated rather than
// discovered: it does not self-heal when a logo is re-uploaded upstream, which
// is why `check:radio` grew a BYTES axis in the same change.
//
// Accepted costs, on the record: ~260 KB of binaries in git, and a refresh
// that is a human verb instead of a TTL.
//
// ON DEMAND, never in CI. Same rule as `check-radio-logos.ts` next door and
// for the same reason: this fetches somafm.com, and a gate that does is a
// third-party outage detector bolted onto our build. What CI runs is the
// OFFLINE half — `src/__tests__/radioLogoFiles.test.ts`, which needs no
// network because the bytes are in the tree.
//
// THIS FILE IS THE IO HALF ONLY. Every rule lives in
// `sync-radio-logos-core.ts` so that it is reachable from `src` and therefore
// covered by `tsc --noEmit` and by the offline gate, which asserts the
// committed map against the PRODUCTION naming rule rather than a copy of it.
//
// ALL OR NOTHING on the generated map. If any station fails, the map is NOT
// rewritten and the run exits 1: a receipt for work that did not complete is
// worse than no receipt, because the offline gate would then report the
// mirror as covered. Bytes already fetched stay on disk — they are valid, and
// re-running is cheap.

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { radioLogoPlaceholderSvg } from "../src/lib/radioLogoPlaceholder";
import { RADIO_STATIONS } from "../src/lib/radioStations";
import {
  contentTypeFailure,
  extensionOf,
  orphans,
  pathsModule,
  RADIO_LOGO_DIR,
  type VendoredLogo,
  vendoredPath,
} from "./sync-radio-logos-core";

const TIMEOUT_MS = 30_000;

/** Resolved against THIS script, not the caller's cwd, so the mirror always
    lands in `cicchetto/public/radio-logos` wherever the verb is run from —
    the reason `gen-emoji.ts` gives for the same trick. */
const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const MIRROR_DIR = join(PUBLIC_DIR, RADIO_LOGO_DIR.replace(/^\//, ""));
const PATHS_MODULE = join(import.meta.dir, "..", "src", "lib", "radioLogoPaths.ts");

type Fetched = { readonly bytes: Uint8Array; readonly note: string };

/** The station's own artwork, or why it could not be mirrored.
 *
 * The content type is checked and not just the status because api.somafm.com
 * answers some paths with a 200-shaped `text/html` body — the soft 404
 * `check-radio-logos.ts` exists to catch. Here it matters twice over: the
 * extension we are about to STORE the bytes under is read back as a MIME type
 * by `mediaSession.ts`, so a mismatch would outlive this script. */
async function fetchLogo(url: string, extension: string): Promise<Fetched | string> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    return `${err}`;
  }
  if (!res.ok) return `HTTP ${res.status}`;
  const wrongType = contentTypeFailure(extension, res.headers.get("content-type"));
  if (wrongType !== null) return wrongType;
  const bytes = new Uint8Array(await res.arrayBuffer());
  // A zero-length 200 is a served resource by every status check and an empty
  // file by every reader. The gate would report it PRESENT-but-empty; catching
  // it here names the URL instead of the file.
  if (bytes.byteLength === 0) return "served 0 bytes";
  return { bytes, note: `${bytes.byteLength} bytes` };
}

mkdirSync(MIRROR_DIR, { recursive: true });

const logos: VendoredLogo[] = [];
const failures: string[] = [];
let vendoredBytes = 0;

for (const station of RADIO_STATIONS) {
  const extension = extensionOf(station.logoUrl);
  const path = vendoredPath(station.id, station.logoUrl);
  const file = join(PUBLIC_DIR, path.replace(/^\//, ""));

  // A station that publishes no artwork draws our own tile — CALLED here, not
  // reproduced. `lib/radioLogoPlaceholder.ts` is the one implementation, and
  // `radioLogoFiles.test.ts` compares the file it writes against that function
  // so the mirror cannot go stale behind an edit to it.
  const got: Fetched | string =
    station.logoUrl === null
      ? {
          bytes: new TextEncoder().encode(radioLogoPlaceholderSvg(station.id, station.title)),
          note: "generated placeholder",
        }
      : await fetchLogo(station.logoUrl, extension);

  if (typeof got === "string") {
    failures.push(`${station.id}: ${got}`);
    console.log(`  FAIL  ${station.id.padEnd(20)}${got}`);
    continue;
  }

  await Bun.write(file, got.bytes);
  vendoredBytes += got.bytes.byteLength;
  logos.push({ id: station.id, path });
  console.log(`  ok    ${station.id.padEnd(20)}${path} (${got.note})`);
}

// Prune before the map is written: the map is the receipt for what the mirror
// holds, and a directory carrying a station deleted from the table has bytes
// nothing in the tree names any more.
const claimed = new Set(logos.map((l) => l.path));
const present = readdirSync(MIRROR_DIR).map((name) => `${RADIO_LOGO_DIR}/${name}`);
for (const orphan of orphans(present, claimed)) {
  // Only ever with a clean run behind it: with failures in hand, a station
  // whose fetch died this time is not claimed and would be deleted for it.
  if (failures.length > 0) {
    console.log(`  keep  ${orphan} — unclaimed, but this run had failures`);
    continue;
  }
  rmSync(join(PUBLIC_DIR, orphan.replace(/^\//, "")));
  console.log(`  gone  ${orphan} — no station claims it`);
}

console.log(
  `\nsync:radio-logos — ${logos.length}/${RADIO_STATIONS.length} stations mirrored, ` +
    `${vendoredBytes} bytes, ${failures.length} failed`,
);

if (failures.length > 0) {
  console.error(
    "\nthe generated map was NOT rewritten — a receipt for a partial run would read as a complete mirror.",
  );
  process.exit(1);
}

await Bun.write(PATHS_MODULE, pathsModule(logos));
console.log(`wrote ${PATHS_MODULE}`);

// The artefact lands under `src/**`, which biome formats and lints, so a
// generated file that disagrees with the formatter turns `bun run check` red
// on a file no human typed. Formatting it here is cheaper than encoding
// biome's style in the emitter and hoping the two stay married.
const formatted = Bun.spawn(["biome", "check", "--write", PATHS_MODULE], {
  stdout: "inherit",
  stderr: "inherit",
});
await formatted.exited;
if ((formatted.exitCode ?? 1) !== 0) {
  console.error("biome could not format the generated map");
  process.exit(1);
}
