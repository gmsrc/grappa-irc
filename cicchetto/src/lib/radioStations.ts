// #682 — the curated internet-radio station list.
//
// WHY A BAKED-IN TABLE AND NOT A LIVE CATALOGUE. SomaFM publishes its whole
// catalogue at `https://somafm.com/channels.json` (46 channels, with genre,
// listener counts and a `lastPlaying` track name), and that endpoint answers
// `Access-Control-Allow-Origin: *` — measured 2026-08-23. So CORS is NOT what
// rules it out. OUR OWN CSP is: `connect-src` (GrappaWeb.Plugs.SecurityHeaders)
// admits `'self'` plus three named third parties, and a `fetch` to somafm.com
// is not among them. Widening it is a server change and a security-surface
// decision, so the first cut ships the list as data instead. The same applies
// to the `.pls` playlists the catalogue points at: fetching one to read the
// stream URL out of it is a `fetch` too, and falls at the same door.
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
// audio on 2026-08-23; the versionless logo URLs were checked the same way
// (the catalogue spells them with a `?v=` cache-buster that would rot).
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
};

export const RADIO_STATIONS: readonly RadioStation[] = [
  {
    id: "groovesalad",
    title: "Groove Salad",
    genres: ["ambient", "electronic"],
    description: "A nicely chilled plate of ambient/downtempo beats and grooves.",
    streamUrl: "https://ice.somafm.com/groovesalad-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/groovesalad120.png",
  },
  {
    id: "dronezone",
    title: "Drone Zone",
    genres: ["ambient"],
    description:
      "Served best chilled, safe with most medications. Atmospheric textures with minimal beats.",
    streamUrl: "https://ice.somafm.com/dronezone-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/dronezone120.png",
  },
  {
    id: "spacestation",
    title: "Space Station Soma",
    genres: ["electronic"],
    description: "Tune in, turn on, space out. Spaced-out ambient and mid-tempo electronica.",
    streamUrl: "https://ice.somafm.com/spacestation-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/spacestation120.png",
  },
  {
    id: "lush",
    title: "Lush",
    genres: ["electronic"],
    description: "Sensuous and mellow female vocals, many with an electronic influence.",
    streamUrl: "https://ice.somafm.com/lush-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/lush120.png",
  },
  {
    id: "indiepop",
    title: "Indie Pop Rocks!",
    genres: ["alternative", "rock"],
    description: "New and classic favorite indie pop tracks.",
    streamUrl: "https://ice.somafm.com/indiepop-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/indiepop120.png",
  },
  {
    id: "u80s",
    title: "Underground 80s",
    genres: ["alternative", "electronic"],
    description: "Early 80s UK Synthpop and a bit of New Wave.",
    streamUrl: "https://ice.somafm.com/u80s-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/u80s120.png",
  },
  {
    id: "secretagent",
    title: "Secret Agent",
    genres: ["lounge"],
    description:
      "The soundtrack for your stylish, mysterious, dangerous life. For Spies and PIs too!",
    streamUrl: "https://ice.somafm.com/secretagent-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/secretagent120.png",
  },
  {
    id: "defcon",
    title: "DEF CON Radio",
    genres: ["electronic", "specials"],
    description: "Music for Hacking. The DEF CON Year-Round Channel.",
    streamUrl: "https://ice.somafm.com/defcon-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/defcon120.png",
  },
  {
    id: "folkfwd",
    title: "Folk Forward",
    genres: ["folk", "alternative"],
    description: "Indie Folk, Alt-folk and the occasional folk classics. ",
    streamUrl: "https://ice.somafm.com/folkfwd-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/folkfwd120.png",
  },
  {
    id: "bootliquor",
    title: "Boot Liquor",
    genres: ["americana"],
    description: "Americana Roots music for Cowhands, Cowpokes and Cowtippers",
    streamUrl: "https://ice.somafm.com/bootliquor-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/bootliquor120.png",
  },
  {
    id: "bossa",
    title: "Bossa Beyond",
    genres: ["bossanova", "world"],
    description: "Silky-smooth, laid-back Brazilian-style rhythms of Bossa Nova, Samba and beyond",
    streamUrl: "https://ice.somafm.com/bossa-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/bossa120.png",
  },
  {
    id: "reggae",
    title: "Heavyweight Reggae",
    genres: ["reggae"],
    description: "Reggae, Ska, Rocksteady classic and deep tracks.",
    streamUrl: "https://ice.somafm.com/reggae-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/reggae120.png",
  },
  {
    id: "sonicuniverse",
    title: "Sonic Universe",
    genres: ["jazz"],
    description: "Transcending the world of jazz with eclectic, avant-garde takes on tradition.",
    streamUrl: "https://ice.somafm.com/sonicuniverse-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/sonicuniverse120.png",
  },
  {
    id: "missioncontrol",
    title: "Mission Control",
    genres: ["ambient", "electronic"],
    description: "Celebrating NASA and Space Explorers everywhere.",
    streamUrl: "https://ice.somafm.com/missioncontrol-128-mp3",
    logoUrl: "https://api.somafm.com/logos/120/missioncontrol120.png",
  },
];
