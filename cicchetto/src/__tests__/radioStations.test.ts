import { describe, expect, it } from "vitest";
import { RADIO_STATIONS } from "../lib/radioStations";

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
    // `songsUrl`. `logoUrl` went nullable for Kohina, which publishes only a
    // favicon; a table where the field had gone uniformly null would sail
    // through the https rule having checked nothing at all.
    const withLogo = RADIO_STATIONS.filter((s) => s.logoUrl !== null);
    expect(withLogo.length).toBeGreaterThan(0);
  });

  // #1698 — the now-playing feed URL. Same posture as `logoUrl`: a verbatim
  // copy, never templated from `id` (this is a table of stations, not a table
  // of SomaFM slugs), and nullable because publishing a track feed is a
  // provider CAPABILITY, not something every station has.
  it("carries a now-playing feed for at least one station", () => {
    // The positive control for every rule below it. Each of those skips a
    // station whose `songsUrl` is null, so a table where the field went
    // uniformly null would report green having compared nothing — silence
    // read as agreement.
    const withFeed = RADIO_STATIONS.filter((s) => s.songsUrl !== null);
    expect(withFeed.length).toBeGreaterThan(0);
  });

  it("serves every now-playing feed over https", () => {
    // A feed is a `fetch`, so it is governed by `connect-src`, and the CSP
    // token that admits it (`https://api.somafm.com`) is scheme-scoped. An
    // http URL is refused as mixed content before the CSP is even consulted.
    for (const s of RADIO_STATIONS) {
      if (s.songsUrl === null) continue;
      expect(s.songsUrl, `station ${s.id} songs feed`).toMatch(/^https:\/\//);
    }
  });

  it("aims every somafm now-playing feed at api.somafm.com, the host the CSP admits", () => {
    // #1695 measured this and it is the trap worth pinning: `connect-src`
    // admits `https://api.somafm.com` and NOT the bare `somafm.com`, which
    // answers an identical 200 under curl and dies in the browser. The failure
    // is a console CSP violation and a permanently empty track line — silent
    // from the operator's side. Scoped to somafm hosts for the same reason the
    // stream rule is: the table may hold a station from another provider.
    for (const s of RADIO_STATIONS) {
      if (s.songsUrl === null) continue;
      const host = new URL(s.songsUrl).host;
      if (!host.endsWith("somafm.com")) continue;
      expect(host, `station ${s.id} songs feed is off the CSP's host`).toBe("api.somafm.com");
    }
  });

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
