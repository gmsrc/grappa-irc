// #1696 — the pure half of the radio-logo probe.
//
// No filesystem, no network, no Bun API. #1836 added the ONE import: the
// table's codec vocabulary, which is data rather than IO and is the same closed
// set the rules below have to be total over — re-spelling it here would be two
// copies of a set that exists to have one. `check-radio-logos.ts`
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

import { RADIO_CODECS, type RadioCodec } from "../src/lib/radioStations";

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

// #1836 — the two claims the table makes about the STREAM: `codec` and
// `bitrate`. Same argument as every axis above, in the field where it bites
// hardest: a baked claim about external state that nothing can check reads
// identically whether it is true or false, and this one decides whether the
// picker draws `[hi-fi]` — i.e. whether somebody on a metered connection is
// told the truth before pressing play.
//
// 🔴 THE CODEC IS READ OFF THE BYTES, NOT OFF THE CONTENT TYPE, and the
// measurement is why. On 2026-08-27 kohina's Ogg VORBIS answered
// `Content-Type: audio/ogg` and radioparadise's Ogg FLAC answered
// `application/ogg`; both are "an Ogg container" and neither names its codec.
// So a content-type check is green in exactly the comparison the badge rests
// on — lossy vs lossless inside one container — which is the "green that means
// silence" this whole file is written against. The bytes separate them in the
// first 32.

/** `\x01vorbis`, `\x7fFLAC` and `OggS` as the servers actually send them —
    read off the wire on 2026-08-27, not copied out of a spec. */
const OGG_PAGE = [0x4f, 0x67, 0x67, 0x53];
const OGG_VORBIS_ID = [0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73];
const OGG_FLAC_ID = [0x7f, 0x46, 0x4c, 0x41, 0x43];
/** `fLaC` — FLAC's OWN framing, outside any Ogg page. Unlike the three above
    this one is UNMEASURED: every FLAC endpoint looked at so far ships inside
    Ogg, and the constant is here because the format defines both framings and a
    row that used the other one would otherwise be reported as unidentifiable
    rather than as flac. Labelled so the next reader knows which of these four
    has an endpoint behind it. */
const NATIVE_FLAC_MAGIC = [0x66, 0x4c, 0x61, 0x43];

function startsWith(head: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, i) => head[i] === byte);
}

function contains(head: Uint8Array, magic: readonly number[]): boolean {
  for (let at = 0; at + magic.length <= head.length; at++) {
    if (magic.every((byte, i) => head[at + i] === byte)) return true;
  }
  return false;
}

/** How each codec announces itself in the first bytes a listener receives.
 *
 * A `Record` over the closed set, so a new codec is a COMPILE error until
 * somebody supplies the bytes that identify it — the same totality
 * `isLossless` buys, and for a sharper reason: a codec with no signature would
 * be permanently unidentifiable, and every row declaring it would go red with
 * no way to tell that from a genuinely wrong claim. */
const CODEC_SIGNATURES: Record<RadioCodec, (head: Uint8Array) => boolean> = {
  // An MPEG frame header: eleven set sync bits at offset ZERO, or a
  // CORROBORATED frame chain anywhere in the head.
  //
  // #1837 — the second arm exists because the first one's premise is a
  // property of the SERVER and not of the codec. "icecast hands a new listener
  // whole frames" held for both mp3 vendors it was measured on, and KNAC's
  // `s6.autopo.st` is a third-party RELAY that hands over whatever its buffer
  // holds: measured over three consecutive connections, its first frame sat at
  // byte 93, 174 and 405. Byte zero keeps its old meaning exactly — a stream
  // that STARTS with a sync is the stream declaring itself, and nothing that
  // was mp3 before stops being mp3. The search is the strictly-additive
  // fallback, and it is deliberately STRICTER than the offset-zero arm rather
  // than looser: see `mpegFrameStart`.
  mp3: (head) => {
    const [first, second] = head;
    if (first === 0xff && second !== undefined && (second & 0xe0) === 0xe0) return true;
    return mpegFrameStart(head) !== null;
  },
  // The container first, then the codec: `OggS` alone is not an answer, and a
  // rule that treated it as one would have called radioparadise's FLAC vorbis.
  vorbis: (head) => startsWith(head, OGG_PAGE) && contains(head, OGG_VORBIS_ID),
  flac: (head) =>
    (startsWith(head, OGG_PAGE) && contains(head, OGG_FLAC_ID)) ||
    startsWith(head, NATIVE_FLAC_MAGIC),
};

/** Which codec these leading bytes are, or `null` when they are none of the
 * ones this table can declare.
 *
 * `null` on AMBIGUITY too, not just on no-match: two signatures agreeing means
 * the rules have gone wrong, and answering with whichever came first would
 * hide that behind a verdict. Downstream a null is a FINDING and never a skip —
 * "not measured" reading as "measured ok" is the equivalence this script
 * exists to break. */
export function identifyCodec(head: Uint8Array): RadioCodec | null {
  const matched = RADIO_CODECS.filter((codec) => CODEC_SIGNATURES[codec](head));
  const [only] = matched;
  return matched.length === 1 && only !== undefined ? only : null;
}

/** `null` when the stream serves the codec the table declares; otherwise the
    disagreement. */
export function codecFailure(declared: RadioCodec, served: RadioCodec | null): string | null {
  if (served === null) {
    return `the first bytes match no codec this table can declare — the claim ${declared} is unverified`;
  }
  if (served !== declared) return `upstream serves ${served}, the table claims ${declared}`;
  return null;
}

/** What upstream says about its own bitrate — THREE states, because collapsing
 * them is the bug.
 *
 * `absent` is a provider that states nothing (measured: kohina's icecast sends
 * `icy-name` and `icy-genre` and no `icy-br`), and it is the state the table's
 * `bitrate: null` exists to agree with. `unreadable` is a header that is there
 * and is not a number: `Number("")` is 0 and `parseInt("128kbps")` is 128, so a
 * two-state parser would turn a value nobody can read into a fact. */
export type UpstreamBitrate =
  | { readonly kind: "absent" }
  | { readonly kind: "kbps"; readonly kbps: number }
  | { readonly kind: "unreadable"; readonly raw: string };

/** The boundary where a third party's free string becomes a number, or is
    refused. Strict on purpose — no trim, no partial parse: `fetch` already
    strips the surrounding whitespace a well-formed header may carry, so
    anything left over is the server saying something this rule should not be
    guessing at. */
export function parseIcyBitrate(header: string | null): UpstreamBitrate {
  if (header === null) return { kind: "absent" };
  if (!/^[1-9][0-9]*$/.test(header)) return { kind: "unreadable", raw: header };
  return { kind: "kbps", kbps: Number(header) };
}

// #1836 (ruling, 2026-08-27) — WHERE A BITRATE IS READ FROM, per codec.
//
// The ruling: `bitrate` is valued from the STREAM ITSELF and `null` is
// reserved for "not knowable", never for "the provider said nothing". It rests
// on this work's own reggae measurement, which showed that a string a vendor
// puts in a URL is a LABEL rather than a declaration.
//
// 🔴 IT DOES NOT GENERALISE TO "the frame header", and the refusal is measured
// rather than argued. FLAC's STREAMINFO — decoded from radioparadise's own
// first bytes on 2026-08-27 — carries min/max blocksize, sample rate (44100),
// channels (2), bits per sample (16) and a `minframesize/maxframesize` of
// 0/0 (= unknown). There is NO bitrate field, because FLAC is inherently
// variable-rate. Under a frame-header-only rule every FLAC row would be
// `null`, i.e. the rows the `[hi-fi]` badge exists for would show no cost at
// all — the opposite of what the issue asked for. And computing one from the
// PCM rate (44100 × 2 × 16 = 1411 kbps) would OVERSTATE it: FLAC compresses
// well below PCM, so that is an invented plausible number, the very defect
// #1696 names.
//
// 🔴 The premise also needs one correction. On reggae the URL said 128, the
// frame header said 160 and `icy-br` said 160 — so what that measurement
// convicted is the URL, and it ACQUITS `icy-br`, which agreed with the bytes.
// `icy-br` is not a label somebody stuck on the stream; it is the origin
// server restating its encoder configuration on every connection.
//
// So: a per-codec AUTHORITY, total over the union, with the provenance DERIVED
// from the codec rather than stored beside each row — the codec is already a
// field, and a second column repeating what it implies is the parallel
// structure CLAUDE.md's design discipline says to derive instead.
export type BitrateSource = "mpeg-frame" | "vorbis-nominal" | "icy-br";

/** An upstream bitrate together with which authority produced it. */
export type BitrateReading = UpstreamBitrate & { readonly source: BitrateSource };

/** MPEG1 Layer III, the only frame shape decoded here. Index 0 is "free" and
    15 is "reserved"; both mean the header is not stating a rate. */
const MPEG1_LAYER3_KBPS: readonly (number | null)[] = [
  null, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, null,
];

/** MPEG1 sampling rates, in the order the header's two-bit index spells them.
    Index 3 is reserved; the frame length needs the rate, so a reserved one is
    a header this decoder will not read. */
const MPEG1_SAMPLE_RATES: readonly (number | null)[] = [44100, 48000, 32000, null];

/** One MPEG1 Layer III frame header, decoded — the kbps it states and how many
    bytes the whole frame occupies, which is what lets the next one be found. */
type MpegFrame = { readonly kbps: number; readonly bytes: number };

/** The frame these four bytes are, or `null` when they are not one. */
function mpegFrameAt(head: Uint8Array, at: number): MpegFrame | null {
  const first = head[at];
  const second = head[at + 1];
  const third = head[at + 2];
  if (first === undefined || second === undefined || third === undefined) return null;
  if (first !== 0xff || (second & 0xe0) !== 0xe0) return null;
  // Version and layer are CHECKED, not assumed: MPEG2/2.5 and Layers I/II have
  // different bitrate tables, so decoding one of those against this one would
  // produce a confident wrong number — the single worst outcome for a field
  // whose whole purpose is to be true. Measured 2026-08-27: every mp3 row in
  // the table is MPEG1 Layer III (`ff fb ..`).
  if (((second >> 3) & 0x03) !== 0x03 || ((second >> 1) & 0x03) !== 0x01) return null;
  const kbps = MPEG1_LAYER3_KBPS[third >> 4];
  const rate = MPEG1_SAMPLE_RATES[(third >> 2) & 0x03];
  if (kbps === null || kbps === undefined || rate === null || rate === undefined) return null;
  return { kbps, bytes: Math.floor((144 * kbps * 1000) / rate) + ((third >> 1) & 0x01) };
}

/** #1837 — the first MPEG1 Layer III frame in `head`, wherever it starts, or
 * `null` when there is none this decoder will stand behind.
 *
 * WHY A SEARCH. A listener does not always arrive on a frame boundary. Measured
 * 2026-08-27 on KNAC's `s6.autopo.st`, a third-party relay rather than an
 * origin icecast: three consecutive connections put the first frame at byte 93,
 * 174 and 405 — the relay hands over its buffer wherever it happens to be. Both
 * axes that read these bytes were reading the tail of a frame nobody sent the
 * start of, and reporting a row whose claim is true as unverified.
 *
 * WHY A CHAIN AND NOT A SYNC. Eleven set bits plus a plausible byte occur in
 * compressed audio by chance — the offset-zero rule this supplements says so,
 * and it is right. So a candidate counts only when the frame length it states
 * lands the NEXT sync exactly where it should. Two headers agreeing on a
 * computed offset is roughly one in 10^9 per position, against one in 10^5 for
 * a lone sync: the search is stricter than what it falls back from, not looser.
 *
 * A candidate too late in `head` for its successor to fit is REFUSED rather
 * than trusted uncorroborated. That cannot bite a real stream: frames are
 * contiguous, so the first one starts within one frame length of the head, and
 * the probe reads far more than two frames' worth. */
function mpegFrameStart(head: Uint8Array): (MpegFrame & { readonly at: number }) | null {
  for (let at = 0; at + 4 <= head.length; at++) {
    const frame = mpegFrameAt(head, at);
    if (frame === null) continue;
    if (at === 0 && mpegFrameAt(head, frame.bytes) === null) {
      // Offset zero is the one place a single header is evidence: the stream
      // BEGINS there, so it is not a byte pair met while scanning a payload.
      // Kept so the fixtures #1836 measured — a few dozen bytes off the wire,
      // one frame long — keep reading as the streams they were taken from.
      return { ...frame, at };
    }
    if (mpegFrameAt(head, at + frame.bytes) !== null) return { ...frame, at };
  }
  return null;
}

/** The kbps the stream's own frames state, or a reason they do not. */
export function mpegFrameBitrate(head: Uint8Array): UpstreamBitrate {
  const frame = mpegFrameStart(head);
  if (frame !== null) return { kind: "kbps", kbps: frame.kbps };
  return { kind: "unreadable", raw: mpegFrameComplaint(head) };
}

/** Why no frame was read, in the most specific terms the bytes support.
 *
 * A header sitting at offset zero gets diagnosed field by field, because that
 * is the case a reader can act on — "MPEG version bits 3, layer bits 1" names
 * a stream this table cannot declare, while "nothing found" would send the
 * same reader hunting for a network fault. */
function mpegFrameComplaint(head: Uint8Array): string {
  const first = head[0];
  const second = head[1];
  const third = head[2];
  if (first === undefined || second === undefined || third === undefined) {
    return "fewer than 3 bytes of stream";
  }
  if (first !== 0xff || (second & 0xe0) !== 0xe0) {
    return `no corroborated MPEG1 Layer III frame in the first ${head.length} bytes`;
  }
  const version = (second >> 3) & 0x03;
  const layer = (second >> 1) & 0x03;
  if (version !== 0x03 || layer !== 0x01) {
    return `MPEG version bits ${version}, layer bits ${layer}`;
  }
  if (MPEG1_SAMPLE_RATES[(third >> 2) & 0x03] === null) {
    return `MPEG sample-rate index ${(third >> 2) & 0x03}`;
  }
  return `MPEG bitrate index ${third >> 4}`;
}

/** The kbps an Ogg Vorbis identification header NOMINATES, or `absent`.
 *
 * Vorbis states its own rate inside the codec stream — `bitrate_nominal`, a
 * signed 32-bit little-endian bits-per-second — so this is the stream speaking
 * about itself, exactly what the ruling asks for. Measured on kohina
 * 2026-08-27: nominal 128000, max 0, min 0.
 *
 * A nominal of 0 is LEGAL and means the encoder ran in pure quality mode and
 * nominated nothing. That is `absent`, not zero: it is the one Vorbis shape
 * where a row honestly cannot state a number. */
export function vorbisNominalBitrate(head: Uint8Array): UpstreamBitrate {
  const magic = [0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73];
  for (let at = 0; at + magic.length <= head.length; at++) {
    if (!magic.every((byte, i) => head[at + i] === byte)) continue;
    // packet type + "vorbis" (7) + version (4) + channels (1) + rate (4) = 16
    const off = at + 16;
    const bytes = [head[off + 4], head[off + 5], head[off + 6], head[off + 7]];
    if (bytes.some((b) => b === undefined)) {
      return { kind: "unreadable", raw: "identification header cut short" };
    }
    const nominal = new DataView(
      Uint8Array.from(bytes as number[]).buffer,
    ).getInt32(0, true);
    if (nominal <= 0) return { kind: "absent" };
    return { kind: "kbps", kbps: Math.round(nominal / 1000) };
  }
  return { kind: "unreadable", raw: "no vorbis identification header in the first bytes" };
}

/** Which authority speaks for each codec. A `Record`, so a codec cannot be
 * added without somebody deciding where its bitrate comes from — the same
 * totality `isLossless` and the byte signatures carry.
 *
 * `flac` is `icy-br` and that is the measured exception, not laziness: see the
 * block comment above. */
const CODEC_BITRATE_AUTHORITY: Record<
  RadioCodec,
  (head: Uint8Array, icyBr: string | null) => BitrateReading
> = {
  mp3: (head) => ({ ...mpegFrameBitrate(head), source: "mpeg-frame" }),
  vorbis: (head) => ({ ...vorbisNominalBitrate(head), source: "vorbis-nominal" }),
  flac: (_head, icyBr) => ({ ...parseIcyBitrate(icyBr), source: "icy-br" }),
};

/** What the stream says its own bitrate is, read by the authority its codec
    supports. Keyed on the codec the bytes turned out to BE, never on the one
    the table claims — a row lying about its codec is already red on CODEC, and
    asking the wrong decoder would add a second, misleading finding. */
export function readBitrate(
  served: RadioCodec,
  head: Uint8Array,
  icyBr: string | null,
): BitrateReading {
  return CODEC_BITRATE_AUTHORITY[served](head, icyBr);
}

/** `null` when the table's bitrate claim matches what upstream declares —
 * INCLUDING when both say nothing.
 *
 * Both directions are failures. A number the table invented over a silent
 * provider is #1696's defect exactly (an unverifiable claim baked as fact); a
 * number the table dropped over a provider that states one is the opposite and
 * just as wrong, because the picker then draws no cost for a station that has
 * one. */
export function bitrateFailure(declared: number | null, reading: BitrateReading): string | null {
  const from = reading.source;
  if (reading.kind === "unreadable") {
    return `${from} reads ${JSON.stringify(reading.raw)}, which is not a bitrate`;
  }
  if (reading.kind === "absent") {
    return declared === null ? null : `${from} states no bitrate, the table claims ${declared} kbps`;
  }
  if (declared === null) return `${from} says ${reading.kbps} kbps, the table claims none`;
  if (declared !== reading.kbps) {
    return `${from} says ${reading.kbps} kbps, the table claims ${declared} kbps`;
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
  /** #1836 — the station's stream. Not nullable, unlike its two siblings: a
      station without one is not a station. Carried for the reason `feedUrl`
      gives — a row now names THREE third-party URLs, and a report that prints
      one leaves the reader guessing which of them an axis is talking about. */
  readonly streamUrl: string;
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
  /** #1836 — the STREAM axis: whether the endless audio endpoint answers at
      all. Its own axis rather than folded into the two below, because "the
      connection was refused" and "the codec is not what you claim" are
      different facts and a report that spells the first under the second name
      sends the reader to edit the table. */
  readonly stream: string | null;
  /** #1836 — the CODEC axis, read off the first bytes upstream sends. Null
      when STREAM already failed: nothing was compared, and reporting one dead
      connection twice under two names is the double-count BYTES already
      refuses. */
  readonly codec: string | null;
  /** #1836 — the BITRATE axis, `icy-br` against the declared kbps, in both
      directions. Null when STREAM already failed, for the same reason. */
  readonly bitrate: string | null;
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
  readonly streams: number;
} {
  return {
    logos: findings.filter((f) => f.logoUrl !== null).length,
    feeds: findings.filter((f) => f.feedUrl !== null).length,
    // #1836 — a FOURTH denominator, on the same argument as `mirrored`: every
    // row has a stream URL, so the count that means anything is how many
    // streams actually OPENED. A run where every connection timed out compares
    // no codec and no bitrate, and "22 stations checked, 0 broken" would read
    // as agreement with claims nothing looked at.
    streams: findings.filter((f) => f.stream === null).length,
    // #1739 — a THIRD denominator, and deliberately not the same number as
    // `logos`: BYTES can only compare a payload it managed to fetch, so a run
    // where every logo timed out would print "21 with a logo, 0 broken" having
    // compared nothing at all. A `mirrored` below `logos` says the comparison
    // did not happen, which is a different fact from "it agreed".
    mirrored: findings.filter((f) => f.logoUrl !== null && f.reach === null).length,
  };
}

/** Every problem found for one station, all seven axes, in report order. */
export function problems(finding: StationFinding): readonly string[] {
  return [
    finding.reach === null ? null : `REACH ${finding.reach}`,
    finding.agree === null ? null : `AGREE ${finding.agree}`,
    finding.feed === null ? null : `FEED ${finding.feed}`,
    finding.bytes === null ? null : `BYTES ${finding.bytes}`,
    finding.stream === null ? null : `STREAM ${finding.stream}`,
    finding.codec === null ? null : `CODEC ${finding.codec}`,
    finding.bitrate === null ? null : `BITRATE ${finding.bitrate}`,
  ].filter((p): p is string => p !== null);
}

/** A station is broken if ANY axis has something to say — the union
    verdict, the `scripts/check.ts` posture. */
export function brokenCount(findings: readonly StationFinding[]): number {
  return findings.filter((f) => problems(f).length > 0).length;
}
