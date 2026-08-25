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
// FOUR AXES, all reported, union verdict (the `scripts/check.ts` posture):
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
//   FEED   — #1698: the `songsUrl` now-playing feed answers 200 with
//            `application/json`. A third baked third-party URL in the same
//            table, so it inherits the same problem this script exists for:
//            get the slug wrong and the station still plays perfectly while
//            the track line stays permanently empty — a defect with no symptom
//            anywhere the operator looks. A station that publishes no feed
//            (`songsUrl: null`) is SKIPPED, not failed.
//            No AGREE twin: `channels.json` publishes a `lastPlaying` STRING,
//            not the feed's URL, so there is no upstream value to compare the
//            baked one against. Naming that absence beats inventing a
//            comparison that would pass on anything.
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
import { RADIO_LOGO_PATHS } from "../src/lib/radioLogoPaths";
import { RADIO_STATIONS } from "../src/lib/radioStations";
import {
  agreeFailure,
  brokenCount,
  bytesFailure,
  type CatalogueBody,
  catalogueLogos,
  FEED_CONTENT_TYPE,
  LOGO_CONTENT_TYPE,
  problems,
  probedCounts,
  reachFailure,
  type StationFinding,
} from "./check-radio-logos-core";

const CATALOGUE_URL = "https://api.somafm.com/channels.json";
const TIMEOUT_MS = 15_000;

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
    // finding, the same arm `songsUrl` has had since #1698. There is no URL to
    // reach; what the UI draws instead is our own placeholder, which cannot
    // 404. Counted out of the denominator below rather than folded into the
    // green.
    const logo = station.logoUrl === null ? null : await probeLogo(station.logoUrl);
    return {
      id: station.id,
      logoUrl: station.logoUrl,
      feedUrl: station.songsUrl,
      reach: logo?.reach ?? null,
      agree: agreeFailure(station.logoUrl, station.id, catalogue),
      // A station that publishes no feed is not probed and is not a finding.
      feed:
        station.songsUrl === null
          ? null
          : await probeReach(station.songsUrl, FEED_CONTENT_TYPE),
      // #1739 — only when there is an upstream payload in hand. A skipped row
      // and a row whose fetch died both report null here: the first has
      // nothing to compare, and the second is already red on REACH.
      bytes:
        logo?.upstream === undefined || logo.upstream === null
          ? null
          : bytesFailure(logo.upstream, mirroredBytes(station.id)),
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
const probed = probedCounts(findings);
console.log(
  `\ncheck:radio summary — ${findings.length} stations checked ` +
    `(${probed.logos} with a logo, ${probed.mirrored} compared against the mirror, ` +
    `${probed.feeds} with a now-playing feed), ${broken} broken`,
);

process.exit(broken === 0 ? 0 : 1);
