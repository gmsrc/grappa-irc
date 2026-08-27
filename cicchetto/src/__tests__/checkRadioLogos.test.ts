import { describe, expect, it } from "vitest";
import {
  agreeFailure,
  bitrateFailure,
  brokenCount,
  bytesFailure,
  catalogueLogos,
  codecFailure,
  identifyCodec,
  isCatalogueBacked,
  parseIcyBitrate,
  probedCounts,
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
  streamUrl: "https://ice.somafm.com/dronezone-128-mp3",
  reach: null,
  agree: null,
  feed: null,
  bytes: null,
  stream: null,
  codec: null,
  bitrate: null,
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
    // #1704 — `?? ""` rather than a filter on non-null: a row with NO logo is
    // not catalogue-backed, and spelling that as an empty string keeps this an
    // independent re-derivation of the predicate instead of borrowing its
    // null-handling too.
    RADIO_STATIONS.filter((s) => (s.logoUrl ?? "").includes("//api.somafm.com/")).map((s) => s.id);

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

// #1698 — the FEED axis. `nowPlayingSource` is a third baked third-party URL
// in the
// same table, and #1696's lesson is that a baked URL nothing can check is a
// claim, not a fact. Adding one without extending this probe would repeat the
// exact defect the probe exists for.
describe("the FEED axis is not vacuous over the real table", () => {
  it("has something to probe, on the stations that publish a feed", () => {
    // The positive control, the sibling of AGREE's above: FEED skips a station
    // whose `nowPlayingSource` is null, so a table that lost the field would report
    // "0 broken" having probed nothing.
    //
    // #1703 — the second clause used to be `toBe(RADIO_STATIONS.length)`, i.e.
    // every row publishes a feed. That was an accident of the table being
    // all-SomaFM and it contradicted the field's own type: `nowPlayingSource` is
    // nullable precisely because a track feed is a provider CAPABILITY, and
    // the first provider without one made the assertion red for a row that is
    // correctly spelled. Non-vacuity is the property worth holding here, and
    // `> 0` is the whole of it — a table that went uniformly null lands on
    // zero and this goes red, which is the threat the control names.
    const withFeed = RADIO_STATIONS.filter((s) => s.nowPlayingSource !== null);
    expect(withFeed.length).toBeGreaterThan(0);
  });
});

// #1739 — the BYTES axis: the mirror in `public/radio-logos/` still holds what
// upstream serves TODAY.
//
// WHY IT EXISTS. Vendoring bought privacy and determinism and gave up one
// thing: a proxy with a TTL would have re-fetched a re-uploaded logo within
// four hours, while a mirror is refreshed by a human verb. This axis is what
// keeps that from meaning "a changed logo is invisible" — it makes the staleness
// DETECTABLE on demand, with the command the table's author already runs when
// touching the table.
//
// WHY BYTES AND NOT A HEAD-AND-COMPARE-LENGTH. `Content-Length` alone would
// pass a re-upload of the same dimensions, which is exactly what a logo refresh
// usually is. The comparison has to be the payload.
describe("bytesFailure", () => {
  const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

  it("is quiet when the mirror holds exactly what upstream serves", () => {
    expect(bytesFailure(bytes(1, 2, 3), bytes(1, 2, 3))).toBeNull();
  });

  it("names a re-upload that changed the payload's size", () => {
    const failure = bytesFailure(bytes(1, 2, 3, 4), bytes(1, 2, 3));
    expect(failure).toContain("4 bytes");
    expect(failure).toContain("3 bytes");
    // The report has to carry the cure, not just the diagnosis: the reader is
    // an operator holding a red, and the fix is one verb.
    expect(failure).toContain("sync:radio-logos");
  });

  it("names a re-upload that kept the size and changed the pixels", () => {
    // The case a length compare waves through, and the reason this axis reads
    // the body at all.
    const failure = bytesFailure(bytes(1, 2, 3), bytes(1, 9, 3));
    expect(failure).not.toBeNull();
    expect(failure).toContain("sync:radio-logos");
  });

  it("names a station upstream serves and the mirror does not hold", () => {
    // A row added to the table with no sync run behind it. The offline gate
    // catches this too — but this axis is the one an operator runs while
    // editing the table, so it must not stay silent and defer.
    expect(bytesFailure(bytes(1, 2, 3), null)).toContain("sync:radio-logos");
  });
});

// #1836 — the CODEC and BITRATE axes. `codec` and `bitrate` are a fourth and
// fifth DECLARED claim about external state in this table, and the whole point
// of #1696 is that a baked claim nothing can check is not a fact. The `[hi-fi]`
// badge rests on the first of them, so a wrong codec is not a cosmetic slip:
// it is the picker telling somebody on a metered connection the opposite of
// the truth.
//
// The byte prefixes below are MEASURED, 2026-08-27, off the real endpoints —
// the first 48 bytes each server sent a fresh listener. A hand-drawn fixture
// would prove the parser against itself.
describe("identifyCodec", () => {
  const bytes = (hex: string): Uint8Array =>
    Uint8Array.from((hex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)));

  // ice.somafm.com/groovesalad-128-mp3 — an MPEG frame header, sync word first.
  const MP3 = bytes("fffb9204ef8ff3274655834f32e264a5faa063084c0ba0d1540dbc6b81731a2a");
  // kohina.brona.dk/icecast/stream.ogg — Ogg page, then `\x01vorbis`.
  const OGG_VORBIS = bytes(
    "4f676753000200000000000000008ec9fc1600000000ac3972cb011e01766f7262697300000000",
  );
  // stream.radioparadise.com/flac — the same Ogg framing, then `\x7fFLAC`.
  const OGG_FLAC = bytes(
    "4f67675300020000000000000000717a3b3f00000000423dae9f01337f464c414301000001664c61",
  );

  it("reads an MPEG frame sync as mp3", () => {
    expect(identifyCodec(MP3)).toBe("mp3");
  });

  it("reads an Ogg page carrying a vorbis identification header as vorbis", () => {
    expect(identifyCodec(OGG_VORBIS)).toBe("vorbis");
  });

  it("reads an Ogg page carrying a FLAC identification header as flac", () => {
    // THE case the badge rests on, and the reason this axis reads BYTES at all
    // rather than the content type: measured the same day, kohina answers
    // `audio/ogg` and radioparadise's FLAC answers `application/ogg`, and both
    // headers are simply "an Ogg container". A header-only check would be
    // green in exactly the comparison `[hi-fi]` exists to make.
    expect(identifyCodec(OGG_FLAC)).toBe("flac");
  });

  it("refuses to name a codec it cannot see, rather than guessing the common one", () => {
    // "not measured" must never read as "measured ok" — the equivalence this
    // whole script was written against. A null here is a FINDING downstream,
    // not a skip.
    expect(identifyCodec(bytes("00112233445566778899aabbccddeeff"))).toBeNull();
    expect(identifyCodec(bytes(""))).toBeNull();
  });

  it("refuses an Ogg container whose codec header it does not recognise", () => {
    // CONSTRUCTED, not measured — no station in the table serves Opus, and the
    // fixture is the real Ogg page framing above with `OpusHead` where the
    // identification header sits. The property is what matters: the container
    // is not the codec, and a rule that answered "vorbis" for any `OggS` would
    // have called radioparadise lossy.
    const OGG_OPUS = bytes(
      "4f676753000200000000000000008ec9fc1600000000ac3972cb011e4f70757348656164",
    );
    expect(identifyCodec(OGG_OPUS)).toBeNull();
  });
});

describe("codecFailure", () => {
  it("is quiet when the stream serves what the table declares", () => {
    expect(codecFailure("mp3", "mp3")).toBeNull();
  });

  it("fails a lossless claim the stream does not back — the badge's own defect", () => {
    // THE positive control the whole axis exists for: a row declaring `flac`
    // over a stream that is vorbis draws `[hi-fi]` on a lossy station. This
    // MUST be red, and it is the case a probe that only compared content types
    // would wave through.
    expect(codecFailure("flac", "vorbis")).toBe("upstream serves vorbis, the table claims flac");
  });

  it("fails a lossy claim over a lossless stream, which is the same lie inverted", () => {
    expect(codecFailure("mp3", "flac")).not.toBeNull();
  });

  it("fails a stream it could not identify rather than passing it", () => {
    expect(codecFailure("mp3", null)).toBe(
      "the first bytes match no codec this table can declare — the claim mp3 is unverified",
    );
  });
});

describe("parseIcyBitrate", () => {
  it("reads the kbps a provider states", () => {
    expect(parseIcyBitrate("128")).toEqual({ kind: "kbps", kbps: 128 });
  });

  it("reports a header the provider does not send as ABSENT, not as zero", () => {
    // Measured 2026-08-27: kohina's icecast sends `icy-name` and `icy-genre`
    // and no `icy-br` at all. That is the state `bitrate: null` exists to
    // spell, and folding it to 0 would turn "nobody said" into a number.
    expect(parseIcyBitrate(null)).toEqual({ kind: "absent" });
  });

  it("rejects a value that is not a bitrate instead of coercing it", () => {
    // The boundary: `icy-br` is a free string from a third party. `Number("")`
    // is 0 and `parseInt("128kbps")` is 128 — both of them are a made-up fact
    // downstream, so an unreadable value gets its own state and is reported.
    for (const raw of ["", "  ", "quite fast", "-1", "0", "128.5", "1e3"]) {
      expect(parseIcyBitrate(raw), `icy-br ${JSON.stringify(raw)}`).toEqual({
        kind: "unreadable",
        raw,
      });
    }
  });
});

describe("bitrateFailure", () => {
  it("is quiet when the table states the kbps upstream states", () => {
    expect(bitrateFailure(128, { kind: "kbps", kbps: 128 })).toBeNull();
  });

  it("is quiet when neither the table nor upstream states one", () => {
    expect(bitrateFailure(null, { kind: "absent" })).toBeNull();
  });

  it("fails a number the table invented — #1696's defect in this field", () => {
    // The positive control for the nullable arm: a plausible bitrate baked to
    // fill a column, over a provider that declares nothing. It renders as a
    // fact and is a guess.
    expect(bitrateFailure(128, { kind: "absent" })).toBe(
      "upstream declares no bitrate, the table claims 128 kbps",
    );
  });

  it("fails a number the table dropped, so a knowable fact is not left unsaid", () => {
    expect(bitrateFailure(null, { kind: "kbps", kbps: 320 })).toBe(
      "upstream declares 320 kbps, the table claims none",
    );
  });

  it("fails a number that has moved under the table", () => {
    expect(bitrateFailure(128, { kind: "kbps", kbps: 320 })).toBe(
      "upstream declares 320 kbps, the table claims 128 kbps",
    );
  });

  it("fails an unreadable header rather than treating it as absent", () => {
    // Absent and unreadable are different facts about upstream, and collapsing
    // them would make a table that says `null` green against a server that is
    // saying something nobody can parse.
    expect(bitrateFailure(null, { kind: "unreadable", raw: "128kbps" })).toBe(
      'upstream declares icy-br "128kbps", which is not a bitrate',
    );
  });
});

describe("the union verdict", () => {
  it("reports every axis that has something to say", () => {
    expect(
      problems(
        finding({
          reach: "HTTP 404",
          agree: "catalogue ships x",
          feed: "HTTP 500",
          bytes: "mirror is stale",
          stream: "HTTP 502",
          codec: "upstream serves vorbis, the table claims flac",
          bitrate: "upstream declares no bitrate, the table claims 128 kbps",
        }),
      ),
    ).toEqual([
      "REACH HTTP 404",
      "AGREE catalogue ships x",
      "FEED HTTP 500",
      "BYTES mirror is stale",
      "STREAM HTTP 502",
      "CODEC upstream serves vorbis, the table claims flac",
      "BITRATE upstream declares no bitrate, the table claims 128 kbps",
    ]);
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
    // #1739 — and on the mirror alone: every other axis is happy about a logo
    // that still resolves and still agrees with the catalogue, while the bytes
    // this build ships are last month's.
    expect(brokenCount([finding({ bytes: "mirror is stale" })])).toBe(1);
    // #1836 — and on each of the three stream axes alone. A station whose
    // artwork, catalogue row, feed and mirror are all perfect while the row
    // claims a codec it does not serve is the picker lying about the one thing
    // the `[hi-fi]` badge is there to say.
    expect(brokenCount([finding({ stream: "HTTP 502" })])).toBe(1);
    expect(brokenCount([finding({ codec: "upstream serves vorbis" })])).toBe(1);
    expect(brokenCount([finding({ bitrate: "upstream declares no bitrate" })])).toBe(1);
  });

  it("counts a clean station as unbroken", () => {
    expect(problems(finding({}))).toEqual([]);
    expect(brokenCount([finding({}), finding({ id: "lush" })])).toBe(0);
  });

  it("says nothing about a station that publishes no feed", () => {
    // A null `nowPlayingSource` is a station from a provider that has no track feed,
    // not a broken row. Reported as a finding it would make the table's own
    // nullable field permanently red.
    expect(problems(finding({ feedUrl: null, feed: null }))).toEqual([]);
  });
});

// #1704 — `logoUrl` went NULLABLE for a station that publishes no artwork, and
// a probe of a URL that does not exist is not a defect. Both halves are pinned:
// the axis goes quiet for such a row, and the report still says how many rows it
// actually fetched — a green built from zero probes is silence, not agreement,
// which is the argument the whole file is written around.
describe("a station that publishes no logo (#1704)", () => {
  it("is outside the catalogue's scope — there is no URL to disagree with", () => {
    expect(isCatalogueBacked(null)).toBe(false);
  });

  it("is never an AGREE finding, however empty the catalogue is", () => {
    expect(agreeFailure(null, "kohina", new Map())).toBeNull();
  });

  it("counts out of the LOGO denominator, so a table of nulls cannot read green", () => {
    const finding = (
      id: string,
      logoUrl: string | null,
      feedUrl: string | null,
    ): StationFinding => ({
      id,
      logoUrl,
      streamUrl: `https://ice.somafm.com/${id}-128-mp3`,
      feedUrl,
      reach: null,
      agree: null,
      feed: null,
      bytes: null,
      stream: null,
      codec: null,
      bitrate: null,
    });
    const counts = probedCounts([
      finding("with-logo", "https://api.somafm.com/logos/120/x120.png", null),
      finding("logoless", null, "https://api.somafm.com/songs/y.json"),
      finding("neither", null, null),
    ]);

    expect(counts.logos).toBe(1);
    expect(counts.feeds).toBe(1);
    // #1739 — the mirror denominator agrees with `logos` only because every
    // row here reached. The row below is the one that separates them.
    expect(counts.mirrored).toBe(1);
  });

  it("counts a logo it could not FETCH out of the mirror denominator (#1739)", () => {
    // The two numbers must be able to disagree, or `mirrored` is decoration.
    // A run where upstream is down reaches nothing, so BYTES compared nothing
    // — and "21 with a logo, 0 broken on BYTES" would read as agreement.
    const counts = probedCounts([
      {
        id: "unreachable",
        logoUrl: "https://api.somafm.com/logos/120/x120.png",
        streamUrl: "https://ice.somafm.com/x-128-mp3",
        feedUrl: null,
        reach: "HTTP 503",
        agree: null,
        feed: null,
        bytes: null,
        stream: null,
        codec: null,
        bitrate: null,
      },
    ]);

    expect(counts.logos).toBe(1);
    expect(counts.mirrored).toBe(0);
  });

  it("counts a stream it could not open out of the FORMAT denominator (#1836)", () => {
    // The same argument one axis over, and it is why `streams` exists at all:
    // a run where every station's stream refused the connection would compare
    // no codec and no bitrate, and "22 stations checked, 0 broken" would read
    // as agreement with claims nothing looked at.
    const counts = probedCounts([
      {
        id: "reachable",
        logoUrl: null,
        streamUrl: "https://ice.somafm.com/x-128-mp3",
        feedUrl: null,
        reach: null,
        agree: null,
        feed: null,
        bytes: null,
        stream: null,
        codec: null,
        bitrate: null,
      },
      {
        id: "refused",
        logoUrl: null,
        streamUrl: "https://ice.somafm.com/y-128-mp3",
        feedUrl: null,
        reach: null,
        agree: null,
        feed: null,
        bytes: null,
        stream: "TimeoutError: The operation timed out.",
        codec: null,
        bitrate: null,
      },
    ]);

    expect(counts.streams).toBe(1);
  });

  it("counts the real table, so the denominator is not a fixture", () => {
    // The positive control: the numbers above are computed over hand-made rows,
    // which proves the function and not the table. This one would catch a table
    // whose logos had ALL gone null — the state that would make the script
    // report a perfect green having fetched nothing.
    const counts = probedCounts(
      RADIO_STATIONS.map((s) => ({
        id: s.id,
        logoUrl: s.logoUrl,
        feedUrl: s.nowPlayingSource?.url ?? null,
        streamUrl: s.streamUrl,
        reach: null,
        agree: null,
        feed: null,
        bytes: null,
        stream: null,
        codec: null,
        bitrate: null,
      })),
    );
    expect(
      counts.logos,
      "no station in the table has a logo — the probe is vacuous",
    ).toBeGreaterThan(0);
    // The other direction, and it is a VACUITY guard rather than a rule about
    // the table: with no logo-less row the SKIP path above is never exercised
    // by real data. If the table legitimately goes all-logos one day, this is
    // the line to delete, and deliberately — not the one to edit around.
    expect(
      counts.logos,
      "every station has a logo — the logo-less arm is untested by the real table",
    ).toBeLessThan(RADIO_STATIONS.length);
  });
});
