import { describe, expect, it } from "vitest";
import {
  agreeFailure,
  brokenCount,
  catalogueLogos,
  isCatalogueBacked,
  problems,
  reachFailure,
  type StationFinding,
  versionless,
} from "../../scripts/check-radio-logos-core";
import { RADIO_STATIONS } from "../lib/radioStations";

// #1696 — the rules behind `bun run check:radio`.
//
// This file is doing two jobs, and the second is the one worth stating.
//
// (1) Every case is two-sided, the `lockDrift.test.ts` posture: a rule is worth
//     something only if the red side reddens AND the green side stays green
//     under the same comparator, so a mutation that disables the check cannot
//     pass by making everything one colour.
//
// (2) Importing the core from `src` is what puts `cicchetto/scripts/` under
//     `tsc --noEmit` at all. That directory is outside the tsconfig `include`
//     and outside biome's `files.includes`, so a runner-only module is checked
//     by nothing — and the first draft of this probe shipped a real
//     `noUncheckedIndexedAccess` violation in its `?v=` strip because of it.
//     Deleting this import would silently return the probe to unchecked.

const CATALOGUE = new Map([
  ["dronezone", "https://api.somafm.com/logos/120/dronezone120.jpg"],
  ["groovesalad", "https://api.somafm.com/logos/120/groovesalad120.png"],
]);

const finding = (over: Partial<StationFinding>): StationFinding => ({
  id: "dronezone",
  logoUrl: "https://api.somafm.com/logos/120/dronezone120.jpg",
  reach: null,
  agree: null,
  ...over,
});

describe("versionless", () => {
  it("drops the ?v= cache-buster the catalogue spells", () => {
    // The table bakes the versionless path deliberately — a timestamp in a
    // stored URL rots on the next re-upload. Without the strip EVERY station
    // would read as a disagreement, which is a gate that cries wolf forever.
    expect(versionless("https://api.somafm.com/logos/120/lush120.jpg?v=1674955397")).toBe(
      "https://api.somafm.com/logos/120/lush120.jpg",
    );
  });

  it("leaves a URL that carries no query untouched", () => {
    const bare = "https://api.somafm.com/logos/120/lush120.jpg";
    expect(versionless(bare)).toBe(bare);
  });
});

describe("catalogueLogos", () => {
  it("indexes the catalogue by id with the buster stripped", () => {
    const map = catalogueLogos({
      channels: [{ id: "lush", image: "https://api.somafm.com/logos/120/lush120.jpg?v=167" }],
    });
    expect(map.get("lush")).toBe("https://api.somafm.com/logos/120/lush120.jpg");
  });

  it("drops a channel with no image rather than half-entering it", () => {
    // A half-entry would compare as agreement with an empty string. Absent is
    // the honest state: `agreeFailure` then reports "no channel", a finding.
    const map = catalogueLogos({ channels: [{ id: "lush" }, { image: "https://x/y.jpg" }] });
    expect(map.size).toBe(0);
  });

  it("survives a document with no channels key at all", () => {
    // Third-party JSON. A missing field must degrade to a finding downstream,
    // never to a crash that reads as an infrastructure problem.
    expect(catalogueLogos({}).size).toBe(0);
  });
});

describe("reachFailure", () => {
  it("passes a served image", () => {
    expect(reachFailure(200, "image/jpeg")).toBeNull();
  });

  it("fails a 404 and names the status", () => {
    expect(reachFailure(404, "text/html")).toBe("HTTP 404");
  });

  it("fails a 200 that is not an image — the soft 404 this host serves", () => {
    // The reason the axis checks content type at all: api.somafm.com answers
    // some paths with a 200-shaped `text/html` body, and a status-only assert
    // would wave exactly the failure this probe exists to catch straight
    // through.
    expect(reachFailure(200, "text/html")).toBe("HTTP 200 but content-type text/html");
  });

  it("fails a 200 with no content type rather than assuming one", () => {
    expect(reachFailure(200, null)).toBe("HTTP 200 but content-type (none)");
  });
});

describe("agreeFailure", () => {
  it("passes when the baked URL is what the catalogue publishes", () => {
    expect(
      agreeFailure("https://api.somafm.com/logos/120/dronezone120.jpg", "dronezone", CATALOGUE),
    ).toBeNull();
  });

  it("fails a stale extension and spells the URL to paste in", () => {
    // This is the #1696 bug itself, as the gate sees it.
    expect(
      agreeFailure("https://api.somafm.com/logos/120/dronezone120.png", "dronezone", CATALOGUE),
    ).toBe("catalogue ships https://api.somafm.com/logos/120/dronezone120.jpg");
  });

  it("fails a somafm URL with no catalogue row behind it", () => {
    // Not a skip: a somafm URL the catalogue does not back is precisely the
    // unverifiable claim the probe exists to kill.
    expect(agreeFailure("https://api.somafm.com/logos/120/ghost120.jpg", "ghost", CATALOGUE)).toBe(
      'points at somafm but the catalogue has no channel "ghost"',
    );
  });

  it("skips a station from another provider, which the table is allowed to hold", () => {
    expect(agreeFailure("https://example.org/logo.png", "elsewhere", CATALOGUE)).toBeNull();
  });
});

describe("the AGREE axis is not vacuous over the real table", () => {
  it("has something to say about every station in RADIO_STATIONS", () => {
    // The positive control, and the reason it is here: AGREE skips stations
    // pointing at another provider, so one inverted comparison skips them ALL
    // and `check:radio` reports "0 broken" having compared nothing. That green
    // means silence, and it is indistinguishable from the real one at the
    // summary line. Assert the axis actually engages.
    const backed = RADIO_STATIONS.filter((s) => isCatalogueBacked(s.logoUrl));
    expect(backed.length).toBe(RADIO_STATIONS.length);
    expect(backed.length).toBeGreaterThan(0);
  });

  it("flags the whole table against an empty catalogue", () => {
    // The other side of the same control: if the comparator can never fail,
    // the case above would still pass.
    const empty = new Map<string, string>();
    for (const s of RADIO_STATIONS) {
      expect(agreeFailure(s.logoUrl, s.id, empty), `station ${s.id}`).not.toBeNull();
    }
  });
});

describe("the union verdict", () => {
  it("reports both axes when both have something to say", () => {
    expect(problems(finding({ reach: "HTTP 404", agree: "catalogue ships x" }))).toEqual([
      "REACH HTTP 404",
      "AGREE catalogue ships x",
    ]);
  });

  it("counts a station broken on EITHER axis alone", () => {
    // The union is the point: a logo that resolves but is no longer the one
    // upstream publishes is broken even though REACH is happy, and vice versa.
    expect(brokenCount([finding({ reach: "HTTP 404" })])).toBe(1);
    expect(brokenCount([finding({ agree: "catalogue ships x" })])).toBe(1);
  });

  it("counts a clean station as unbroken", () => {
    expect(problems(finding({}))).toEqual([]);
    expect(brokenCount([finding({}), finding({ id: "lush" })])).toBe(0);
  });
});
