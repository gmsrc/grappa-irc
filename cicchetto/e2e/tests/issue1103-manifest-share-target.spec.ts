// #1103 — the served PWA manifest must declare a file `share_target`, and it
// must accept exactly what the upload endpoint accepts (2026-08-09).
//
// WHY a served-manifest-contract spec and NOT a share-the-file spec: the
// behaviour is not headlessly e2e-able. The share sheet is an OS surface,
// the registration is minted into an Android WebAPK, and Playwright can
// neither install one nor invoke Android's share intent. What CAN be proved
// headlessly is the FIX ARTIFACT — that the manifest nginx actually serves
// off the built dist carries the declaration, with the method, encoding and
// accept list a Chromium install needs to offer cicchetto at all. Same
// posture, and the same reasoning, as the #234 orientation guard next door.
//
// The accept list is the part worth pinning. It is DERIVED in the build from
// `src/lib/uploadCategory.ts`, which is a declared 1:1 mirror of the server's
// `@mime_categories` — the closed allowlist that answers 415. A hand-edit
// that widens the manifest without widening the server would make the OS
// offer cicchetto for a file the upload endpoint then refuses, after the app
// has already opened. This spec reads the SERVED artifact, so it fails on
// that drift rather than on a source-level pin that could agree with itself.
//
// KNOWN LIMITATION, not a gap in this spec: on Android the registration lives
// in the WebAPK, which is Chromium machinery. A PWA installed from Firefox
// will not appear in the system share sheet no matter what this manifest
// says. Nothing headless can observe that either way.

// Bare @playwright/test (NOT ../fixtures/test): a stateless static-asset
// probe must skip the vjt-scoped fixture and its per-test reset — same
// reasoning as issue234-manifest-no-orientation-pin.spec.ts.
import { expect, test } from "@playwright/test";

test("#1103 served PWA manifest declares a POST file share target", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.status(), "GET /manifest.webmanifest").toBe(200);

  const manifest = await res.json();

  // Proves we got the real cic manifest and not a 404 fallback that happens
  // to lack the key — the same non-vacuity guard #234 uses.
  expect(manifest.id, "manifest.id must stay /cic").toBe("/cic");

  const share = manifest.share_target;
  expect(share, "manifest must declare share_target (#1103)").toBeTruthy();

  // POST + multipart is not style: the spec requires both for a target that
  // receives FILES, and a GET target cannot carry them at all.
  expect(share.method, "a file share target must be POST").toBe("POST");
  expect(share.enctype, "a file share target must be multipart/form-data").toBe(
    "multipart/form-data",
  );

  // The action is what the service worker's fetch listener matches on. If the
  // two ever disagree the POST leaves for the network, where nothing answers
  // it, and the share dies as a 404 with the app never opening.
  expect(typeof share.action, "share_target.action must be a path").toBe("string");

  const files = share.params?.files;
  expect(Array.isArray(files), "share_target.params.files must be an array").toBe(true);
  expect(files[0]?.name, "the form field the SW reads").toBe("files");

  // Accepts images at minimum — the case the issue was filed for (an Android
  // user trying to share a photo into a channel).
  const accept: string[] = files[0]?.accept ?? [];
  expect(accept, "the accept list must carry the image MIMEs").toEqual(
    expect.arrayContaining(["image/png", "image/jpeg"]),
  );

  // And nothing the upload endpoint would answer 415 to. `application/zip` is
  // not in the server's closed allowlist and must never appear here: offering
  // cicchetto in the share sheet for a file it will refuse is the failure
  // this pins, and it is invisible until an operator hits it.
  expect(accept, "the accept list must not exceed the upload allowlist").not.toContain(
    "application/zip",
  );
  expect(accept).not.toContain("*/*");

  // FILES ONLY. Declaring `text` or `url` would register cicchetto as a
  // destination for shared LINKS, which it has no path for — the share would
  // open the app and vanish. Better not to appear in the sheet at all.
  expect(share.params?.text, "no text param: cic has no path for a shared link").toBeUndefined();
  expect(share.params?.url, "no url param: cic has no path for a shared link").toBeUndefined();
});
