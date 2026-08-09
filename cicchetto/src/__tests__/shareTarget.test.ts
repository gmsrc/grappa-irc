import { beforeEach, describe, expect, it } from "vitest";
import {
  handleShareTargetRequest,
  isShareTargetRequest,
  SHARE_TARGET_ACCEPT,
  SHARE_TARGET_ACTION,
  SHARE_TARGET_FILES_FIELD,
  takeSharedFiles,
} from "../lib/shareTarget";
import {
  AUDIO_MIMES,
  DOCUMENT_MIMES_OFFICE,
  DOCUMENT_MIMES_PORTABLE,
  IMAGE_MIMES,
  VIDEO_MIMES,
} from "../lib/uploadCategory";

// #1103 — the Web Share Target wire contract, and the half of it that runs in
// the service worker.
//
// WHAT THESE TESTS ATTEST, AND WHAT THEY DO NOT. jsdom does not run a service
// worker: there is no `ServiceWorkerGlobalScope`, no real `CacheStorage`, and
// no browser to POST a share into. So the SW's `fetch` LISTENER — that it is
// registered, that it fires before Workbox's router, that a real WebAPK share
// reaches it — is NOT covered here and cannot be. What IS covered is
// everything the listener delegates to, which is why the listener is three
// lines and this module holds the rest: the request predicate, the form
// parse, the stash/read round-trip, and the redirect. The listener is
// exercised only by a real browser.

const ORIGIN = "https://cic.example.test";

// Minimal in-memory CacheStorage. Only the four verbs the production code
// touches; anything else would be scaffolding pretending to be a browser.
//
// It keys on the ABSOLUTE url, because that is what a browser does: a
// relative key handed to `Cache.put` is resolved against the worker's scope,
// and `Cache.keys()` hands back absolute `Request`s. A double that stored the
// relative string would let a read side that assumes absolute keys pass here
// and fail in the browser.
function fakeCaches(): CacheStorage {
  const stores = new Map<string, Map<string, Response>>();
  const absolute = (req: RequestInfo): string =>
    new URL(typeof req === "string" ? req : req.url, ORIGIN).toString();
  const cacheFor = (name: string): Map<string, Response> => {
    const existing = stores.get(name);
    if (existing !== undefined) return existing;
    const fresh = new Map<string, Response>();
    stores.set(name, fresh);
    return fresh;
  };
  return {
    open: async (name: string) => {
      const entries = cacheFor(name);
      return {
        put: async (req: RequestInfo, res: Response) => {
          entries.set(absolute(req), res);
        },
        match: async (req: RequestInfo) => entries.get(absolute(req)),
        // Deliberately REVERSED. `Cache.keys()` resolves in insertion order
        // per spec, but the read side must not lean on that: it is a detail
        // of a browser API we do not control, and the order files reach a
        // channel is the order the operator picked them in. Handing the keys
        // back backwards is what makes the read side's sort load-bearing
        // instead of decorative.
        keys: async () => [...entries.keys()].reverse().map((url) => new Request(url)),
      } as unknown as Cache;
    },
    delete: async (name: string) => stores.delete(name),
    has: async (name: string) => stores.has(name),
  } as unknown as CacheStorage;
}

// The multipart body is written out BY HAND rather than through `FormData`.
// Not preference: in this environment `FormData` is jsdom's and `Request` is
// Node's, and handing the first to the second serialises to a part with
// `filename=""` and the literal text `undefined` for a body. A test built on
// that would assert against a payload no browser ever sends. These bytes are
// the shape a WebAPK share actually posts.
type SharedPart = { name: string; type: string; body: string };

const BOUNDARY = "----cicShareTargetTestBoundary";

function shareRequest(parts: SharedPart[]): Request {
  const body =
    parts
      .map(
        (p) =>
          `--${BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="${SHARE_TARGET_FILES_FIELD}"; filename="${p.name}"\r\n` +
          `Content-Type: ${p.type}\r\n\r\n${p.body}\r\n`,
      )
      .join("") + `--${BOUNDARY}--\r\n`;
  return new Request(`${ORIGIN}${SHARE_TARGET_ACTION}`, {
    method: "POST",
    body,
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
  });
}

const png = (name: string, body: string): SharedPart => ({ name, type: "image/png", body });

let caches: CacheStorage;
beforeEach(() => {
  caches = fakeCaches();
});

describe("the accept list is DERIVED from the upload allowlist", () => {
  // The manifest tells the OS which types to offer cicchetto for. Hand-writing
  // that list would put a second, silently-drifting copy of the server's
  // `@mime_categories` in the build config — and the drift is invisible until
  // an operator shares a file the OS offered us and the server answers 415.
  it("carries exactly the MIMEs the upload path accepts", () => {
    const expected = [
      ...IMAGE_MIMES,
      ...VIDEO_MIMES,
      ...DOCUMENT_MIMES_PORTABLE,
      ...DOCUMENT_MIMES_OFFICE,
      ...AUDIO_MIMES,
    ];
    expect([...SHARE_TARGET_ACCEPT].sort()).toEqual([...expected].sort());
  });

  it("is not empty (a share target accepting nothing is never offered)", () => {
    expect(SHARE_TARGET_ACCEPT.length).toBeGreaterThan(0);
  });
});

describe("isShareTargetRequest", () => {
  it("matches a POST to the share action", () => {
    expect(isShareTargetRequest(shareRequest([]))).toBe(true);
  });

  it("ignores a GET to the same path", () => {
    // The SW must not swallow a plain navigation to the action URL — that one
    // belongs to Workbox's navigation fallback.
    expect(
      isShareTargetRequest(new Request(`${ORIGIN}${SHARE_TARGET_ACTION}`, { method: "GET" })),
    ).toBe(false);
  });

  it("ignores a POST to any other path", () => {
    expect(isShareTargetRequest(new Request(`${ORIGIN}/api/uploads`, { method: "POST" }))).toBe(
      false,
    );
  });

  it("matches regardless of query string", () => {
    expect(
      isShareTargetRequest(
        new Request(`${ORIGIN}${SHARE_TARGET_ACTION}?from=android`, { method: "POST" }),
      ),
    ).toBe(true);
  });

  it("does not match a path that merely starts with the action", () => {
    expect(
      isShareTargetRequest(
        new Request(`${ORIGIN}${SHARE_TARGET_ACTION}-decoy`, { method: "POST" }),
      ),
    ).toBe(false);
  });
});

describe("handleShareTargetRequest", () => {
  it("answers with a 303 redirect into the app shell", async () => {
    // 303 specifically: the browser must follow it with a GET. A 302 would let
    // it re-POST the multipart body at the shell.
    const res = await handleShareTargetRequest(shareRequest([png("a.png", "a")]), caches);
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(new URL(location, ORIGIN).origin).toBe(ORIGIN);
  });

  it("hands the files to the app through the cache, bytes intact", async () => {
    await handleShareTargetRequest(shareRequest([png("shot.png", "hello")]), caches);

    const files = await takeSharedFiles(caches);
    expect(files.length).toBe(1);
    expect(files[0]?.name).toBe("shot.png");
    expect(files[0]?.type).toBe("image/png");
    expect(await files[0]?.text()).toBe("hello");
  });

  it("keeps a multi-file share in the order it arrived", async () => {
    await handleShareTargetRequest(
      shareRequest([png("1.png", "one"), png("2.png", "two"), png("3.png", "three")]),
      caches,
    );

    const files = await takeSharedFiles(caches);
    expect(files.map((f) => f.name)).toEqual(["1.png", "2.png", "3.png"]);
  });

  it("round-trips a non-ASCII filename", async () => {
    // The name travels in an HTTP header, which is a latin-1 byte channel: a
    // raw UTF-8 name either throws on `put` or comes back mojibake.
    await handleShareTargetRequest(shareRequest([png("caffè ☕.png", "x")]), caches);

    const files = await takeSharedFiles(caches);
    expect(files[0]?.name).toBe("caffè ☕.png");
  });

  it("redirects with no flag when the body is not a form", async () => {
    // Nothing to hand over, so the app must not go looking. Landing on the
    // bare shell is the honest degrade.
    const res = await handleShareTargetRequest(
      new Request(`${ORIGIN}${SHARE_TARGET_ACTION}`, { method: "POST", body: "not-a-form" }),
      caches,
    );
    expect(res.status).toBe(303);
    expect(await takeSharedFiles(caches)).toEqual([]);
  });
});

describe("takeSharedFiles", () => {
  it("is empty when nothing was ever shared", async () => {
    expect(await takeSharedFiles(caches)).toEqual([]);
  });

  it("CONSUMES: a second read finds nothing", async () => {
    // The handover is one-shot. Left behind, the same files would be
    // re-delivered on the next cold boot — a reload re-posting an image into a
    // channel is worse than losing it.
    await handleShareTargetRequest(shareRequest([png("a.png", "a")]), caches);

    expect((await takeSharedFiles(caches)).length).toBe(1);
    expect(await takeSharedFiles(caches)).toEqual([]);
  });
});
