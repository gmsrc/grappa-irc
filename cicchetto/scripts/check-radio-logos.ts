#!/usr/bin/env bun
// #1696 — hold `src/lib/radioStations.ts`'s baked logo URLs to the catalogue
// that actually serves them.
//
// WHY THIS EXISTS AS A SCRIPT AND NOT AS A TEST. #682 shipped the table with a
// moduledoc claiming "the versionless logo URLs were checked the same way".
// They were not: measured 2026-08-24, TEN of the fourteen answered 404, and the
// four that answered 200 were exactly the four SomaFM genuinely serves as PNG.
// The defect was never the extension — it was a claim about external state that
// nothing in the repo could establish, so a true one and a false one read
// identically to every later reader. The cure is to make the claim EXECUTABLE,
// not to write it more carefully.
//
// It is deliberately NOT wired into `bun run check` or CI.
// `src/__tests__/radioStations.test.ts` already states the reason and it is the
// right one: a gate that fetches somafm.com is a third-party outage detector
// bolted onto our build, and it goes red on days when nothing of ours is
// broken. This runs on demand — `bun run check:radio` — and the table's
// moduledoc names it, so the next author edits the table and has a command
// instead of a ritual.
//
// SEVEN AXES, all reported, union verdict (the `scripts/check.ts` posture):
//
//   REACH  — the logo URL answers 200 with an `image/*` content type. This is
//            the property the picker needs, and it covers every station
//            including one from another provider.
//   AGREE  — for a station whose logo we point at somafm, the baked URL is the
//            one `channels.json` ships. Stronger than REACH: it catches a logo
//            that still resolves but is no longer the one upstream publishes,
//            and it is what pins the table to the authority WITHOUT making the
//            running client depend on that authority (see the table's
//            moduledoc for why the fetch stays out of the render path).
//   FEED   — #1698: the `nowPlayingSource` feed answers 200 with
//            `application/json`. A third baked third-party URL in the same
//            table, so it inherits the same problem this script exists for:
//            get the slug wrong and the station still plays perfectly while
//            the track line stays permanently empty — a defect with no symptom
//            anywhere the operator looks. A station that publishes no feed
//            (`nowPlayingSource: null`) is SKIPPED, not failed.
//            No AGREE twin: `channels.json` publishes a `lastPlaying` STRING,
//            not the feed's URL, so there is no upstream value to compare the
//            baked one against. Naming that absence beats inventing a
//            comparison that would pass on anything.
//            #1835 — the axis is PER KIND now, and both halves of that are
//            measured rather than stylistic:
//              * a somafm feed is probed with HEAD, as before;
//              * an icecast `status-json.xsl` answers HEAD with **400**
//                (measured on kohina.brona.dk 2026-08-27), so it is probed with
//                a GET. A shared HEAD would report a false RED for a feed that
//                works perfectly.
//              * and because the GET has the body in hand anyway, the icecast
//                arm runs the PRODUCTION parser over it and demands a track.
//                That is the only executable check on `mount`, which is a
//                hand-copied string that nothing else can validate: get it
//                wrong and the feed still answers 200 `application/json` while
//                the station's track line stays empty forever. A content-type
//                probe would wave that straight through — which is the exact
//                defect class the paragraph above says this script exists for.
//   BYTES  — #1739: `public/radio-logos/<id>.<ext>` still holds what upstream
//            serves. The picker draws the VENDORED bytes now — no viewer
//            contacts api.somafm.com — and the one thing that mirror gave up
//            versus the caching proxy the issue proposed is self-repair: a
//            re-uploaded logo is picked up by a human verb rather than a TTL.
//            This axis is what keeps "picked up later" from meaning "never
//            noticed". A station that publishes no logo is SKIPPED (there is
//            nothing upstream to compare; the generated tile's freshness is
//            `src/__tests__/radioLogoFiles.test.ts`'s job, offline), and so is
//            one whose REACH already failed — a single dead fetch is reported
//            once, not counted twice under two names.
//   STREAM — #1836: the endless audio endpoint answers 2xx at all. This was
//            the LAST hand-measured claim in the table — `radioStations.ts`
//            said so in a ⚠️ of its own — and it stayed hand-measured because
//            a stream cannot be HEADed: icecast answers a GET with a body that
//            never ends, so `HEAD` returns an empty reply (curl exit 52). The
//            cure is an ABORTED get, which is what `probeStream` below is.
//   CODEC  — #1836: the first bytes upstream sends ARE the codec the table
//            declares. The picker draws `[hi-fi]` off that field, so a wrong
//            one tells somebody on a metered connection the opposite of the
//            truth, silently and on every render.
//            🔴 THE BYTES, NOT THE CONTENT TYPE, and it is measured rather
//            than fastidious: on 2026-08-27 kohina's Ogg VORBIS answered
//            `audio/ogg` and radioparadise's Ogg FLAC answered
//            `application/ogg` — both mean "an Ogg container" and neither
//            names a codec, so a header check is green in exactly the
//            lossy-vs-lossless comparison the badge exists to make.
//   BITRATE— #1836: the declared kbps against what the STREAM states about
//            itself, IN BOTH DIRECTIONS. A number invented over a silent
//            provider is #1696's own defect in a new field; a number dropped
//            over a stream that states one draws no cost for a station that has
//            one.
//            🔴 THE AUTHORITY IS PER CODEC and `readBitrate` owns the table.
//            An MPEG frame header states its own rate exactly; an Ogg Vorbis
//            identification header NOMINATES one; FLAC's STREAMINFO states
//            NONE — decoded off radioparadise's own bytes 2026-08-27, it
//            carries blocksize, sample rate, channels and bit depth and a
//            framesize of 0/0, because FLAC is inherently variable-rate — so a
//            FLAC row's only authority is `icy-br`. That exception is why this
//            axis is not simply "read the frame header": applied literally,
//            every FLAC row would be `null` and the stations the `[hi-fi]`
//            badge exists for would show no cost at all.
//            `null` therefore means NOT KNOWABLE, never "the provider was
//            quiet" — if the stream states it, the table states it.
//
// ⚠️ THE LOGO AXIS FETCHES WITH `GET`, NOT `HEAD`, and the feed axis still
// uses HEAD. BYTES needs the payload, and one GET yields the status, the
// content type and the body — so REACH is derived from the SAME response
// rather than from a second request. Two requests to one URL would let the two
// axes disagree about one resource, which is a worse report than either
// verdict.
//
// THIS FILE IS THE IO HALF ONLY. Every rule lives in `check-radio-logos-core.ts`
// so that it is reachable from `src` and therefore covered by `tsc --noEmit`;
// `cicchetto/scripts/` is checked by neither tsc nor biome. See that file's
// header — the split is `lock-drift.ts` / `lock-drift-core.ts`, and it is not
// ceremony: written runner-only, the `?v=` strip in here carried a real
// `noUncheckedIndexedAccess` violation that no gate could see.
//
// A catalogue that cannot be fetched is a FAILURE, not a pass: "not measured"
// must never read as "measured ok" — that equivalence is the whole bug.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertNever } from "../src/lib/api";
// The PRODUCTION parser, not a copy. #1835 — `nowPlayingFeeds.ts` is pure
// precisely so this script can import it: pulling `nowPlaying.ts` instead would
// eagerly open the store's reactive root in a process with no DOM.
import { parseIcecastStatus } from "../src/lib/nowPlayingFeeds";
import { RADIO_LOGO_PATHS } from "../src/lib/radioLogoPaths";
import { type NowPlayingSource, RADIO_STATIONS } from "../src/lib/radioStations";
import {
  agreeFailure,
  bitrateFailure,
  brokenCount,
  bytesFailure,
  type CatalogueBody,
  catalogueLogos,
  codecFailure,
  FEED_CONTENT_TYPE,
  identifyCodec,
  LOGO_CONTENT_TYPE,
  problems,
  probedCounts,
  reachFailure,
  readBitrate,
  type StationFinding,
} from "./check-radio-logos-core";

const CATALOGUE_URL = "https://api.somafm.com/channels.json";
const TIMEOUT_MS = 15_000;

/** #1836 — how much of an endless stream to pull before hanging up.
 *
 * Enough for the Ogg identification header and then some: measured
 * 2026-08-27, `\x01vorbis` sits at byte 28 of kohina's first page and
 * `\x7fFLAC` at byte 29 of radioparadise's. A kilobyte is two orders of
 * headroom over that and still nothing — the connection is closed before the
 * server has finished its first second of audio. */
const STREAM_HEAD_BYTES = 1024;

/** Resolved against THIS script, so the mirror is found wherever the verb is
    run from — the reason `gen-emoji.ts` and `sync-radio-logos.ts` do the
    same. */
const PUBLIC_DIR = join(import.meta.dir, "..", "public");

/** The catalogue's logo URL per id, or null when the catalogue itself could not
    be read — which the caller must NOT treat as "no disagreement found". */
async function fetchCatalogue(): Promise<Map<string, string> | null> {
  try {
    const res = await fetch(CATALOGUE_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      console.error(`catalogue ${CATALOGUE_URL} answered ${res.status}`);
      return null;
    }
    return catalogueLogos((await res.json()) as CatalogueBody);
  } catch (err) {
    console.error(`catalogue ${CATALOGUE_URL} could not be fetched: ${err}`);
    return null;
  }
}

/** A transport error is a REACH failure like any other: the picker would show
    no logo either way, and swallowing it to null would be the soft green this
    probe exists to refuse.
    #1698 — shared by the logo and the now-playing feed, which differ only in
    the content type they must answer with. Measured 2026-08-24: `HEAD` on
    `api.somafm.com/songs/<id>.json` answers 200 `application/json`, and a slug
    the host does not know answers 404 `text/html` — so one HEAD separates a
    live feed from a mistyped one, exactly as it does for a logo. */
async function probeReach(url: string, expected: string): Promise<string | null> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return reachFailure(res.status, res.headers.get("content-type"), expected);
  } catch (err) {
    return `${err}`;
  }
}

/** `null` when the station's declared source answers with a track we would
 * actually show; otherwise why it does not.
 *
 * #1835 — dispatched on `kind` rather than shared, for the two measured reasons
 * the header gives (HEAD is a 400 on icecast; `mount` has no other check). The
 * `assertNever` is what makes a third vendor added to the union impossible to
 * ship with this axis silently un-probed.
 */
async function probeFeed(source: NowPlayingSource): Promise<string | null> {
  switch (source.kind) {
    case "somafm":
      return probeReach(source.url, FEED_CONTENT_TYPE);
    case "icecast-status": {
      try {
        const res = await fetch(source.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        const reach = reachFailure(res.status, res.headers.get("content-type"), FEED_CONTENT_TYPE);
        if (reach !== null) return reach;
        // The body is already here, so the strong claim costs nothing extra.
        // Reported with the mount spelled out because that is the value the
        // reader has to go and fix, and it is the one the document disagrees
        // with.
        const track = parseIcecastStatus(await res.json(), source.mount);
        return track === null
          ? `answers 200 but carries no track at mount ${source.mount}`
          : null;
      } catch (err) {
        return `${err}`;
      }
    }
    default:
      return assertNever(source);
  }
}

/** REACH and the payload BYTES for one logo, from ONE request.
 *
 * #1739 — a GET rather than the HEAD above, because the BYTES axis needs the
 * body and a second request to the same URL would let two axes disagree about
 * one resource. `upstream` is null exactly when `reach` is not: there is no
 * payload to compare when the fetch did not produce one, and reporting the
 * same dead fetch under two axis names would double-count it. */
async function probeLogo(url: string): Promise<{
  readonly reach: string | null;
  readonly upstream: Uint8Array | null;
}> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const reach = reachFailure(res.status, res.headers.get("content-type"), LOGO_CONTENT_TYPE);
    if (reach !== null) return { reach, upstream: null };
    return { reach: null, upstream: new Uint8Array(await res.arrayBuffer()) };
  } catch (err) {
    return { reach: `${err}`, upstream: null };
  }
}

/** #1836 — the first bytes of a station's stream and what it says about
 * itself, from ONE aborted GET.
 *
 * ABORTED, and that is the whole mechanism: icecast answers a GET with a body
 * that never ends, which is why `HEAD` returns an empty reply and why this
 * claim stayed hand-measured until now. The reader is cancelled the moment
 * there are enough bytes to identify the codec, so the probe costs a kilobyte
 * per station and closes the socket itself rather than waiting for a timeout.
 *
 * `head` is null exactly when `stream` is not — the `probeLogo` contract one
 * function up, and for the same reason: there are no bytes to identify when the
 * fetch produced none, and reporting one dead connection under three axis names
 * would treble-count it. */
async function probeStream(url: string): Promise<{
  readonly stream: string | null;
  readonly head: Uint8Array | null;
  readonly icyBr: string | null;
}> {
  const dead = (why: string): { stream: string; head: null; icyBr: null } => ({
    stream: why,
    head: null,
    icyBr: null,
  });
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return dead(`HTTP ${res.status}`);
    // Not `reachFailure`: a stream has no one content type to demand. Measured
    // 2026-08-27, the three vendors here answer `audio/mpeg`, `audio/ogg` and
    // `application/ogg`, and the CODEC axis reads the payload precisely because
    // the header cannot separate the last two. A status check is what this axis
    // can honestly assert on its own.
    const body = res.body;
    if (body === null) return dead("answered 2xx with no body at all");

    const reader = body.getReader();
    const head = new Uint8Array(STREAM_HEAD_BYTES);
    let filled = 0;
    while (filled < STREAM_HEAD_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const take = Math.min(value.byteLength, STREAM_HEAD_BYTES - filled);
      head.set(value.subarray(0, take), filled);
      filled += take;
    }
    await reader.cancel();
    return { stream: null, head: head.subarray(0, filled), icyBr: res.headers.get("icy-br") };
  } catch (err) {
    return dead(`${err}`);
  }
}

/** What `public/radio-logos/` holds for this station, or null when it holds
    nothing — which `bytesFailure` reports rather than skips. */
function mirroredBytes(id: string): Uint8Array | null {
  const path = RADIO_LOGO_PATHS[id];
  if (path === undefined) return null;
  try {
    return new Uint8Array(readFileSync(join(PUBLIC_DIR, path.replace(/^\//, ""))));
  } catch {
    return null;
  }
}

const catalogue = await fetchCatalogue();
if (catalogue === null) {
  console.error("\ncheck:radio — cannot verify the table without the catalogue.");
  process.exit(1);
}

const findings: StationFinding[] = await Promise.all(
  RADIO_STATIONS.map(async (station) => {
    // #1704 — a station that publishes NO logo is not probed and is not a
    // finding, the same arm `nowPlayingSource` has had since #1698. There is no
    // URL to reach; what the UI draws instead is our own placeholder, which
    // cannot 404. Counted out of the denominator below rather than folded into
    // the green.
    const logo = station.logoUrl === null ? null : await probeLogo(station.logoUrl);
    // #1836 — unconditional, unlike the two probes above: `streamUrl` is not
    // nullable, so there is no arm to skip. A station with no stream is not a
    // station.
    const stream = await probeStream(station.streamUrl);
    // #1836 — identified ONCE and shared by the two axes below: the codec the
    // bytes turned out to be is both the CODEC verdict and the choice of which
    // authority may state a bitrate.
    const served = stream.head === null ? null : identifyCodec(stream.head);
    const source = station.nowPlayingSource;
    return {
      id: station.id,
      logoUrl: station.logoUrl,
      feedUrl: source?.url ?? null,
      streamUrl: station.streamUrl,
      reach: logo?.reach ?? null,
      agree: agreeFailure(station.logoUrl, station.id, catalogue),
      // A station that publishes no feed is not probed and is not a finding.
      feed: source === null ? null : await probeFeed(source),
      // #1739 — only when there is an upstream payload in hand. A skipped row
      // and a row whose fetch died both report null here: the first has
      // nothing to compare, and the second is already red on REACH.
      bytes:
        logo?.upstream === undefined || logo.upstream === null
          ? null
          : bytesFailure(logo.upstream, mirroredBytes(station.id)),
      stream: stream.stream,
      // #1836 — gated on the bytes being IN HAND, the `bytes` arm above. A
      // connection that never opened has already been reported once under
      // STREAM; saying it again under two more names is the double-count that
      // gate exists to refuse.
      codec: stream.head === null ? null : codecFailure(station.codec, served),
      // #1836 (ruling) — read by the authority the SERVED codec supports, not
      // the declared one. Quiet when the codec could not be identified: there
      // is no authority to choose without it, and CODEC has already said so.
      bitrate:
        stream.head === null || served === null
          ? null
          : bitrateFailure(station.bitrate, readBitrate(served, stream.head, stream.icyBr)),
    };
  }),
);

// #1703 — DERIVED, not a constant. The column was a hand-typed 16, which the
// first id longer than that ran straight into the URL beside it. An id length
// is a curation choice and the report must not quietly constrain it.
const idWidth = Math.max(...findings.map((f) => f.id.length)) + 2;

for (const finding of findings) {
  const found = problems(finding);
  console.log(
    `  ${found.length === 0 ? "ok  " : "FAIL"}  ${finding.id.padEnd(idWidth)}` +
      `${finding.logoUrl ?? "(no logo — placeholder)"}`,
  );
  // The feed URL is printed on its own line rather than folded into the one
  // above: a station has two URLs now, and a report that names only one leaves
  // the reader guessing which of them a `FEED` line is about. `(no feed)` is
  // stated for the same reason the summary states its denominator — a skipped
  // row must not read as a probed one.
  console.log(`          feed ${finding.feedUrl ?? "(no feed)"}`);
  // #1836 — the third URL gets its own line for the reason the feed does, and
  // more sharply: THREE of the seven axes talk about this endpoint, so a reader
  // holding a `STREAM`/`CODEC`/`BITRATE` red would otherwise have to go back to
  // the table to learn which URL was probed. No `(no stream)` arm — the field
  // is not nullable.
  console.log(`          stream ${finding.streamUrl}`);
  for (const p of found) console.log(`          ${p}`);
}

const broken = brokenCount(findings);

// The denominator is the honesty payload, as in scripts/check.ts: "14 stations
// checked" is what tells a reader the verdict covers the whole table. #1698
// adds a SECOND denominator for the same reason — the FEED axis skips a
// station that publishes none, so "14 stations checked" alone would read as
// "14 feeds checked" on a table where the field had gone uniformly null.
// #1704 adds the logo half of that same denominator, now that `logoUrl` is
// nullable too: without it a table whose logos had all gone null would report
// "21 stations checked, 0 broken" having fetched nothing at all.
// #1836 adds the STREAM half. Every row has a stream, so the number that means
// anything is how many actually OPENED: a run where the connections all timed
// out compared no codec and no bitrate, and the station count alone would read
// as agreement with claims nothing looked at.
const probed = probedCounts(findings);
console.log(
  `\ncheck:radio summary — ${findings.length} stations checked ` +
    `(${probed.logos} with a logo, ${probed.mirrored} compared against the mirror, ` +
    `${probed.feeds} with a now-playing feed, ${probed.streams} streams opened), ` +
    `${broken} broken`,
);

process.exit(broken === 0 ? 0 : 1);
