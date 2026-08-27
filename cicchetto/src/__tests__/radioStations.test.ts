import { describe, expect, it } from "vitest";
import { isLossless, RADIO_STATIONS } from "../lib/radioStations";

// #682 — the curated station table. These are SHAPE invariants, and each one
// exists because breaking it fails SILENTLY in production rather than loudly
// here.
//
// What this file deliberately does NOT assert: that a stream or a logo is
// reachable. That needs the network, and a unit test that hits somafm.com would
// be a third-party outage detector wired into our gate — it would go red on
// days when nothing of ours is broken. That reasoning still holds; what #1696
// changed is where the measurement lives. "Measured by hand when each entry was
// added" was the standing answer here, and for the logos it was false for ten
// of fourteen rows on the day it was written. So the logo half is now an
// executable, on-demand probe — `bun run check:radio`
// (`scripts/check-radio-logos.ts`) — and the stream half remains hand-measured,
// for the mechanical reason the table's moduledoc gives.

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
    //
    // #1704 — the STREAM half is unconditional and the LOGO half skips a null,
    // because a station is now allowed to publish no artwork. The skip is what
    // the positive control below exists to keep honest: a rule that skips every
    // row reports green having compared nothing.
    for (const s of RADIO_STATIONS) {
      expect(s.streamUrl, `station ${s.id} stream`).toMatch(/^https:\/\//);
      if (s.logoUrl === null) continue;
      expect(s.logoUrl, `station ${s.id} logo`).toMatch(/^https:\/\//);
    }
  });

  it("carries a logo for at least one station", () => {
    // #1704 — the positive control for the rule above, the same one #1698 gave
    // `nowPlayingSource`. `logoUrl` went nullable for Kohina, which publishes
    // only a favicon; a table where the field had gone uniformly null would
    // sail through the https rule having checked nothing at all.
    const withLogo = RADIO_STATIONS.filter((s) => s.logoUrl !== null);
    expect(withLogo.length).toBeGreaterThan(0);
  });

  // #1698 / #1835 — the now-playing SOURCE. Same posture as `logoUrl`: a
  // verbatim copy, never templated from `id` (this is a table of stations, not
  // a table of SomaFM slugs), and nullable because publishing a track feed is a
  // provider CAPABILITY, not something every station has.
  const sources = RADIO_STATIONS.flatMap((s) =>
    s.nowPlayingSource === null ? [] : [{ id: s.id, source: s.nowPlayingSource }],
  );

  it("carries a now-playing source for at least one station", () => {
    // The positive control for every rule below it. Each of those skips a
    // station whose `nowPlayingSource` is null, so a table where the field went
    // uniformly null would report green having compared nothing — silence
    // read as agreement.
    expect(sources.length).toBeGreaterThan(0);
  });

  it("serves every now-playing feed over https", () => {
    // A feed is a `fetch`, so it is governed by `connect-src`, and the CSP
    // tokens that admit these hosts are scheme-scoped. An http URL is refused
    // as mixed content before the CSP is even consulted.
    for (const { id, source } of sources) {
      expect(source.url, `station ${id} feed`).toMatch(/^https:\/\//);
    }
  });

  // #1835 — the CSP TWIN, client-side. `connect-src` is a per-vendor gate on
  // the server (`GrappaWeb.Plugs.SecurityHeaders`) and it is deliberately NOT a
  // wildcard, so a feed added here on an unlisted host fails in a way nobody
  // sees: a console violation and a permanently empty track line, with the
  // station otherwise playing fine. The Elixir side cannot check this — it has
  // no idea what the table holds — and this side cannot read the header, so the
  // two halves are pinned against the same literal set from opposite ends.
  //
  // ⚠️ ADDING A HOST HERE IS A NETWORK-SURFACE CHANGE. It has to land in
  // `@csp`'s `connect-src` in the SAME change, or this table points at a host
  // the browser will refuse.
  const CSP_FEED_HOSTS: readonly string[] = ["api.somafm.com", "kohina.brona.dk"];

  it("aims every now-playing feed at a host the CSP's connect-src admits", () => {
    // #1695 measured the trap this generalises: `connect-src` admits
    // `https://api.somafm.com` and NOT the bare `somafm.com`, which answers an
    // identical 200 under curl and dies in the browser. Exact hosts, never a
    // suffix match — a suffix would wave through the very neighbour that
    // separates the shipped policy from a wildcard.
    for (const { id, source } of sources) {
      expect(CSP_FEED_HOSTS, `station ${id} feed is off the CSP's host set`).toContain(
        new URL(source.url).host,
      );
    }
  });

  it("has a feed behind every host it pins — an unused entry proves nothing", () => {
    // The positive control for the rule above, and the same vacuity argument
    // the stream front doors get: a host left in the list after its station was
    // pruned keeps the CSP wider than the table needs, and nothing would say so.
    for (const host of CSP_FEED_HOSTS) {
      expect(
        sources.filter((s) => new URL(s.source.url).host === host),
        `no station feeds from ${host} — the CSP entry outlived its station`,
      ).not.toHaveLength(0);
    }
  });

  it("keeps every somafm source on api.somafm.com — the #1695 pin, now keyed on kind", () => {
    // Scoped by `kind` rather than by host suffix, which is what the old
    // spelling did: the suffix version could only notice a somafm URL that had
    // drifted to the wrong somafm host, while this one also notices a row
    // declaring the somafm READER over some other provider's document — a
    // parser/document mismatch that answers 200 and yields no track.
    for (const { id, source } of sources) {
      if (source.kind !== "somafm") continue;
      expect(new URL(source.url).host, `station ${id} reads somafm off the wrong host`).toBe(
        "api.somafm.com",
      );
    }
  });

  it("gives every icecast source an absolute mount path", () => {
    // #1835 — the mount is compared against a `URL.pathname`, which always
    // starts with `/`. A mount spelled `stream.ogg` would therefore match no
    // source in any document, and the station would read `unanswered` forever
    // with the feed answering 200 the whole time. The failure is silent from
    // every surface, which is why it is pinned rather than left to review.
    for (const { id, source } of sources) {
      if (source.kind !== "icecast-status") continue;
      expect(source.mount, `station ${id} mount is not an absolute path`).toMatch(/^\//);
    }
  });

  // #1836 — the FORMAT half of a row: what codec it serves and at what
  // bitrate. Both DECLARED, for the reason the module header gives for every
  // other field — this is a curated table and what a row claims stays ours —
  // and both checkable, at CHECK time, by `bun run check:radio`. The rules
  // below are the OFFLINE half: they hold on a laptop with no network, in CI,
  // where the probe deliberately does not run.

  it("declares a bitrate as a whole positive number of kbps, or nothing at all", () => {
    // A zero, a negative or a fraction would all render — "0k", "-1k",
    // "128.5k" — and none of them is a bitrate. The field is nullable
    // precisely so that "we do not know" has a spelling that is not a number.
    for (const s of RADIO_STATIONS) {
      if (s.bitrate === null) continue;
      expect(Number.isInteger(s.bitrate), `station ${s.id} bitrate is not a whole number`).toBe(
        true,
      );
      expect(s.bitrate, `station ${s.id} bitrate`).toBeGreaterThan(0);
    }
  });

  it("declares a bitrate for at least one station", () => {
    // The positive control for the rule above, the same one `logoUrl` and
    // `nowPlayingSource` carry: that rule SKIPS a null, so a table where the
    // field had gone uniformly null would report green having checked nothing.
    const priced = RADIO_STATIONS.filter((s) => s.bitrate !== null);
    expect(priced.length).toBeGreaterThan(0);
  });

  it("leaves at least one station's bitrate null — the arm that draws no number", () => {
    // The other direction, and it is a VACUITY guard rather than a rule about
    // the table, the same shape `checkRadioLogos.test.ts` gives the logo-less
    // arm: with every row priced, the "provider states nothing" path is never
    // exercised by real data. If every provider in the table legitimately
    // declares a bitrate one day, this is the line to DELETE, deliberately —
    // not the one to edit around by inventing a plausible number for a row
    // that has none, which is the defect #1696 was filed about.
    const unpriced = RADIO_STATIONS.filter((s) => s.bitrate === null);
    expect(unpriced.length).toBeGreaterThan(0);
  });

  it("decides hi-fi from the CODEC, so no station name is ever consulted", () => {
    // The `[hi-fi]` badge (vjt's #1836 ruling) marks a row whose codec keeps
    // every sample it was handed. Keying that on a list of station names would
    // be right for exactly the rows somebody remembered to list and silently
    // wrong for the next one added, which is why the classification lives on
    // the codec and this pins it.
    expect(isLossless("flac")).toBe(true);
    expect(isLossless("mp3")).toBe(false);
    expect(isLossless("vorbis")).toBe(false);
  });

  // 🔴 WHAT IS DELIBERATELY NOT HERE, and it was written first and then
  // MEASURED AWAY. Twenty rows stream from a mount named `<id>-<kbps>-<codec>`,
  // so the obvious offline rule — and the one this file carried for an hour —
  // is that `bitrate` must equal the number in the path. It looks like the
  // provider writing its own claim down where a test can read it with no
  // network.
  //
  // It is false. The FIRST run of `bun run check:radio` against the real table
  // reddened exactly one row: `ice.somafm.com/reggae-128-mp3` answers
  // `icy-br: 160`, and the frame header confirms it independently of the
  // server's own say-so (byte 2 is `0xa0`, MPEG1 Layer III bitrate index 10 =
  // 160 kbps, where every sibling reads `0x92` = index 9 = 128). The mount NAME
  // is a legacy label, not a declaration.
  //
  // So the rule would have forced a wrong number into the table to stay green —
  // a test dictating a falsehood to the data, which is worse than no test. It
  // is gone rather than scoped to nineteen rows, and the codec half went with
  // it: if the vendor's naming convention lies about one field of the mount
  // there is no reason to trust it about the other, and `check:radio` reads
  // BOTH off the payload, which is the authority the name only imitates.
  // Recorded in DESIGN_NOTES 2026-08-27.

  // #1703 — the CURATION floor. The issue is not a shape bug: the table was
  // structurally perfect and offered no metal at all and exactly one row of
  // guitar music. Those two counts are the report, so they are what is pinned.
  //
  // FLOORS, never exact counts, and the difference is the whole reason these
  // are worth writing: an exact count is a mirror of today's table that goes
  // red on the next station anyone adds, which trains the next author to edit
  // the assertion instead of reading it. A floor only goes red when the table
  // stops answering the request this issue made — which is the fact worth
  // defending.
  //
  // Keyed on the `rock` / `metal` TAGS rather than on ids, so pruning or
  // swapping a specific station is free and only emptying the genre is not.
  // `alternative` is deliberately NOT counted as guitar music: `u80s` carries
  // it and is synthpop, so folding it in would let the floor be satisfied by
  // rows that do not answer the request.
  const tagged = (tag: string): readonly string[] =>
    RADIO_STATIONS.filter((s) => s.genres.includes(tag)).map((s) => s.id);

  it("offers metal at all — the list had none when #1703 was filed", () => {
    expect(tagged("metal"), "no station carries the `metal` tag").not.toHaveLength(0);
  });

  it("offers more than one rock station — the list had exactly one", () => {
    // `indiepop` was that one. A single row is what the issue called "almost no
    // rock", so one is a regression to the reported state, not a pass.
    expect(tagged("rock").length, "the table is back to a single rock row").toBeGreaterThan(1);
  });

  // #1703 — the FRONT DOOR rule, once per vendor.
  //
  // Every streaming provider this table touches puts a load balancer in front
  // of a numbered pool, and the obvious way to add a station — copy the URL a
  // player or a `.pls` hands you — pins one pool member. That URL works on the
  // day it is pasted and rots when the pool moves, which is a station that
  // silently stops playing.
  //
  // Measured, per vendor, and the two are not the same shape:
  //   * somafm       (2026-08-23) — a channel's `.pls` lists three ROTATING
  //     hosts (ice2 / ice5 / ice6) while the unnumbered `ice.somafm.com`
  //     answers for all of them.
  //   * rockantenne  (2026-08-24) — `stream.rockantenne.de` 302s to
  //     `s<N>-webradio.rockantenne.de`, and it rotates PER REQUEST: five
  //     consecutive fetches of the same channel answered s2, s6, s2, s1, s2.
  //     The redirect target is also https, so following it costs no
  //     mixed-content step. Baking any `s<N>` host pins one member of a
  //     balancer that is actively distributing.
  //
  // WHY A TABLE AND NOT A SECOND COPY OF THE SOMAFM TEST. This rule used to
  // name somafm alone, and the moment the first non-SomaFM station landed that
  // asymmetry would have been a rule that pins the vendor we already got right
  // and says nothing about the new one — the same shape of gap that let a vite
  // bump through `integration.yml` without running a line of JavaScript, which
  // that file's own header records. The map lives in the TEST and not in the
  // type on purpose: it is a fact about vendors' infrastructure, and baking it
  // into `RadioStation` is exactly the "table of vendor slugs" the module
  // header refuses to become.
  const STREAM_FRONT_DOORS: readonly { readonly vendor: string; readonly frontDoor: string }[] = [
    { vendor: "somafm.com", frontDoor: "ice.somafm.com" },
    { vendor: "rockantenne.de", frontDoor: "stream.rockantenne.de" },
  ];

  it("uses each vendor's stable front door, never a numbered pool host", () => {
    for (const s of RADIO_STATIONS) {
      const host = new URL(s.streamUrl).host;
      const door = STREAM_FRONT_DOORS.find((d) => host.endsWith(d.vendor));
      // A vendor absent from the map is not a failure: the table is allowed to
      // hold a station from a provider whose topology nobody has measured yet,
      // and inventing a front door for it would be the unverifiable claim
      // #1696 was filed about. It is simply un-pinned until someone measures.
      if (door === undefined) continue;
      expect(host, `station ${s.id} pins a rotating pool host`).toBe(door.frontDoor);
    }
  });

  it("has a station behind every vendor it pins — an unused rule proves nothing", () => {
    // The positive control, and the reason it is a separate test: the rule
    // above SKIPS, so a vendor whose rows all disappeared (renamed, pruned,
    // re-hosted) would keep reporting green having compared nothing. That is
    // the vacuity `check-radio-logos-core.ts` exports `isCatalogueBacked` to
    // guard against, in the same table, for the same reason — a green built
    // from zero comparisons is silence, not agreement.
    for (const door of STREAM_FRONT_DOORS) {
      const behind = RADIO_STATIONS.filter((s) => new URL(s.streamUrl).host.endsWith(door.vendor));
      expect(
        behind,
        `no station streams from ${door.vendor} — the rule is vacuous`,
      ).not.toHaveLength(0);
    }
  });
});
