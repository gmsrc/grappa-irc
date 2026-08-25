// #1696 — the pure half of the radio-logo probe.
//
// No filesystem, no network, no Bun API, no imports. `check-radio-logos.ts`
// does the IO and calls in here; `src/__tests__/checkRadioLogos.test.ts`
// exercises both sides of every rule. This is the `lock-drift-core.ts` split
// and it exists for the same measured reason: `cicchetto/scripts/` is outside
// the tsconfig `include` AND outside biome's `files.includes`, so a
// runner-only module is checked by NOTHING. Keeping the rules importable from
// `src` is what puts them under `tsc --noEmit`.
//
// That is not a hypothetical here. Written as a runner-only file, this module's
// `?v=` strip read `image.split("?")[0]` and typechecked fine under bun — under
// the project's `noUncheckedIndexedAccess` it is `string | undefined`, i.e. the
// exact silent-`undefined` class the strict flag exists to catch. The probe
// that exists to stop unverifiable claims was itself unverified.
//
// The second reason is vacuity. AGREE skips stations that point at another
// provider, so a rule inverted by one edit skips EVERY station and the script
// reports "0 broken" having compared nothing — a green that means silence. The
// test file holds a positive control against the real table for that.

/** The shape `channels.json` gives us. Everything is optional on purpose: this
    is a third party's document and a missing field must degrade to a finding,
    never to a crash. */
export type CatalogueChannel = { readonly id?: string; readonly image?: string };
export type CatalogueBody = { readonly channels?: readonly CatalogueChannel[] };

/** Drop the `?v=` cache-buster. The table bakes the versionless path on
    purpose — a timestamp in a stored URL rots on the next re-upload, while the
    versionless path keeps serving — so the comparison must strip it or every
    station would read as a disagreement. */
export function versionless(url: string): string {
  return url.split("?")[0] ?? url;
}

/** id → the catalogue's logo URL, `?v=` stripped. Channels missing an id or an
    image are dropped rather than half-entered: a station whose row is absent is
    reported by `agreeFailure` as a finding, which is the honest outcome, and a
    half-entry would instead read as agreement with an empty string. */
export function catalogueLogos(body: CatalogueBody): Map<string, string> {
  const entries = (body.channels ?? []).flatMap((c) =>
    c.id !== undefined && c.image !== undefined
      ? ([[c.id, versionless(c.image)]] as const)
      : ([] as const),
  );
  return new Map(entries);
}

/** `null` when the response is a served resource of the `expected` type;
    otherwise why it is not.
    Content type is checked and not just the status because api.somafm.com
    answers some paths with a 200-shaped `text/html` body — a status-only
    assert would wave a soft 404 straight through, and a soft 404 is exactly
    the failure this probe was written to catch.
    #1698 — `expected` is a PARAMETER because the table now bakes two kinds of
    third-party URL: a logo (`image/`) and a now-playing feed
    (`application/json`). One predicate rather than a near-copy, and the
    message names what was WANTED because otherwise the two axes report the
    identical sentence for opposite defects. */
export function reachFailure(
  status: number,
  contentType: string | null,
  expected: string,
): string | null {
  if (status < 200 || status >= 300) return `HTTP ${status}`;
  const type = contentType ?? "(none)";
  if (!type.startsWith(expected)) {
    return `HTTP ${status} but content-type ${type} (wanted ${expected})`;
  }
  return null;
}

/** The content types each axis demands. Named rather than spelled at the call
    sites so the runner and its tests cannot drift apart on the string. */
export const LOGO_CONTENT_TYPE = "image/";
export const FEED_CONTENT_TYPE = "application/json";

/** Whether AGREE has anything to say about this station. A station pointing at
    another provider is outside the catalogue's scope — the table is allowed to
    hold one. Exported so the test can assert the axis is NOT vacuous over the
    real table; a green built from zero comparisons is silence, not agreement.
    #1704 — `null` (the station publishes NO logo) is outside that scope too,
    and for a stronger reason than a foreign provider: there is no URL for the
    catalogue to disagree with. */
export function isCatalogueBacked(logoUrl: string | null): boolean {
  return logoUrl !== null && new URL(logoUrl).host.endsWith("somafm.com");
}

/** `null` when the baked URL is the one the catalogue publishes; otherwise the
    disagreement, spelled so the reader can paste the fix straight in. */
export function agreeFailure(
  logoUrl: string | null,
  id: string,
  catalogue: ReadonlyMap<string, string>,
): string | null {
  if (!isCatalogueBacked(logoUrl)) return null;
  const published = catalogue.get(id);
  // A somafm URL with no catalogue row behind it is precisely the unverifiable
  // claim this probe exists to kill, so it is a finding rather than a skip.
  if (published === undefined) return `points at somafm but the catalogue has no channel "${id}"`;
  if (published !== logoUrl) return `catalogue ships ${published}`;
  return null;
}

/** `null` when the vendored mirror holds exactly the bytes upstream serves;
 * otherwise how they differ, spelled with the verb that fixes it.
 *
 * #1739 — THE ONE THING VENDORING GAVE UP, made detectable. vjt's ruling took
 * the mirror over a caching proxy knowing the trade: a proxy with a 4h TTL
 * would pick up a re-uploaded logo on its own, while a mirror is refreshed by
 * a human running `bun run sync:radio-logos`. Without this axis a logo that
 * changed upstream would simply never be noticed — the picker would keep
 * drawing last month's artwork and every other axis would stay green, because
 * the URL still resolves and still agrees with the catalogue.
 *
 * THE WHOLE PAYLOAD, not `Content-Length`. A re-upload usually keeps the
 * dimensions and therefore roughly the size, so a length compare is the check
 * that passes in exactly the case it exists for. The lengths are still compared
 * FIRST, because that is the cheap discriminator and it is the one that gives
 * the reader two numbers instead of an offset.
 *
 * `vendored === null` — nothing on disk — is a finding rather than a skip: a
 * table row with no mirrored file behind it is the unverifiable claim this
 * whole probe exists to kill, and `radioLogoFiles.test.ts` failing on it too is
 * not a reason for this to stay quiet. The operator running THIS is the one
 * editing the table. */
export function bytesFailure(upstream: Uint8Array, vendored: Uint8Array | null): string | null {
  const cure = "re-run `bun run sync:radio-logos`";
  if (vendored === null) return `upstream serves it, the mirror holds nothing — ${cure}`;
  if (vendored.byteLength !== upstream.byteLength) {
    return `upstream is ${upstream.byteLength} bytes, the mirror holds ${vendored.byteLength} bytes — ${cure}`;
  }
  for (let i = 0; i < upstream.byteLength; i++) {
    if (upstream[i] !== vendored[i]) {
      return `same length, different payload (first difference at byte ${i}) — ${cure}`;
    }
  }
  return null;
}

export type StationFinding = {
  readonly id: string;
  /** #1704 — the station's logo, or `null` when it publishes none. Carried as
      a null rather than an empty string for the reason `feedUrl` below gives:
      the report has to be able to print a SKIPPED row as skipped, and an empty
      string reads as a probed URL that happened to be blank. */
  readonly logoUrl: string | null;
  /** #1698 — the station's now-playing feed, or null when it publishes none.
      Carried so the report line can name the URL that failed, and so a null
      row is visibly SKIPPED rather than silently absent. */
  readonly feedUrl: string | null;
  readonly reach: string | null;
  readonly agree: string | null;
  /** #1698 — the FEED axis: whether `feedUrl` answers with JSON. Always null
      for a station that publishes no feed — that is not a defect, and
      reporting it as one would make the table's nullable field permanently
      red. */
  readonly feed: string | null;
  /** #1739 — the BYTES axis: whether `public/radio-logos/` still holds what
      upstream serves. Null for a station that publishes no logo (there is
      nothing upstream to compare, and the generated tile's freshness is the
      offline gate's job), and null when REACH already failed — one dead fetch
      must be reported once, not counted twice under two names. */
  readonly bytes: string | null;
};

/** How many of `findings` were actually PROBED on each axis.
 *
 * #1704 — the denominator, and it exists because both `logoUrl` and `feedUrl`
 * are nullable now: "21 stations checked, 0 broken" says nothing about how
 * many logos were fetched, and on a table where the field had gone uniformly
 * null it would report a perfect green having probed nothing. Same vacuity
 * argument `isCatalogueBacked` is exported for. */
export function probedCounts(findings: readonly StationFinding[]): {
  readonly logos: number;
  readonly feeds: number;
  readonly mirrored: number;
} {
  return {
    logos: findings.filter((f) => f.logoUrl !== null).length,
    feeds: findings.filter((f) => f.feedUrl !== null).length,
    // #1739 — a THIRD denominator, and deliberately not the same number as
    // `logos`: BYTES can only compare a payload it managed to fetch, so a run
    // where every logo timed out would print "21 with a logo, 0 broken" having
    // compared nothing at all. A `mirrored` below `logos` says the comparison
    // did not happen, which is a different fact from "it agreed".
    mirrored: findings.filter((f) => f.logoUrl !== null && f.reach === null).length,
  };
}

/** Every problem found for one station, all four axes, in report order. */
export function problems(finding: StationFinding): readonly string[] {
  return [
    finding.reach === null ? null : `REACH ${finding.reach}`,
    finding.agree === null ? null : `AGREE ${finding.agree}`,
    finding.feed === null ? null : `FEED ${finding.feed}`,
    finding.bytes === null ? null : `BYTES ${finding.bytes}`,
  ].filter((p): p is string => p !== null);
}

/** A station is broken if ANY axis has something to say — the union
    verdict, the `scripts/check.ts` posture. */
export function brokenCount(findings: readonly StationFinding[]): number {
  return findings.filter((f) => problems(f).length > 0).length;
}
