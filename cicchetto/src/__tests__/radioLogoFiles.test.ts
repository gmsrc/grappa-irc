import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { vendoredPath } from "../../scripts/sync-radio-logos-core";
import { RADIO_LOGO_DIR, RADIO_LOGO_PATHS } from "../lib/radioLogoPaths";
import { radioLogoPlaceholderSvg } from "../lib/radioLogoPlaceholder";
import { RADIO_STATIONS } from "../lib/radioStations";

// #1739 — the gate behind the VENDORED station logos, and the reason it is a
// vitest rather than the `check:radio` probe next door.
//
// WHAT CHANGED AND WHY THE GATE MOVED WITH IT. The picker used to draw
// `<img src={station.logoUrl}>`, i.e. every viewer fetched 21 images straight
// from `api.somafm.com` — a third party learning an IP and a user agent every
// time the drawer painted. #1739 vendors the bytes instead: the render reads
// `RADIO_LOGO_PATHS[id]` and the browser never leaves our origin. The whole
// point is that nothing about drawing a logo touches the network any more, so
// the gate that keeps it honest must not either.
//
// This file is therefore OFFLINE by construction — no fetch, no catalogue, no
// somafm — and it runs in `bun run test` like everything else. Its upstream
// twin `bun run check:radio` keeps the on-demand axes that DO need the network
// (REACH / AGREE / FEED, plus #1739's BYTES), and stays out of CI for the
// reason its own header gives.
//
// FOUR CLAIMS, and each one is a way the mirror can rot while every other
// gate stays green:
//
//   COVERED   — every station in the table has an entry in the generated map.
//               Without it a new row renders no `src` at all: the map is a
//               `Record<string, string>` and the miss is `undefined`, which an
//               `<img>` accepts silently. That silence is what this asserts
//               away, and it is why the render site is allowed to carry no
//               fallback branch.
//   PRESENT   — every entry names a file that exists and is non-empty. A
//               committed map plus a `.gitignore`d directory would pass
//               COVERED and serve nothing.
//   NAMED     — the vendored extension is the one the upstream URL spells (or
//               `.svg` for a station that publishes no logo). `mediaSession`
//               derives the artwork MIME type from that extension, so a
//               `.png` holding JPEG bytes hands the OS lock screen a lie.
//   NO ORPHAN — no file in the directory that no station claims. A station
//               deleted from the table leaves 46 KB in git forever otherwise,
//               and nothing else in the tree would ever mention it again.
//
// Plus the one that is not about files at all:
//
//   FRESH     — a logo-less station's vendored SVG is byte-identical to what
//               `radioLogoPlaceholderSvg` produces TODAY. The sync script
//               calls that generator (one implementation, reused rather than
//               ported), so editing the generator without re-running the sync
//               leaves a stale tile on disk that no other test can see: the
//               unit tests measure the FUNCTION, and the picker draws the
//               FILE. This is the only place those two are compared.
//
// And a vacuity control, for the reason `isCatalogueBacked` is exported next
// door: NAMED and FRESH each cover one arm of `logoUrl`'s nullability, so a
// table that lost either arm would run them over nothing and report green.

/** `cicchetto/`, which is what vitest runs in — the convention the other
    filesystem tests here already use (`biomePin`, `moduleRootGuard`). */
const CIC_ROOT = process.cwd();

/** A web path (`/radio-logos/x.png`) resolved to where vite copies it from. */
const onDisk = (webPath: string): string => resolve(CIC_ROOT, "public", webPath.replace(/^\//, ""));

describe("the vendored radio logos (#1739)", () => {
  it("has one arm of each kind in the table, so the checks below are not vacuous", () => {
    // NAMED and FRESH split on `logoUrl === null`. If the table ever held only
    // one kind, the other's loop would iterate zero times and pass.
    expect(RADIO_STATIONS.filter((s) => s.logoUrl !== null).length).toBeGreaterThan(0);
    expect(RADIO_STATIONS.filter((s) => s.logoUrl === null).length).toBeGreaterThan(0);
  });

  it("COVERED — every station has a vendored path", () => {
    const missing = RADIO_STATIONS.filter((s) => RADIO_LOGO_PATHS[s.id] === undefined).map(
      (s) => s.id,
    );
    expect(missing, "run `bun run sync:radio-logos`").toEqual([]);
  });

  it("PRESENT — every vendored path names a non-empty file", () => {
    for (const station of RADIO_STATIONS) {
      const path = RADIO_LOGO_PATHS[station.id];
      expect(path, `station ${station.id} has no vendored path`).toBeDefined();
      if (path === undefined) continue;
      const file = onDisk(path);
      expect(
        statSync(file, { throwIfNoEntry: false })?.size ?? 0,
        `${path} is missing or empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("NAMED — the committed map is what the sync's own naming rule produces", () => {
    // Through `vendoredPath`, the function the script writes with, rather than
    // a second copy of the rule: a gate holding its own spelling would go
    // green on a mirror that disagrees with the script that filled it. What
    // this catches is DRIFT — a table row whose `logoUrl` changed type, or an
    // id renamed, with the map left as it was.
    for (const station of RADIO_STATIONS) {
      expect(RADIO_LOGO_PATHS[station.id], `station ${station.id}`).toBe(
        vendoredPath(station.id, station.logoUrl),
      );
    }
  });

  it("NO ORPHAN — every file in the directory belongs to a station", () => {
    const claimed = new Set(
      RADIO_STATIONS.map((s) => RADIO_LOGO_PATHS[s.id]).filter((p): p is string => p !== undefined),
    );
    const present = readdirSync(onDisk(RADIO_LOGO_DIR)).map((name) => `${RADIO_LOGO_DIR}/${name}`);
    const orphans = present.filter((p) => !claimed.has(p));
    expect(orphans, "delete these, or re-add the station that owned them").toEqual([]);
  });

  it("FRESH — a logo-less station's tile is what the generator produces today", () => {
    // Byte-for-byte against the PRODUCTION generator, not a copy of its
    // output: the sync script writes exactly this, so a divergence means the
    // module moved and the mirror did not.
    for (const station of RADIO_STATIONS.filter((s) => s.logoUrl === null)) {
      const path = RADIO_LOGO_PATHS[station.id];
      expect(path, `station ${station.id} has no vendored path`).toBeDefined();
      if (path === undefined) continue;
      expect(readFileSync(onDisk(path), "utf8"), `${path} is stale — re-run the sync`).toBe(
        radioLogoPlaceholderSvg(station.id, station.title),
      );
    }
  });
});
