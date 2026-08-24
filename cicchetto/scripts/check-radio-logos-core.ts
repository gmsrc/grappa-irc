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

/** `null` when the response is a served image; otherwise why it is not.
    Content type is checked and not just the status because api.somafm.com
    answers some paths with a 200-shaped `text/html` body — a status-only
    assert would wave a soft 404 straight through, and a soft 404 is exactly
    the failure this probe was written to catch. */
export function reachFailure(status: number, contentType: string | null): string | null {
  if (status < 200 || status >= 300) return `HTTP ${status}`;
  const type = contentType ?? "(none)";
  if (!type.startsWith("image/")) return `HTTP ${status} but content-type ${type}`;
  return null;
}

/** Whether AGREE has anything to say about this station. A station pointing at
    another provider is outside the catalogue's scope — the table is allowed to
    hold one. Exported so the test can assert the axis is NOT vacuous over the
    real table; a green built from zero comparisons is silence, not agreement. */
export function isCatalogueBacked(logoUrl: string): boolean {
  return new URL(logoUrl).host.endsWith("somafm.com");
}

/** `null` when the baked URL is the one the catalogue publishes; otherwise the
    disagreement, spelled so the reader can paste the fix straight in. */
export function agreeFailure(
  logoUrl: string,
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

export type StationFinding = {
  readonly id: string;
  readonly logoUrl: string;
  readonly reach: string | null;
  readonly agree: string | null;
};

/** Every problem found for one station, both axes, in report order. */
export function problems(finding: StationFinding): readonly string[] {
  return [
    finding.reach === null ? null : `REACH ${finding.reach}`,
    finding.agree === null ? null : `AGREE ${finding.agree}`,
  ].filter((p): p is string => p !== null);
}

/** A station is broken if EITHER axis has something to say — the union
    verdict, the `scripts/check.ts` posture. */
export function brokenCount(findings: readonly StationFinding[]): number {
  return findings.filter((f) => problems(f).length > 0).length;
}
