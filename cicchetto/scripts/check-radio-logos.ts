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
// THREE AXES, all reported, union verdict (the `scripts/check.ts` posture):
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

import { RADIO_STATIONS } from "../src/lib/radioStations";
import {
  agreeFailure,
  brokenCount,
  type CatalogueBody,
  catalogueLogos,
  FEED_CONTENT_TYPE,
  LOGO_CONTENT_TYPE,
  problems,
  reachFailure,
  type StationFinding,
} from "./check-radio-logos-core";

const CATALOGUE_URL = "https://api.somafm.com/channels.json";
const TIMEOUT_MS = 15_000;

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

const catalogue = await fetchCatalogue();
if (catalogue === null) {
  console.error("\ncheck:radio — cannot verify the table without the catalogue.");
  process.exit(1);
}

const findings: StationFinding[] = await Promise.all(
  RADIO_STATIONS.map(async (station) => ({
    id: station.id,
    logoUrl: station.logoUrl,
    feedUrl: station.songsUrl,
    reach: await probeReach(station.logoUrl, LOGO_CONTENT_TYPE),
    agree: agreeFailure(station.logoUrl, station.id, catalogue),
    // A station that publishes no feed is not probed and is not a finding.
    feed:
      station.songsUrl === null
        ? null
        : await probeReach(station.songsUrl, FEED_CONTENT_TYPE),
  })),
);

// #1703 — DERIVED, not a constant. The column was a hand-typed 16, which the
// first id longer than that ran straight into the URL beside it. An id length
// is a curation choice and the report must not quietly constrain it.
const idWidth = Math.max(...findings.map((f) => f.id.length)) + 2;

for (const finding of findings) {
  const found = problems(finding);
  console.log(
    `  ${found.length === 0 ? "ok  " : "FAIL"}  ${finding.id.padEnd(idWidth)}${finding.logoUrl}`,
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
const feedsProbed = findings.filter((f) => f.feedUrl !== null).length;
console.log(
  `\ncheck:radio summary — ${findings.length} stations checked ` +
    `(${feedsProbed} with a now-playing feed), ${broken} broken`,
);

process.exit(broken === 0 ? 0 : 1);
