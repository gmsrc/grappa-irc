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
// ⚠️ The STREAM half of that claim is still hand-measured and stays that way
// here: `HEAD` on `ice.somafm.com` returns an empty reply (curl exit 52),
// because icecast answers a GET with an endless body — proving a stream needs a
// ranged-or-aborted fetch, a different mechanism from the logo probe.
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
  readonly logoUrl: string;
  /** #1698 — the JSON feed naming the track on air, or `null` when the
      provider publishes none.
      NULLABLE, unlike every sibling above, and the difference is real rather
      than defensive: a title, a stream and a logo are things every station HAS,
      while a machine-readable now-playing feed is a provider CAPABILITY. A
      required field would force the next non-SomaFM station to invent a URL,
      and an invented URL is the unverifiable claim #1696 was filed about.
      COPIED, never templated from `id` — the same rule `logoUrl` states above,
      for the same reason: `id` is our slug, not a SomaFM one, and deriving
      `…/songs/${id}.json` would bake a vendor's naming convention into the
      type. That the two coincide for all fourteen rows today is a fact about
      SomaFM, not a contract. `bun run check:radio` probes this URL alongside
      the logo, so the claim stays executable. */
  readonly songsUrl: string | null;
};

export const RADIO_STATIONS: readonly RadioStation[] = [
  {
    id: "groovesalad",
    title: "Groove Salad",
    genres: ["ambient", "electronic"],
    description: "A nicely chilled plate of ambient/downtempo beats and grooves.",
    streamUrl: "https://ice.somafm.com/groovesalad-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/groovesalad120.png",
    songsUrl: "https://api.somafm.com/songs/groovesalad.json",
  },
  {
    id: "dronezone",
    title: "Drone Zone",
    genres: ["ambient"],
    description:
      "Served best chilled, safe with most medications. Atmospheric textures with minimal beats.",
    streamUrl: "https://ice.somafm.com/dronezone-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/dronezone120.jpg",
    songsUrl: "https://api.somafm.com/songs/dronezone.json",
  },
  {
    id: "spacestation",
    title: "Space Station Soma",
    genres: ["electronic"],
    description: "Tune in, turn on, space out. Spaced-out ambient and mid-tempo electronica.",
    streamUrl: "https://ice.somafm.com/spacestation-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/spacestation120.jpg",
    songsUrl: "https://api.somafm.com/songs/spacestation.json",
  },
  {
    id: "lush",
    title: "Lush",
    genres: ["electronic"],
    description: "Sensuous and mellow female vocals, many with an electronic influence.",
    streamUrl: "https://ice.somafm.com/lush-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/lush120.jpg",
    songsUrl: "https://api.somafm.com/songs/lush.json",
  },
  {
    id: "indiepop",
    title: "Indie Pop Rocks!",
    genres: ["alternative", "rock"],
    description: "New and classic favorite indie pop tracks.",
    streamUrl: "https://ice.somafm.com/indiepop-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/indiepop120.jpg",
    songsUrl: "https://api.somafm.com/songs/indiepop.json",
  },
  {
    id: "u80s",
    title: "Underground 80s",
    genres: ["alternative", "electronic"],
    description: "Early 80s UK Synthpop and a bit of New Wave.",
    streamUrl: "https://ice.somafm.com/u80s-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/u80s120.png",
    songsUrl: "https://api.somafm.com/songs/u80s.json",
  },
  {
    id: "secretagent",
    title: "Secret Agent",
    genres: ["lounge"],
    description:
      "The soundtrack for your stylish, mysterious, dangerous life. For Spies and PIs too!",
    streamUrl: "https://ice.somafm.com/secretagent-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/secretagent120.jpg",
    songsUrl: "https://api.somafm.com/songs/secretagent.json",
  },
  {
    id: "defcon",
    title: "DEF CON Radio",
    genres: ["electronic", "specials"],
    description: "Music for Hacking. The DEF CON Year-Round Channel.",
    streamUrl: "https://ice.somafm.com/defcon-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/defcon120.png",
    songsUrl: "https://api.somafm.com/songs/defcon.json",
  },
  {
    id: "folkfwd",
    title: "Folk Forward",
    genres: ["folk", "alternative"],
    description: "Indie Folk, Alt-folk and the occasional folk classics. ",
    streamUrl: "https://ice.somafm.com/folkfwd-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/folkfwd120.jpg",
    songsUrl: "https://api.somafm.com/songs/folkfwd.json",
  },
  {
    id: "bootliquor",
    title: "Boot Liquor",
    genres: ["americana"],
    description: "Americana Roots music for Cowhands, Cowpokes and Cowtippers",
    streamUrl: "https://ice.somafm.com/bootliquor-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/bootliquor120.jpg",
    songsUrl: "https://api.somafm.com/songs/bootliquor.json",
  },
  {
    id: "bossa",
    title: "Bossa Beyond",
    genres: ["bossanova", "world"],
    description: "Silky-smooth, laid-back Brazilian-style rhythms of Bossa Nova, Samba and beyond",
    streamUrl: "https://ice.somafm.com/bossa-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/bossa120.jpg",
    songsUrl: "https://api.somafm.com/songs/bossa.json",
  },
  {
    id: "reggae",
    title: "Heavyweight Reggae",
    genres: ["reggae"],
    description: "Reggae, Ska, Rocksteady classic and deep tracks.",
    streamUrl: "https://ice.somafm.com/reggae-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/reggae120.png",
    songsUrl: "https://api.somafm.com/songs/reggae.json",
  },
  {
    id: "sonicuniverse",
    title: "Sonic Universe",
    genres: ["jazz"],
    description: "Transcending the world of jazz with eclectic, avant-garde takes on tradition.",
    streamUrl: "https://ice.somafm.com/sonicuniverse-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/sonicuniverse120.jpg",
    songsUrl: "https://api.somafm.com/songs/sonicuniverse.json",
  },
  {
    id: "missioncontrol",
    title: "Mission Control",
    genres: ["ambient", "electronic"],
    description: "Celebrating NASA and Space Explorers everywhere.",
    streamUrl: "https://ice.somafm.com/missioncontrol-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/missioncontrol120.jpg",
    songsUrl: "https://api.somafm.com/songs/missioncontrol.json",
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
    logoUrl: "https://api.somafm.com/logos/120/metal120.png",
    songsUrl: "https://api.somafm.com/songs/metal.json",
  },
  {
    id: "seventies",
    title: "Left Coast 70s",
    genres: ["70s", "rock"],
    description: "Mellow album rock from the Seventies. Yacht not required.",
    streamUrl: "https://ice.somafm.com/seventies-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/seventies120.jpg",
    songsUrl: "https://api.somafm.com/songs/seventies.json",
  },
  {
    id: "poptron",
    title: "PopTron",
    genres: ["alternative"],
    description: "Electropop and indie dance rock with sparkle and pop.",
    streamUrl: "https://ice.somafm.com/poptron-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/poptron120.png",
    songsUrl: "https://api.somafm.com/songs/poptron.json",
  },
  {
    id: "covers",
    title: "Covers",
    genres: ["eclectic"],
    description: "Just covers. Songs you know by artists you don't. We've got you covered.",
    streamUrl: "https://ice.somafm.com/covers-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/covers120.jpg",
    songsUrl: "https://api.somafm.com/songs/covers.json",
  },
  {
    id: "brfm",
    title: "Black Rock FM",
    genres: ["eclectic"],
    description: "From the Black Rock Desert playa to the world, year round!",
    streamUrl: "https://ice.somafm.com/brfm-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/brfm120.jpg",
    songsUrl: "https://api.somafm.com/songs/brfm.json",
  },
  {
    id: "doomed",
    title: "Doomed",
    genres: ["ambient", "industrial"],
    description: "Where every day is Halloween: dark industrial/ambient music for tortured souls.",
    streamUrl: "https://ice.somafm.com/doomed-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/doomed120.png",
    songsUrl: "https://api.somafm.com/songs/doomed.json",
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
  //   * `songsUrl` is null because Rock Antenne publishes no now-playing feed —
  //     probed, not assumed. That is the field's designed arm (`unsupported`),
  //     and it is also what keeps this a pure client change: `connect-src`
  //     names `api.somafm.com` alone, so ANY feed URL here would have needed a
  //     CSP widening — for a document `parseSongsFeed` could not read anyway,
  //     since it parses SomaFM's `{songs:[…]}` shape and nothing else.
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
    logoUrl:
      "https://www.rockantenne.de/media/cache/3/version/597/streamlogo_heavymetal_ra-v1.jpg/f1b996498456cb64.jpg",
    songsUrl: null,
  },
];
