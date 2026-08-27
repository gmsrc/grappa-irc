// #682 — the curated internet-radio station list.
//
// WHY A BAKED-IN TABLE AND NOT A LIVE CATALOGUE. SomaFM publishes its whole
// catalogue at `https://api.somafm.com/channels.json` (46 channels, with genre,
// listener counts and a `lastPlaying` track name), it answers
// `Access-Control-Allow-Origin: *`, and since #1695 our own `connect-src`
// (GrappaWeb.Plugs.SecurityHeaders) admits `api.somafm.com`. A live fetch is
// therefore POSSIBLE now, and the reason this table exists is no longer the one
// #682 wrote here — that reason was our CSP, and it is spent. The reasons that
// survive #1696, in the order that decides it:
//
//   * The list is CURATED: 46 channels upstream, 14 here. Whatever a render
//     path reads, the CHOICE of rows is ours and stays in this file.
//   * `logoUrl` cannot leave the type. A station from another provider has no
//     row in SomaFM's catalogue and must still carry a logo — this is a table
//     of stations, not a table of SomaFM slugs. So reading `image` at runtime
//     would not REPLACE the baked field, it would stack a second source on top
//     of it and split ONE record across two authorities field by field. That
//     is more housekeeping than it removes, not less.
//   * The failure that filed #1696 was NOT upstream drift, measured
//     2026-08-24: every `.jpg` this table got wrong carries a `?v=` upload
//     stamp of 2026-06-12 or earlier — three of them from 2023 — while the
//     table was written 2026-08-23. Nothing moved under us. The claim further
//     down was simply never checked. A runtime read is the cure for drift, and
//     drift is not what happened.
//   * A cosmetic pixel is a thin reason to put a third party in the render
//     path. The picker renders from a constant and awaits nothing today.
//
// So the catalogue IS the authority for these URLs, and `bun run check:radio`
// consults it at CHECK time rather than at RENDER time. That buys the pinning
// without buying a runtime failure mode: when somafm is unreachable the picker
// still draws the logos it drew yesterday.
//
// What needs NO server change, and is why this works at all:
//   * `media-src 'self' blob: https:` already admits the <audio> stream —
//     #607 widened it for this very mini-player.
//   * `img-src 'self' data: https:` already admits the logos (#1240), because
//     an <img> is governed by img-src and not by connect-src.
//
// WHY THE STREAM URL IS SAFE TO BAKE. The `.pls` for a channel lists THREE
// rotating hosts (ice2 / ice5 / ice6), which looks like exactly the kind of
// detail a hardcoded table gets wrong. Measured, it is not: the UNNUMBERED
// `ice.somafm.com` also answers, serving `audio/mpeg` with the channel's
// `icy-name` — it is the stable front door, and ice1..ice6 are the pool
// behind it. Every entry below was fetched through it and returned real MPEG
// audio on 2026-08-23.
//
// THE LOGO URL IS NOT DERIVED, IT IS COPIED — and `bun run check:radio` is what
// says so truthfully. The `<id>120.png` shape this table used to spell only
// LOOKED like a convention: the extension is per-station AND per-size
// (`dronezone120.jpg` at 120px, `dronezone256.png` at 256px), and there is no
// extension-free form to fall back on — `…/logos/120/dronezone120` is a 404.
// Every logo URL here is therefore a verbatim copy of a catalogue value, minus
// the `?v=` cache-buster the catalogue spells and we drop on purpose (a
// timestamp baked into a URL rots on the next re-upload; the versionless path
// keeps serving). Run the script when you touch this table — it checks both
// reachability and agreement with the catalogue, and it is out of CI
// deliberately, for the reason its own header gives.
//
// ⚠️ The STREAM half of that claim used to be hand-measured and is not any
// more (#1836). It stayed out because `HEAD` on `ice.somafm.com` returns an
// empty reply (curl exit 52) — icecast answers a GET with an endless body, so a
// stream needs an ABORTED fetch, a different mechanism from the logo probe.
// That mechanism is now written down: `check:radio` opens each stream, reads
// the first bytes it sends and hangs up. Two claims ride on it — `codec` and
// `bitrate` below — and the argument for making them executable is #1696's own:
// a baked claim about external state that nothing can check reads identically
// whether it is true or false.
//
// The list is CURATED, not user-editable. A user-editable list is user state
// and would want `lib/displayPrefs.ts` treatment (server-backed + synced,
// #449) rather than a localStorage list that dies per device — a different
// piece of work, deliberately out of this one.
//
// Fields are stored, not derived from `id`. Deriving the stream URL from the
// id would template SomaFM's naming convention into the type and break the
// first entry that is not a SomaFM channel; this is a table of stations, not
// a table of SomaFM slugs.

/** #1835 — WHERE a station's now-playing fact comes from, and in WHOSE shape.
 *
 * A CLOSED set of literals rather than a free string, per CLAUDE.md: the reader
 * is picked by `kind`, and `parseNowPlayingFeed`'s `assertNever` turns a new
 * vendor added here without an arm there into a compile error rather than a
 * station that silently reads `unanswered` forever.
 *
 * This replaced a bare `songsUrl: string | null`, which encoded ONE vendor's
 * document shape in a field name and left every other provider with no way to
 * say "I publish this, in my own format". Kohina is the row that showed it: it
 * landed as `unsupported` with a muted band while its icecast has been
 * publishing a title all along.
 *
 * The URL is COPIED, never templated from `id` — the rule `logoUrl` states
 * above, for the same reason.
 */
export type NowPlayingSource =
  /** SomaFM's `…/songs/<id>.json`: `songs[0]` is the current track, already
      SPLIT into title / artist / album by the provider. */
  | { readonly kind: "somafm"; readonly url: string }
  /** An Icecast `status-json.xsl` document. Renders ONE OPAQUE LINE and
      deliberately no artist — see `parseIcecastStatus`.
      `mount` is icecast's OWN mount path and is NOT derivable from `streamUrl`:
      measured on Kohina 2026-08-27, the document's `listenurl` reads
      `http://localhost:8000/stream.ogg` (the icecast sits behind a reverse
      proxy that does not rewrite it) while we stream from
      `https://kohina.brona.dk/icecast/stream.ogg`. Neither host, scheme nor
      path prefix agree, so the mount is a copied value like every other URL in
      this table — and it is load-bearing, because one status document serves
      every mount the server carries. */
  | { readonly kind: "icecast-status"; readonly url: string; readonly mount: string };

/** #1836 — every codec this table is allowed to declare.
 *
 * A CLOSED SET and not a free string, for the reason CLAUDE.md gives for every
 * closed set: a typo in a free string is a row that renders "mp4" forever and
 * fails nowhere. The members are the ones the table actually serves today
 * (`mp3`, `vorbis`) plus `flac`, which is what the `[hi-fi]` badge exists FOR —
 * the badge is a PRECONDITION for the FLAC stations rather than a follow-up, so
 * the type can say lossless before any row does.
 *
 * Deliberately NOT a superset of what an ircd-shaped listener might one day
 * meet: `aac` and `opus` are real and no row streams them, and a member nothing
 * exercises is a signature in `check-radio-logos-core.ts` that no measurement
 * stands behind. They go in with the first row that needs one, alongside the
 * bytes measured off that row's stream.
 *
 * The LIST is the source and the union is derived from it, not the other way
 * round: `check-radio-logos-core.ts` has to walk every codec to identify one
 * off a stream's bytes, and a hand-written union would have forced a second
 * hand-written array beside it — two spellings of one closed set, free to
 * drift, which is the thing a closed set exists to prevent. */
export const RADIO_CODECS = ["mp3", "vorbis", "flac"] as const;

export type RadioCodec = (typeof RADIO_CODECS)[number];

/** Whether a codec keeps every sample it was handed.
 *
 * A RECORD and not a `switch` or an "is it in this array" test: `Record<
 * RadioCodec, …>` makes a new member of the union above a COMPILE error until
 * somebody classifies it, which is the only version of this that cannot drift.
 * A missing arm would otherwise default to lossy and the next lossless codec
 * would ship silently un-badged.
 *
 * This is also the ONLY thing that decides a badge. Keying it on a list of
 * station names — the obvious shortcut while FLAC means "the radioparadise
 * rows" — is right for exactly the rows somebody remembered and silently wrong
 * for the next one added. */
const CODEC_IS_LOSSLESS: Record<RadioCodec, boolean> = {
  mp3: false,
  vorbis: false,
  flac: true,
};

export function isLossless(codec: RadioCodec): boolean {
  return CODEC_IS_LOSSLESS[codec];
}

/** One tunable station. All URLs must be https — the CSP tokens that admit
    them (`media-src https:`, `img-src https:`) are scheme-scoped, and an http
    stream on an https page is refused as mixed content anyway. */
export type RadioStation = {
  /** Stable slug. Keys the list and the per-row test ids; never displayed. */
  readonly id: string;
  readonly title: string;
  /** Zero or more genre tags, already split — the catalogue spells them
      pipe-joined, and a display concern should not have to know that. */
  readonly genres: readonly string[];
  readonly description: string;
  /** The endless audio endpoint handed to `playAudio`. */
  readonly streamUrl: string;
  /** #1836 — what that endpoint serves, DECLARED.
      Beside `streamUrl` rather than discovered at render for the reason this
      file's header already argues for every URL here: it is a curated table
      and what a row claims stays OUR choice. Sniffing the codec in the picker
      would mean opening the audio connection before the listener asked for it,
      on every row — the exact opposite of what the picker does today, which is
      draw from a constant and await nothing.
      Checked rather than trusted, at CHECK time: `bun run check:radio` reads
      the first bytes each stream sends and reddens when a row's claim stops
      being true. The bytes and not the content type, measured 2026-08-27,
      because both Ogg codecs answer with an Ogg content type and the one
      comparison the `[hi-fi]` badge rests on is vorbis vs flac. */
  readonly codec: RadioCodec;
  /** #1836 — kbps, or `null` where it is NOT KNOWABLE.
      NULLABLE for the reason `nowPlayingSource` gives above and `logoUrl`
      gives below (that field was `songsUrl` when this was written; #1835
      renamed it and the argument is unchanged), and here it is the whole point
      rather than an accommodation: a plausible number invented to fill the
      column renders as a fact and is a guess — the defect #1696 was filed
      about, one field over. A null draws NO number, not "0k" and not
      "unknown".
      🔴 `null` is NOT "the provider sent no header" (vjt's ruling,
      2026-08-27). The value comes from what the STREAM states about ITSELF,
      and which part of the stream that is depends on the codec: an MPEG frame
      header states a rate exactly, an Ogg Vorbis identification header
      NOMINATES one, and FLAC's STREAMINFO states none at all — so a FLAC row's
      only authority is the server's `icy-br`. `check-radio-logos-core.ts` owns
      that per-codec table (`readBitrate`) together with the measurements
      behind it, and `bun run check:radio` re-derives every row through it.
      Putting `null` on a fact the bytes already hold is the mirror image of an
      invented number and just as false — kohina was exactly that, for an
      hour. */
  readonly bitrate: number | null;
  /** #1704 — the station's own artwork, or `null` when it publishes none.
      NULLABLE since Kohina, and the reasoning is the one `nowPlayingSource`
      gives below rather than a second mechanism: a logo is a thing most stations
      HAVE, so the field stays required-looking for every row that has one —
      but "publishes no artwork" is a real state of the world and the type has
      to be able to say it. The alternative was pointing this at Kohina's
      192px FAVICON, which answers 200 — and that is the shape to refuse: a
      favicon is not a station logo, and because it ANSWERS, no runtime error
      handler would ever notice. An unverifiable claim that cannot even fail
      loudly is exactly what #1696 was filed about.
      What a null draws is `lib/radioLogoPlaceholder.ts` — our own SVG, stable
      per station, per vjt's #1703 ruling. What it hands the OS lock screen is
      NOTHING (`mediaSession.ts` emits an empty `artwork`), which is the same
      answer an upload already gets there and for the same reason: the OS then
      keeps the app icon instead of being handed art that is not the station's.
      `bun run check:radio` reports a null row as SKIPPED rather than passing
      it silently — a green built from zero probes is silence, not agreement. */
  readonly logoUrl: string | null;
  /** #1698 — where the track on air is published, or `null` when the provider
      publishes it NOWHERE a browser can read.
      NULLABLE, unlike every sibling above, and the difference is real rather
      than defensive: a title, a stream and a logo are things every station HAS,
      while a machine-readable now-playing feed is a provider CAPABILITY. A
      required field would force the next station to invent a URL, and an
      invented URL is the unverifiable claim #1696 was filed about.
      #1835 — a DESCRIPTOR rather than a URL, because the second vendor to
      publish a feed did not publish SomaFM's document. `null` now means "no
      readable feed", which is a smaller claim than it used to make: it no
      longer also means "not SomaFM". `bun run check:radio` probes it per kind,
      so the claim stays executable. */
  readonly nowPlayingSource: NowPlayingSource | null;
};

export const RADIO_STATIONS: readonly RadioStation[] = [
  {
    id: "groovesalad",
    title: "Groove Salad",
    genres: ["ambient", "electronic"],
    description: "A nicely chilled plate of ambient/downtempo beats and grooves.",
    streamUrl: "https://ice.somafm.com/groovesalad-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/groovesalad120.png",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/groovesalad.json" },
  },
  {
    id: "dronezone",
    title: "Drone Zone",
    genres: ["ambient"],
    description:
      "Served best chilled, safe with most medications. Atmospheric textures with minimal beats.",
    streamUrl: "https://ice.somafm.com/dronezone-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/dronezone120.jpg",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/dronezone.json" },
  },
  {
    id: "spacestation",
    title: "Space Station Soma",
    genres: ["electronic"],
    description: "Tune in, turn on, space out. Spaced-out ambient and mid-tempo electronica.",
    streamUrl: "https://ice.somafm.com/spacestation-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/spacestation120.jpg",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/spacestation.json" },
  },
  {
    id: "lush",
    title: "Lush",
    genres: ["electronic"],
    description: "Sensuous and mellow female vocals, many with an electronic influence.",
    streamUrl: "https://ice.somafm.com/lush-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/lush120.jpg",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/lush.json" },
  },
  {
    id: "indiepop",
    title: "Indie Pop Rocks!",
    genres: ["alternative", "rock"],
    description: "New and classic favorite indie pop tracks.",
    streamUrl: "https://ice.somafm.com/indiepop-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/indiepop120.jpg",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/indiepop.json" },
  },
  {
    id: "u80s",
    title: "Underground 80s",
    genres: ["alternative", "electronic"],
    description: "Early 80s UK Synthpop and a bit of New Wave.",
    streamUrl: "https://ice.somafm.com/u80s-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/u80s120.png",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/u80s.json" },
  },
  {
    id: "secretagent",
    title: "Secret Agent",
    genres: ["lounge"],
    description:
      "The soundtrack for your stylish, mysterious, dangerous life. For Spies and PIs too!",
    streamUrl: "https://ice.somafm.com/secretagent-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/secretagent120.jpg",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/secretagent.json" },
  },
  {
    id: "defcon",
    title: "DEF CON Radio",
    genres: ["electronic", "specials"],
    description: "Music for Hacking. The DEF CON Year-Round Channel.",
    streamUrl: "https://ice.somafm.com/defcon-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/defcon120.png",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/defcon.json" },
  },
  {
    id: "folkfwd",
    title: "Folk Forward",
    genres: ["folk", "alternative"],
    description: "Indie Folk, Alt-folk and the occasional folk classics. ",
    streamUrl: "https://ice.somafm.com/folkfwd-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/folkfwd120.jpg",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/folkfwd.json" },
  },
  {
    id: "bootliquor",
    title: "Boot Liquor",
    genres: ["americana"],
    description: "Americana Roots music for Cowhands, Cowpokes and Cowtippers",
    streamUrl: "https://ice.somafm.com/bootliquor-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/bootliquor120.jpg",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/bootliquor.json" },
  },
  {
    id: "bossa",
    title: "Bossa Beyond",
    genres: ["bossanova", "world"],
    description: "Silky-smooth, laid-back Brazilian-style rhythms of Bossa Nova, Samba and beyond",
    streamUrl: "https://ice.somafm.com/bossa-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/bossa120.jpg",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/bossa.json" },
  },
  // #1836 — 🔴 160, NOT the 128 its own mount name spells, and this is the row
  // that proved the check-time probe was worth building. The first run of
  // `bun run check:radio` after the two fields landed reddened exactly this one:
  // `ice.somafm.com/reggae-128-mp3` answers `icy-br: 160`, and the payload
  // agrees independently of the server's say-so — the first frame header reads
  // `ff fb a0 04`, MPEG1 Layer III bitrate index 10 = 160 kbps, where every
  // sibling row reads `ff fb 92 ..` = index 9 = 128. `icy-name` differs from the
  // house style too (`SomaFM Reggae: Stuff`), so the mount was very likely
  // rebuilt at a higher rate and kept its old path.
  //
  // DO NOT "correct" this to 128 to match the URL. The mount name is a legacy
  // label, the bytes are the fact, and an offline test asserting the two agree
  // was written for this table and then deleted for exactly this row — see
  // `radioStations.test.ts`.
  {
    id: "reggae",
    title: "Heavyweight Reggae",
    genres: ["reggae"],
    description: "Reggae, Ska, Rocksteady classic and deep tracks.",
    streamUrl: "https://ice.somafm.com/reggae-128-mp3",
    codec: "mp3",
    bitrate: 160,
    logoUrl: "https://api.somafm.com/logos/120/reggae120.png",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/reggae.json" },
  },
  {
    id: "sonicuniverse",
    title: "Sonic Universe",
    genres: ["jazz"],
    description: "Transcending the world of jazz with eclectic, avant-garde takes on tradition.",
    streamUrl: "https://ice.somafm.com/sonicuniverse-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/sonicuniverse120.jpg",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/sonicuniverse.json" },
  },
  {
    id: "missioncontrol",
    title: "Mission Control",
    genres: ["ambient", "electronic"],
    description: "Celebrating NASA and Space Explorers everywhere.",
    streamUrl: "https://ice.somafm.com/missioncontrol-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/missioncontrol120.jpg",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/missioncontrol.json" },
  },
  // #1703 — guitar music. The table above answered "no metal, and one row of
  // rock", and these six are what SomaFM can contribute to that: measured
  // 2026-08-24 against the live catalogue, `metal` is the ONLY metal channel
  // upstream has, so one slot is this provider's ceiling and the rest of the
  // request had to leave SomaFM (see the Rock Antenne row below).
  //
  // ⚠️ The logo extensions below are MIXED and that is not an oversight — it is
  // #1696's defect reproduced in advance if anyone "tidies" them. `metal120`,
  // `poptron120` and `doomed120` are PNG; `seventies120`, `covers120` and
  // `brfm120` are JPG. Every one is a verbatim copy of the catalogue's `image`
  // minus the `?v=` stamp, per the rule the header states, and the negative
  // control was run: `seventies120.png` answers 404. The 120 and 256 sizes are
  // not interchangeable either.
  {
    id: "metal",
    title: "Metal Detector",
    genres: ["metal"],
    description:
      "From black to doom, prog to sludge, thrash to post, stoner to crossover, punk to industrial.",
    streamUrl: "https://ice.somafm.com/metal-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/metal120.png",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/metal.json" },
  },
  {
    id: "seventies",
    title: "Left Coast 70s",
    genres: ["70s", "rock"],
    description: "Mellow album rock from the Seventies. Yacht not required.",
    streamUrl: "https://ice.somafm.com/seventies-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/seventies120.jpg",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/seventies.json" },
  },
  {
    id: "poptron",
    title: "PopTron",
    genres: ["alternative"],
    description: "Electropop and indie dance rock with sparkle and pop.",
    streamUrl: "https://ice.somafm.com/poptron-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/poptron120.png",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/poptron.json" },
  },
  {
    id: "covers",
    title: "Covers",
    genres: ["eclectic"],
    description: "Just covers. Songs you know by artists you don't. We've got you covered.",
    streamUrl: "https://ice.somafm.com/covers-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/covers120.jpg",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/covers.json" },
  },
  {
    id: "brfm",
    title: "Black Rock FM",
    genres: ["eclectic"],
    description: "From the Black Rock Desert playa to the world, year round!",
    streamUrl: "https://ice.somafm.com/brfm-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/brfm120.jpg",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/brfm.json" },
  },
  {
    id: "doomed",
    title: "Doomed",
    genres: ["ambient", "industrial"],
    description: "Where every day is Halloween: dark industrial/ambient music for tortured souls.",
    streamUrl: "https://ice.somafm.com/doomed-128-mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl: "https://api.somafm.com/logos/120/doomed120.png",
    nowPlayingSource: { kind: "somafm", url: "https://api.somafm.com/songs/doomed.json" },
  },
  // #1703 — THE FIRST STATION THAT IS NOT SOMAFM, and the row the issue was
  // actually about. SomaFM publishes exactly one metal channel, so "more than a
  // token amount of metal" cannot be bought from that provider at any price;
  // this is a full-time metal channel rather than a genre tag on a mixed
  // station. Measured 2026-08-24: 200 `audio/mpeg`, `icy-name: ROCK ANTENNE
  // Heavy Metal`, 128 kbps stereo — the same bitrate as the rows above.
  //
  // What changes now that the table is no longer a SomaFM mirror, all three
  // already provided for by the type and none of them requiring a server edit:
  //
  //   * `nowPlayingSource` is null because Rock Antenne publishes no
  //     now-playing feed — probed, not assumed. That is the field's designed
  //     arm (`unsupported`), and it is also what keeps this a pure client
  //     change: `connect-src` names `api.somafm.com` alone, so ANY feed URL
  //     here would have needed a CSP widening. (#1835 has since widened it once
  //     more, for Kohina, and the half of this bullet about `parseSongsFeed`
  //     being unable to read a foreign document is what that issue fixed —
  //     there is now a reader per vendor. Rock Antenne stays null because it
  //     publishes nothing to read, which is the ONLY thing null still claims.)
  //   * `check:radio`'s AGREE axis goes quiet for this row by construction
  //     (`isCatalogueBacked` keys on a somafm logo host) and it stays REACH-only
  //     forever. There is no upstream catalogue to pin it against; naming that
  //     absence beats inventing a comparison that would pass on anything.
  //   * The CSP needs nothing: `media-src 'self' blob: https:` and `img-src
  //     'self' data: https:` are scheme-scoped, not host-scoped, and the front
  //     door's 302 target is https too — so the redirect adds no mixed-content
  //     step.
  //
  // The logo is a content-addressed derivative (`…/<hash>.jpg`) and the hash is
  // LOAD-BEARING: the hash-less form answers 403 and a wrong hash 404, so the
  // URL cannot be shortened the way the `?v=` stamp above is dropped. It is
  // served `cache-control: public, max-age=31536000, immutable`, which is a
  // stronger stability claim than the timestamp query the SomaFM rows strip —
  // an immutable content address does not rot on re-upload, it is simply not
  // the URL a re-upload mints.
  {
    id: "rockantenne-metal",
    title: "ROCK ANTENNE Heavy Metal",
    genres: ["metal", "rock"],
    description: "Heavy metal around the clock, from Bavaria's rock station.",
    streamUrl: "https://stream.rockantenne.de/heavy-metal/stream/mp3",
    codec: "mp3",
    bitrate: 128,
    logoUrl:
      "https://www.rockantenne.de/media/cache/3/version/597/streamlogo_heavymetal_ra-v1.jpg/f1b996498456cb64.jpg",
    nowPlayingSource: null,
  },
  // #1704 — KOHINA, and the first row in this table that publishes no artwork
  // at all. Requested in channel as chiptune / demoscene; measured 2026-08-24
  // before being written, as every row here is.
  //
  // THE URL IS NOT THE ONE REQUESTED, and the reason is ours rather than
  // upstream's. The request was `http://kohina.duckdns.org:8000/stream.ogg`.
  // `media-src 'self' blob: https:` (GrappaWeb.Plugs.SecurityHeaders, re-read
  // 2026-08-24) is SCHEME-scoped, so an http stream on our https page is
  // refused before anything upstream is even consulted — and there is no TLS on
  // that port to switch to. Kohina's own home page links an https playlist
  // whose single line is the mirror baked below. That indirection is why this
  // vendor is deliberately ABSENT from `radioStations.test.ts`'s front-door map:
  // upstream's stable entry point is an `.m3u` document, not a redirecting
  // host, and the map cannot express that shape. Inventing a front door for it
  // would be the unverifiable claim #1696 was filed about.
  //
  // Measured on the URL below, with a ranged GET and a browser UA: HTTP 200,
  // `Content-Type: audio/ogg`, Icecast 2.4.4, `Access-Control-Allow-Origin: *`,
  // `icy-name: Kohina - Old School Game and Demo Music`, 312 KB pulled before
  // the client timeout — the timeout being the evidence the source is endless.
  //
  // THE CODEC, read off the BYTES and not the mime type: the body opens `OggS`
  // then `\x01vorbis`, i.e. Ogg VORBIS at 44.1 kHz stereo — the first row here
  // that is not `audio/mpeg`. Per the vendored caniuse-lite (1.0.30001791),
  // iOS Safari is `y` from 18.4, `a` (partial, and the packed data carries no
  // note text to say partial HOW) from 17.4 through 18.3, and a flat `n` at
  // 17.3 and below. So this row does not play for some population of phones,
  // and #1744 is why it ships anyway: a source the browser refuses now SAYS so
  // on the transport, the rail and the lock screen instead of looking paused.
  //
  // ⚠️ CORRECTION (#1835, measured 2026-08-27). This comment used to end "Kohina
  // has no non-Ogg endpoint, so there is no fallback stream to prefer", and that
  // is FALSE. The status document read for the feed below enumerates THREE
  // mounts, and both siblings answer over our own https front door:
  // `…/icecast/stream.aac` → 200 `audio/aac`, `…/icecast/stream.opus` → 200
  // `audio/webm`. An AAC mount would play on every iOS version the Vorbis note
  // above excludes. Switching the baked `streamUrl` is NOT done here on purpose:
  // it is a codec decision with its own trade (aac carries no in-band Vorbis
  // comments, and #1744's failure surfacing was designed around this row), it
  // belongs to that issue rather than to this one, and a slice that widens a CSP
  // should not also silently move which bytes the operator hears. The false
  // sentence is corrected rather than left standing; acting on it is a separate
  // call.
  //
  // #1835 — `nowPlayingSource` IS NO LONGER NULL, and this row is why the field
  // stopped being a URL. Kohina publishes nothing in SomaFM's shape, so under
  // the old `songsUrl` it could only be null, which rendered as `unsupported`:
  // a muted band and a `/np` that refused, for a station that has been naming
  // its track all along. Measured 2026-08-27 on the URL below: HTTP 200,
  // `application/json`, `Access-Control-Allow-Origin: *`, Icecast 2.4.4.
  // `HEAD` on it answers 400 — it reads with a GET, which is why
  // `check:radio`'s FEED axis needs a per-kind probe and not one shared HEAD.
  //
  // WHY THE LINE IS OPAQUE, and it is the whole design rather than a shortcut.
  // The title is ONE joined string: measured twice on different days,
  // `Hisayoshi Ogura (Zuntata) - The Ninja Warriors - Che! - Arcade` and
  // `Yuzo Koshiro - SOR2 - Good End - Mega Drive` — FOUR segments on `" - "`,
  // spelling `<composer> - <game> - <track> - <platform>`. No split recovers an
  // artist from that, and guessing one is precisely why this module's own
  // header already REFUSED SomaFM's `lastPlaying`. So the row renders a single
  // line with no artist, and the UI says a shorter sentence rather than a wrong
  // one.
  //
  // `logoUrl` is null and that is the field's new arm: kohina.com serves only
  // favicons, the largest being a 192px PNG that answers 200. Pointing this at
  // it was refused twice over — a favicon is not a station logo, and because it
  // ANSWERS no error handler would ever fire, so the wrong image would render
  // silently forever.
  {
    id: "kohina",
    title: "Kohina",
    genres: ["chiptune", "demoscene"],
    description:
      "Hand picked chip tunes from classic computers and consoles. SID, Amiga, Atari ST, Arcade, PC, and more!",
    streamUrl: "https://kohina.brona.dk/icecast/stream.ogg",
    codec: "vorbis",
    // #1836 (ruling, 2026-08-27) — 128, and it was `null` for one wrong hour.
    // This icecast sends NO `icy-br`, and "the provider said nothing" was taken
    // for "we cannot know". It is not: Vorbis states its rate INSIDE the codec
    // stream, and the identification header here reads `bitrate_nominal =
    // 128000` (max 0, min 0, 44100 Hz, 2ch), decoded off the first bytes this
    // mount serves. `null` is reserved for NOT KNOWABLE — putting it on a fact
    // we hold is the mirror image of #1696's invented number, and just as
    // false.
    bitrate: 128,
    logoUrl: null,
    // `mount` is the icecast-internal path, copied off the document's
    // `listenurl` (`http://localhost:8000/stream.ogg`) and NOT derived from
    // `streamUrl` — the proxy prefix `/icecast` is ours, not icecast's.
    nowPlayingSource: {
      kind: "icecast-status",
      url: "https://kohina.brona.dk/icecast/status-json.xsl",
      mount: "/stream.ogg",
    },
  },
];
