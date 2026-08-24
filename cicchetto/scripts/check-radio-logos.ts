#!/usr/bin/env bun
// #1696 — hold `src/lib/radioStations.ts`'s baked logo URLs to the catalogue
// that actually serves them.
//
// WHY THIS EXISTS AS A SCRIPT AND NOT AS A TEST. #682 shipped the table with a
// moduledoc claiming "the versionless logo URLs were checked the same way".
// They were not: measured 2026-08-24, TEN of the fourteen answered 404, and the
// four that answered 200 were exactly the four SomaFM genuinely serves as PNG.
// The defect was never the extension — it was a claim about external state that
// nothing in the repo could establish, so nobody could tell a true one from a
// false one. The cure is to make the claim EXECUTABLE, not to write it more
// carefully.
//
// It is deliberately NOT wired into `bun run check` or CI.
// `src/__tests__/radioStations.test.ts` already states the reason and it is the
// right one: a gate that fetches somafm.com is a third-party outage detector
// bolted onto our build, and it goes red on days when nothing of ours is
// broken. This runs on demand — `bun run check:radio` — and the table's
// moduledoc names it, so the next author edits the table and has a command
// instead of a ritual.
//
// TWO AXES, both reported, union verdict (the `scripts/check.ts` posture):
//
//   REACH  — the URL answers 200 with an `image/*` content type. This is the
//            property the picker needs, and it covers every station including
//            one from another provider. Content type is checked and not just
//            the status because api.somafm.com serves its 404 as `text/html`
//            with a 200-shaped body on some paths; a status-only assert would
//            wave through a soft 404.
//   AGREE  — for a station whose logo we point at somafm, the baked URL is the
//            one `channels.json` ships. Stronger than REACH: it catches a logo
//            that still resolves but is no longer the one upstream publishes,
//            and it is what pins the table to the authority WITHOUT making the
//            running client depend on that authority (see the table's
//            moduledoc for why the fetch stays out of the render path).
//
// The `?v=` cache-buster is stripped before comparing, because the table drops
// it on purpose — a timestamp in a baked URL rots on every re-upload while the
// versionless path keeps serving. That divergence used to live only in a
// comment; here it is executed.
//
// A catalogue that cannot be fetched is a FAILURE, not a pass: "not measured"
// must never read as "measured ok" — that equivalence is the whole bug.

import { RADIO_STATIONS } from "../src/lib/radioStations";

const CATALOGUE_URL = "https://api.somafm.com/channels.json";
const TIMEOUT_MS = 15_000;

type CatalogueChannel = { readonly id: string; readonly image?: string };

/** The catalogue's logo URL for each id, `?v=` stripped, or null when the
    catalogue itself is unreachable — which the caller must not treat as "no
    disagreement found". */
async function fetchCatalogueLogos(): Promise<Map<string, string> | null> {
  try {
    const res = await fetch(CATALOGUE_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      console.error(`catalogue ${CATALOGUE_URL} answered ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { channels?: readonly CatalogueChannel[] };
    const channels = body.channels ?? [];
    return new Map(
      channels.flatMap((c) => (c.image ? [[c.id, c.image.split("?")[0]] as const] : [])),
    );
  } catch (err) {
    console.error(`catalogue ${CATALOGUE_URL} could not be fetched: ${err}`);
    return null;
  }
}

/** `null` when the logo is served as an image; otherwise why it is not. */
async function reachFailure(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const type = res.headers.get("content-type") ?? "(none)";
    if (!res.ok) return `HTTP ${res.status}`;
    if (!type.startsWith("image/")) return `HTTP 200 but content-type ${type}`;
    return null;
  } catch (err) {
    return `${err}`;
  }
}

/** `null` when the baked URL is the catalogue's; otherwise the disagreement.
    Stations pointing at another provider are out of the catalogue's scope and
    answer null — the table is allowed to hold one (see radioStations.ts). */
function agreeFailure(logoUrl: string, id: string, catalogue: Map<string, string>): string | null {
  if (!new URL(logoUrl).host.endsWith("somafm.com")) return null;
  const published = catalogue.get(id);
  // A somafm URL with no catalogue row behind it is exactly the unverifiable
  // claim this script exists to kill, so it fails rather than being skipped.
  if (!published) return `points at somafm but the catalogue has no channel "${id}"`;
  if (published !== logoUrl) return `catalogue ships ${published}`;
  return null;
}

const catalogue = await fetchCatalogueLogos();
if (catalogue === null) {
  console.error("\ncheck:radio — cannot verify the table without the catalogue.");
  process.exit(1);
}

const findings = await Promise.all(
  RADIO_STATIONS.map(async (station) => ({
    id: station.id,
    logoUrl: station.logoUrl,
    reach: await reachFailure(station.logoUrl),
    agree: agreeFailure(station.logoUrl, station.id, catalogue),
  })),
);

for (const f of findings) {
  const problems = [
    f.reach === null ? null : `REACH ${f.reach}`,
    f.agree === null ? null : `AGREE ${f.agree}`,
  ].filter((p) => p !== null);
  const verdict = problems.length === 0 ? "ok  " : "FAIL";
  console.log(`  ${verdict}  ${f.id.padEnd(16)}${f.logoUrl}`);
  for (const p of problems) console.log(`          ${p}`);
}

const broken = findings.filter((f) => f.reach !== null || f.agree !== null);

// The denominator is the honesty payload, as in scripts/check.ts: "14 stations
// checked" is what tells a reader the verdict covers the whole table.
console.log(
  `\ncheck:radio summary — ${findings.length} stations checked, ${broken.length} broken`,
);

process.exit(broken.length === 0 ? 0 : 1);
