import { describe, expect, it } from "vitest";
import { RADIO_STATIONS } from "../lib/radioStations";

// #682 — the curated station table. These are SHAPE invariants, and each one
// exists because breaking it fails SILENTLY in production rather than loudly
// here.
//
// What this file deliberately does NOT assert: that a stream is reachable.
// That needs the network, and a unit test that hits somafm.com would be a
// third-party outage detector wired into our gate. Reachability was measured
// by hand when each entry was added (see the module header for the date and
// the method) and is re-measured when the list changes — it is not something
// a test run in CI can honestly stand behind.

describe("RADIO_STATIONS", () => {
  it("is not empty — an empty table is a picker that opens onto nothing", () => {
    expect(RADIO_STATIONS.length).toBeGreaterThan(0);
  });

  it("has a unique id per station", () => {
    // Ids key the rendered list. A duplicate makes one of the two stations
    // unreachable in the picker without any error anywhere.
    const ids = RADIO_STATIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names every station — the title is what the transport shows", () => {
    // The docked player captions playback with this string; on mobile it is
    // the only surface naming the station. An empty one is an anonymous bar.
    for (const s of RADIO_STATIONS) {
      expect(s.title.trim(), `station ${s.id} has no title`).not.toBe("");
    }
  });

  it("serves every stream and logo over https", () => {
    // The CSP tokens that admit these (`media-src https:`, `img-src https:`)
    // are scheme-scoped, and an http subresource on an https page is refused
    // as mixed content regardless. Either way the failure is a station that
    // silently does not play.
    for (const s of RADIO_STATIONS) {
      expect(s.streamUrl, `station ${s.id} stream`).toMatch(/^https:\/\//);
      expect(s.logoUrl, `station ${s.id} logo`).toMatch(/^https:\/\//);
    }
  });

  it("uses SomaFM's stable front door, never a numbered pool host", () => {
    // Measured 2026-08-23: a channel's `.pls` lists three ROTATING hosts
    // (ice2 / ice5 / ice6) while the unnumbered `ice.somafm.com` answers for
    // all of them. Copying a URL straight out of a `.pls` — the obvious way
    // to add a station — pins one pool member and rots when the pool moves.
    // Scoped to somafm hosts on purpose: this table is allowed to hold a
    // station from another provider, and must not be pinned to one vendor.
    for (const s of RADIO_STATIONS) {
      const host = new URL(s.streamUrl).host;
      if (!host.endsWith("somafm.com")) continue;
      expect(host, `station ${s.id} pins a rotating pool host`).toBe("ice.somafm.com");
    }
  });
});
