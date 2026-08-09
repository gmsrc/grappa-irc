import {
  AUDIO_MIMES,
  DOCUMENT_MIMES_OFFICE,
  DOCUMENT_MIMES_PORTABLE,
  IMAGE_MIMES,
  VIDEO_MIMES,
} from "./uploadCategory";

// #1103 — Web Share Target: the wire contract, and the half of it that runs
// inside the service worker.
//
// Three parties read this module and no other: `vite.config.ts` (which bakes
// the `share_target` key into the generated manifest), `service-worker.ts`
// (which intercepts the POST), and the SPA's delivery reader
// (`shareTargetDelivery.ts`). They must agree on the action URL, the form
// field name and the handover cache, so those three facts live here once
// rather than three times. Same discipline as `pwaIcons.ts` (S18), which is
// shared between the manifest and the SW for the same reason.
//
// ## Why the file has to travel through a Cache
//
// A share is a POST navigation. The SW answers it with a redirect, the
// browser then GETs the shell, and the SPA boots FRESH — so the `File`
// objects cannot simply be held in a variable: they have to survive both the
// navigation and a possible SW termination in between. The Cache API is the
// one storage that takes a `Response` body verbatim, so each file is stashed
// as a one-off response and read back as a `File`. The handover is one-shot:
// `takeSharedFiles` deletes the cache as it reads, because a leftover entry
// would re-post the same image into a channel on the next cold boot.
//
// ## This module keeps NO app state
//
// It imports only `uploadCategory` (which imports nothing), so `vite.config.ts`
// can pull it at build time without dragging the SolidJS graph into the build
// config. Anything that touches stores lives in `shareTargetDelivery.ts`.

/**
 * The manifest `share_target.action`, and the URL the SW matches.
 *
 * Not a real server route: nothing on the Phoenix side answers it, and
 * nothing should — the SW is the only handler. A GET here falls through to
 * the SPA shell like any other unknown path.
 */
export const SHARE_TARGET_ACTION = "/share-target";

/** The multipart field name, declared in the manifest and read by the SW. */
export const SHARE_TARGET_FILES_FIELD = "files";

/**
 * The query flag on the post-redirect landing URL. The SPA reads it at boot
 * to know a share is waiting, instead of probing the cache on every load.
 */
export const SHARE_TARGET_PARAM = "shared";

/** Where the SW sends the browser once the files are stashed. */
export const SHARE_TARGET_LANDING = `/?${SHARE_TARGET_PARAM}=1`;

/** Handover cache. Versioned so a shape change cannot read stale entries. */
export const SHARE_TARGET_CACHE = "cic-share-target-v1";

/**
 * The MIME types the OS may offer cicchetto, DERIVED from the upload
 * allowlist rather than written out.
 *
 * `uploadCategory.ts` is already a declared 1:1 mirror of the server's
 * `@mime_categories` (uploads_controller.ex), which is the closed allowlist
 * that answers 415. Copying those strings into the build config would put a
 * THIRD copy in the tree, and its drift would be invisible until an operator
 * shares a file the OS offered us and the server refuses it — after the app
 * has already opened, which is the worst place to find out.
 */
export const SHARE_TARGET_ACCEPT: readonly string[] = [
  ...IMAGE_MIMES,
  ...VIDEO_MIMES,
  ...DOCUMENT_MIMES_PORTABLE,
  ...DOCUMENT_MIMES_OFFICE,
  ...AUDIO_MIMES,
];

// Per-file cache key. Zero-padded so the read side can restore the share's
// order by sorting keys — `Cache.keys()` resolves in insertion order per
// spec, but the order files reach a channel is the order the operator picked
// them in, and that is worth pinning rather than inheriting.
const fileKey = (index: number): string => `/__share-target/${String(index).padStart(4, "0")}`;

// The filename rides an HTTP header, which is a latin-1 byte channel: a raw
// UTF-8 name throws on `put` or comes back mojibake. Percent-encoding is the
// standard escape and round-trips exactly.
const NAME_HEADER = "x-cic-share-filename";

/** True for the POST the OS makes when the operator picks cicchetto. */
export function isShareTargetRequest(request: Request): boolean {
  if (request.method !== "POST") return false;
  return new URL(request.url).pathname === SHARE_TARGET_ACTION;
}

/**
 * Handle the share POST: stash whatever files it carries, then redirect into
 * the shell so the SPA can pick them up.
 *
 * `303` and not `302`: the browser must follow with a GET. A 302 leaves it
 * free to re-issue the multipart POST at the shell URL.
 *
 * A body that is not a form cannot be a share we understand, so it lands on
 * the BARE shell — no flag, nothing stashed, and the app opens without
 * hunting for files that are not there.
 */
export async function handleShareTargetRequest(
  request: Request,
  cacheStorage: CacheStorage,
): Promise<Response> {
  let files: File[] = [];
  try {
    const form = await request.formData();
    // A `FormDataEntryValue` is `string | File`, so "not a string" IS the
    // discriminator. `instanceof File` looks tighter and is wrong: the
    // entries come from whichever realm parsed the body (the SW's, or Node's
    // under vitest), and a cross-realm instanceof silently answers false —
    // dropping every file while reporting a clean parse.
    files = form.getAll(SHARE_TARGET_FILES_FIELD).filter((v): v is File => typeof v !== "string");
  } catch (err) {
    console.warn("[shareTarget] share POST carried no readable form", err);
    return redirectTo("/", request.url);
  }
  await stashSharedFiles(cacheStorage, files);
  return redirectTo(SHARE_TARGET_LANDING, request.url);
}

function redirectTo(path: string, base: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: new URL(path, base).toString() },
  });
}

/** Put the shared files where the next document can read them. */
export async function stashSharedFiles(
  cacheStorage: CacheStorage,
  files: readonly File[],
): Promise<void> {
  await cacheStorage.delete(SHARE_TARGET_CACHE);
  if (files.length === 0) return;
  const cache = await cacheStorage.open(SHARE_TARGET_CACHE);
  let index = 0;
  for (const file of files) {
    await cache.put(
      fileKey(index),
      new Response(file, {
        headers: {
          "content-type": file.type === "" ? "application/octet-stream" : file.type,
          [NAME_HEADER]: encodeURIComponent(file.name),
        },
      }),
    );
    index += 1;
  }
}

/**
 * Read the shared files and CLEAR them — one-shot by construction.
 *
 * Returns `[]` when no share is pending, which is also what a cache-less
 * environment yields, so a caller never has to ask whether the API exists.
 */
export async function takeSharedFiles(cacheStorage: CacheStorage): Promise<File[]> {
  if (!(await cacheStorage.has(SHARE_TARGET_CACHE))) return [];
  const cache = await cacheStorage.open(SHARE_TARGET_CACHE);
  const keys = await cache.keys();
  const urls = keys.map((k) => k.url).sort();
  const files: File[] = [];
  for (const url of urls) {
    const res = await cache.match(url);
    if (res === undefined) continue;
    const encoded = res.headers.get(NAME_HEADER);
    const type = res.headers.get("content-type") ?? "application/octet-stream";
    // `arrayBuffer()` and not `blob()`: the response body was minted by
    // whichever realm answered the fetch, and a foreign Blob handed to this
    // realm's `File` constructor is a cross-realm bet. A buffer is neutral.
    const bytes = await res.arrayBuffer();
    files.push(new File([bytes], decodeURIComponent(encoded ?? "shared"), { type }));
  }
  await cacheStorage.delete(SHARE_TARGET_CACHE);
  return files;
}
