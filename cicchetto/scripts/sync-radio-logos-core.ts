// #1739 — the pure half of the vendored-logo sync.
//
// No filesystem, no network, no Bun API, no imports. `sync-radio-logos.ts`
// does the IO and calls in here; `src/__tests__/syncRadioLogos.test.ts`
// exercises both sides of every rule. This is the `check-radio-logos-core.ts`
// split and it exists for the same measured reason that file states:
// `cicchetto/scripts/` is outside the tsconfig `include` AND outside biome's
// `files.includes`, so a runner-only module is checked by NOTHING — and the
// last module written runner-only shipped a real `noUncheckedIndexedAccess`
// violation that no gate could see.
//
// It is also what lets the OFFLINE gate (`radioLogoFiles.test.ts`) assert the
// committed map against the PRODUCTION naming rule instead of a copy of it. A
// gate holding its own second implementation of `vendoredName` would go green
// on a mirror that disagrees with the script that writes it.

/** The web path the vendored logos are served from — `public/radio-logos/`
    copied to the dist root by vite.

    🔴 A new root-level public directory MUST also be added to
    `@cic_static_only` in `lib/grappa_web/endpoint.ex` or it falls through to
    the SPA fallback and every logo arrives as `index.html` (that comment
    states the rule; #485 is the regression that wrote it). */
export const RADIO_LOGO_DIR = "/radio-logos";

/** Extension → the content type upstream must answer with.
 *
 * EXPLICIT rather than derived from the response: the extension is what the
 * file is STORED as, and `mediaSession.ts` reads the artwork MIME type back
 * off it — so a `.png` holding JPEG bytes hands the OS lock screen a type that
 * is not the payload's. Checking the two agree at SYNC time is the only moment
 * both facts are in the same room.
 *
 * An extension absent from this map is a FAILURE and not a pass: "not checked"
 * must never read as "checked ok", which is the equivalence
 * `check-radio-logos.ts` was written about. */
export const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** The extension a station's vendored file carries: upstream's own, or `svg`
    for a station that publishes no logo and therefore draws our generated
    tile.
    THROWS on a logo URL with no extension, deliberately. This runs in a build
    verb an operator watches, and a silent `""` would mint `public/radio-logos/x.`
    — a file every later gate would then faithfully report as present. */
export function extensionOf(logoUrl: string | null): string {
  if (logoUrl === null) return "svg";
  const last = new URL(logoUrl).pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot <= 0 || dot === last.length - 1) {
    throw new Error(`logo URL has no filename extension to mirror: ${logoUrl}`);
  }
  return last.slice(dot + 1).toLowerCase();
}

/** Where station `id`'s bytes live, as the browser addresses them.
 *
 * Keyed on the ID and not on upstream's filename: `groovesalad120.png` names
 * SomaFM's size convention, which is a fact about a vendor rather than about
 * this table, and the Rock Antenne row's name is a content hash. The id is the
 * field the table already promises is stable. */
export function vendoredPath(id: string, logoUrl: string | null): string {
  return `${RADIO_LOGO_DIR}/${id}.${extensionOf(logoUrl)}`;
}

/** `null` when the fetched bytes are the type the stored extension claims;
    otherwise why they are not.
    A parameter type rather than a status check: `check:radio`'s REACH axis
    already owns "does it answer at all", and this owns "is what it answered
    the thing we are about to name it". */
export function contentTypeFailure(extension: string, contentType: string | null): string | null {
  const wanted = CONTENT_TYPE_BY_EXTENSION[extension];
  if (wanted === undefined) {
    return `no content type known for .${extension} — teach CONTENT_TYPE_BY_EXTENSION`;
  }
  const got = contentType ?? "(none)";
  // Upstream spells `image/jpeg; charset=binary` on some paths, so the compare
  // is a prefix rather than an equality — the parameters after the `;` say
  // nothing about the payload.
  if (!got.startsWith(wanted)) return `served ${got}, wanted ${wanted} for .${extension}`;
  return null;
}

/** Files present in the mirror that no station claims.
 *
 * The sync DELETES these rather than reporting them, and the offline gate
 * fails on them: a station dropped from the table otherwise leaves its bytes
 * in git forever, with nothing left in the tree that mentions the id. */
export function orphans(
  present: readonly string[],
  claimed: ReadonlySet<string>,
): readonly string[] {
  return [...present].filter((path) => !claimed.has(path)).sort();
}

/** One row of the generated map. */
export type VendoredLogo = { readonly id: string; readonly path: string };

/** The whole body of `src/lib/radioLogoPaths.ts`.
 *
 * Emitted rather than hand-written for the reason the mirror exists at all: it
 * is the sync's RECEIPT. A hand-derived `/radio-logos/${id}.${ext}` at the
 * render site would be a claim about what the script wrote, and the two would
 * part company the first time upstream changed a file type.
 *
 * Sorted by id so a re-sync that changes nothing produces no diff — a
 * generated artefact whose line order follows the table's would churn on every
 * curation edit and make a real change invisible in the review. */
export function pathsModule(logos: readonly VendoredLogo[]): string {
  const rows = [...logos]
    .sort((a: VendoredLogo, b: VendoredLogo) => (a.id < b.id ? -1 : 1))
    .map((l: VendoredLogo) => `  ${JSON.stringify(l.id)}: ${JSON.stringify(l.path)},`)
    .join("\n");
  return `// GENERATED by scripts/sync-radio-logos.ts — do not edit by hand.
// Regenerate: scripts/bun.sh run sync:radio-logos
//
// #1739 — where each station's artwork is served from, on OUR origin. The
// picker used to point an <img> straight at api.somafm.com, so every viewer
// handed a third party an IP and a user agent each time the drawer painted.
//
// The map is the sync's receipt: it records what the script actually wrote,
// which is a different fact from what a path template would predict. A station
// that publishes no logo (\`logoUrl: null\`) carries the SVG tile
// \`lib/radioLogoPlaceholder.ts\` generates — one implementation, called by the
// sync rather than reproduced anywhere.
//
// \`src/__tests__/radioLogoFiles.test.ts\` is the gate: every station covered,
// every path a real non-empty file, no orphans, and a logo-less station's tile
// byte-identical to what the generator produces today. It is OFFLINE — the
// point of vendoring is that drawing a logo touches no network, so the gate
// that guards it must not either.

export const RADIO_LOGO_DIR = ${JSON.stringify(RADIO_LOGO_DIR)};

export const RADIO_LOGO_PATHS: Readonly<Record<string, string>> = {
${rows}
};
`;
}
