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
  feedUrl: "https://api.somafm.com/songs/dronezone.json",
  reach: null,
  agree: null,
  feed: null,
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
    expect(reachFailure(200, "image/jpeg", "image/")).toBeNull();
  });

  it("fails a 404 and names the status", () => {
    expect(reachFailure(404, "text/html", "image/")).toBe("HTTP 404");
  });

  it("fails a 200 that is not an image — the soft 404 this host serves", () => {
    // The reason the axis checks content type at all: api.somafm.com answers
    // some paths with a 200-shaped `text/html` body, and a status-only assert
    // would wave exactly the failure this probe exists to catch straight
    // through.
    expect(reachFailure(200, "text/html", "image/")).toBe(
      "HTTP 200 but content-type text/html (wanted image/)",
    );
  });

  it("fails a 200 with no content type rather than assuming one", () => {
    expect(reachFailure(200, null, "image/")).toBe(
      "HTTP 200 but content-type (none) (wanted image/)",
    );
  });

  // #1698 — the expected type is a PARAMETER because a second kind of baked
  // URL now rides the same probe. Measured 2026-08-24: `HEAD` on
  // `api.somafm.com/songs/<id>.json` answers 200 `application/json`, and a
  // WRONG slug answers 404 `text/html` — so the same two-part rule (status
  // AND type) separates a live feed from a mistyped one.
  it("passes a served JSON feed", () => {
    expect(reachFailure(200, "application/json", "application/json")).toBeNull();
  });

  it("fails a JSON feed served as html, naming what was wanted", () => {
    // Without the `wanted` half the two axes would report the identical
    // sentence for opposite defects, and a reader could not tell which URL
    // was mistyped.
    expect(reachFailure(200, "text/html", "application/json")).toBe(
      "HTTP 200 but content-type text/html (wanted application/json)",
    );
  });

  it("does NOT accept an image where a feed was wanted", () => {
    // The two-sided half of parameterising the type: a probe that ignored its
    // `expected` argument would pass this, and both axes would collapse into
    // "any 200 with any body".
    expect(reachFailure(200, "image/png", "application/json")).not.toBeNull();
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
  // #1703 — these two used to assert the axis engages on EVERY row, which was
  // true only because every row was SomaFM. The first non-SomaFM station made
  // that reading false, and it was never the property worth holding: the
  // module's own header says the table "is allowed to hold" a station from
  // another provider, and the sibling case fifteen lines up asserts exactly
  // that such a row is SKIPPED. Totality and non-vacuity are different claims;
  // conflating them meant the control would have gone red for the table doing
  // the thing it was designed to do. What survives is the threat the control
  // was actually written against — an inverted predicate that skips everything
  // — plus a guard the old spelling did not have.
  const catalogueRows = (): readonly string[] =>
    // An INDEPENDENT spelling of "this logo is SomaFM's", deliberately not
    // reusing `isCatalogueBacked`: a control that asks the predicate to confirm
    // itself passes however the predicate is broken.
    RADIO_STATIONS.filter((s) => s.logoUrl.includes("//api.somafm.com/")).map((s) => s.id);

  it("engages on exactly the catalogue-backed stations, and there are some", () => {
    const backed = RADIO_STATIONS.filter((s) => isCatalogueBacked(s.logoUrl)).map((s) => s.id);
    // Non-vacuity: an inverted predicate skips every row and lands on zero.
    expect(backed.length).toBeGreaterThan(0);
    // Precision: a predicate wrong for SOME rows still clears the bar above.
    expect(backed).toEqual(catalogueRows());
  });

  it("flags every catalogue-backed station against an empty catalogue", () => {
    // The other side of the same control: if the comparator can never fail,
    // the case above would still pass. Scoped to the backed rows because a row
    // from another provider is correctly null here — that is the skip, not a
    // comparator that has gone quiet.
    const empty = new Map<string, string>();
    const backed = RADIO_STATIONS.filter((s) => isCatalogueBacked(s.logoUrl));
    expect(backed.length).toBeGreaterThan(0);
    for (const s of backed) {
      expect(agreeFailure(s.logoUrl, s.id, empty), `station ${s.id}`).not.toBeNull();
    }
  });
});

// #1698 — the FEED axis. `songsUrl` is a third baked third-party URL in the
// same table, and #1696's lesson is that a baked URL nothing can check is a
// claim, not a fact. Adding one without extending this probe would repeat the
// exact defect the probe exists for.
describe("the FEED axis is not vacuous over the real table", () => {
  it("has something to probe, on the stations that publish a feed", () => {
    // The positive control, the sibling of AGREE's above: FEED skips a station
    // whose `songsUrl` is null, so a table that lost the field would report
    // "0 broken" having probed nothing.
    //
    // #1703 — the second clause used to be `toBe(RADIO_STATIONS.length)`, i.e.
    // every row publishes a feed. That was an accident of the table being
    // all-SomaFM and it contradicted the field's own type: `songsUrl` is
    // nullable precisely because a track feed is a provider CAPABILITY, and
    // the first provider without one made the assertion red for a row that is
    // correctly spelled. Non-vacuity is the property worth holding here, and
    // `> 0` is the whole of it — a table that went uniformly null lands on
    // zero and this goes red, which is the threat the control names.
    const withFeed = RADIO_STATIONS.filter((s) => s.songsUrl !== null);
    expect(withFeed.length).toBeGreaterThan(0);
  });
});

describe("the union verdict", () => {
  it("reports every axis that has something to say", () => {
    expect(
      problems(finding({ reach: "HTTP 404", agree: "catalogue ships x", feed: "HTTP 500" })),
    ).toEqual(["REACH HTTP 404", "AGREE catalogue ships x", "FEED HTTP 500"]);
  });

  it("counts a station broken on EITHER axis alone", () => {
    // The union is the point: a logo that resolves but is no longer the one
    // upstream publishes is broken even though REACH is happy, and vice versa.
    expect(brokenCount([finding({ reach: "HTTP 404" })])).toBe(1);
    expect(brokenCount([finding({ agree: "catalogue ships x" })])).toBe(1);
    // #1698 — and on the feed alone: a station whose track feed 404s plays
    // fine and shows a permanently empty track line, which is precisely the
    // silent failure a checkable claim is supposed to convert into a red.
    expect(brokenCount([finding({ feed: "HTTP 404" })])).toBe(1);
  });

  it("counts a clean station as unbroken", () => {
    expect(problems(finding({}))).toEqual([]);
    expect(brokenCount([finding({}), finding({ id: "lush" })])).toBe(0);
  });

  it("says nothing about a station that publishes no feed", () => {
    // A null `songsUrl` is a station from a provider that has no track feed,
    // not a broken row. Reported as a finding it would make the table's own
    // nullable field permanently red.
    expect(problems(finding({ feedUrl: null, feed: null }))).toEqual([]);
  });
});
