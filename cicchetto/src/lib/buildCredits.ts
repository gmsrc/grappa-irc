// #1773 — the credit roll's build-time git facts.
//
// The credits easter egg names the commit the running bundle was built from,
// its date, and every contributor with their commit count. All three are git
// facts, and there is no git in a browser — nor in the cic build container,
// which mounts ONLY ./cicchetto (vite.config.ts) and so cannot see the repo
// root either. So they are derived OUTSIDE the container by the same wrappers
// that already derive GRAPPA_VERSION (infra/packaging/credits.sh →
// GRAPPA_CREDITS) and baked in by vite as the `__GRAPPA_CREDITS_JSON__`
// define.
//
// The VERSION is deliberately NOT in this payload: it already reaches the
// client through `<meta name="cicchetto-version">` (#292), and the modal reads
// it from there via `bundleHash.bootBundleVersionAccessor`. One injection
// point per fact — a second version carrier is exactly the drift #538 closed.
//
// Why a define and not a second `<meta>` tag: the payload is JSON, and the
// meta channel would have to survive HTML attribute serialisation of quotes
// and backslashes in contributor names. The define carries a plain string
// literal into the JS chunk, where there is nothing to escape and nothing to
// get wrong. The server has no reason to read this back (unlike the version
// meta, which `Grappa.Cic.Bundle` parses out of the deployed dist), so the
// meta channel buys nothing here.

/** One credited author and the number of non-merge commits they authored. */
export type Contributor = {
  readonly name: string;
  readonly commits: number;
};

/**
 * The build's git facts. `sha` / `date` are `null` on a build that HAD no
 * repo — the AUR source tarball builds with `.git` absent by construction,
 * exactly as `Grappa.Version` reports the bare base there. That is a
 * legitimate build, not a fault.
 *
 * Dockerfile.release's context has no `.git` either, but since #1834 it is no
 * longer a degraded build: release.yml derives the payload on the runner and
 * passes it in as a build arg, so the PUBLISHED image carries the real facts.
 * Only a plain `docker build` from a source checkout degrades there.
 */
export type BuildCredits = {
  readonly sha: string | null;
  readonly date: string | null;
  readonly contributors: readonly Contributor[];
};

export const EMPTY_BUILD_CREDITS: BuildCredits = {
  sha: null,
  date: null,
  contributors: [],
};

// Injected by the `cicchetto-credits` define in vite.config.ts. Declared
// rather than imported: it does not exist as a module, and it does not exist
// at all under vitest (a separate config with no `define`), which is why every
// read below goes through the coercion.
declare const __GRAPPA_CREDITS_JSON__: string | undefined;

function presence(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function contributor(entry: unknown): Contributor | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { name, commits } = entry as { name?: unknown; commits?: unknown };
  const named = presence(name);
  if (named === null) return null;
  if (typeof commits !== "number" || !Number.isInteger(commits) || commits < 0) return null;
  return { name: named, commits };
}

/**
 * Read a baked payload into the shape the modal renders, degrading per FIELD
 * rather than all-or-nothing: a payload that names the commit should still say
 * WHICH commit even when the roll itself is unreadable.
 *
 * Accepts the raw define (a JSON string) or anything else, because "anything
 * else" is what a bundle built by something other than our vite config hands
 * us. Never throws — an easter egg must not be able to break the drawer.
 */
export function coerceBuildCredits(raw: unknown): BuildCredits {
  if (typeof raw !== "string") return EMPTY_BUILD_CREDITS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_BUILD_CREDITS;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return EMPTY_BUILD_CREDITS;
  }

  const { sha, date, contributors } = parsed as {
    sha?: unknown;
    date?: unknown;
    contributors?: unknown;
  };

  const roll = Array.isArray(contributors)
    ? contributors.map(contributor).filter((c): c is Contributor => c !== null)
    : [];

  return { sha: presence(sha), date: presence(date), contributors: roll };
}

/**
 * The calendar day of a `date` from the payload, as the bare `YYYY-MM-DD` git
 * itself wrote — NOT a locale rendering.
 *
 * Deliberate: `toLocaleDateString` would make the roll say something
 * different per browser locale, which an e2e can only assert loosely, and the
 * surface is a monospace terminal pastiche where an ISO day is the native
 * spelling anyway. Anything that is not an ISO-8601 instant is handed back
 * whole rather than silently truncated to ten wrong characters.
 */
export function creditsDateLabel(date: string | null): string | null {
  if (date === null) return null;
  const day = date.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : date;
}

// Read once at module init, like `bundleHash`'s boot readers: the define is a
// build-time constant, so re-reading it can never yield a different answer.
const CREDITS: BuildCredits = coerceBuildCredits(
  typeof __GRAPPA_CREDITS_JSON__ === "undefined" ? undefined : __GRAPPA_CREDITS_JSON__,
);

/** The build's git facts, or the empty payload when none were baked in. */
export function buildCredits(): BuildCredits {
  return CREDITS;
}
