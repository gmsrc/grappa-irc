// #1764 — `.txt` and `.md` open in the media-viewer modal and are READ inline:
// monospace source, line numbers, nothing rendered.
//
// This asserts the VISIBLE OUTCOME, not the plumbing: that the words in the
// uploaded file are on screen and that the gutter numbers them. A spec that
// only proved "the modal exists" or "a function was called" would stay green
// through a viewer that opens empty, which is precisely the failure mode the
// CSP note below describes.
//
// ## Why the full upload vertical, and not a composed URL
//
// The text arm is the only viewer kind that FETCHES its bytes instead of
// pointing an element at them, so it answers to `connect-src` — `'self'` plus
// the captcha hosts and api.somafm.com, and deliberately NOT widened to
// `https:` the way `img-src`/`media-src` are. Running the real journey means
// the fetch crosses the e2e dumb proxy under the REAL prod CSP (the BEAM emits
// it via GrappaWeb.Plugs.SecurityHeaders; #485, pinned by
// nginx-csp-range-parity.spec.ts) with the `_cspGuard` fixture failing the spec
// on any `securitypolicyviolation`. Text on screen therefore proves BOTH that
// the bytes came back through the proxy AND that the policy admitted the read.
//
// It also exercises the `Range: bytes=0-…` request the viewer sends: the
// upload controller answers it with a 206 (`GrappaWeb.ByteRange`), and the
// viewer has to be as happy with a 206 as with a 200.
//
// ## Two phases, ONE journey each, in one test
//
// workers: 1 — a second `test()` is a second login + channel select for no
// coverage (the media-link-modal-viewer load-states precedent). The `.md`
// phase is not a duplicate of the `.txt` one: it is the phase that proves
// vjt's ruling ("nono nessun rendering di gesu, assolutamente solo il sorgente
// txt e md", #sbiffo 2026-08-24) survives contact with real markdown.

import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { closeMediaViewer, openMediaViewer } from "../fixtures/mediaViewer";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
import { mediaScrollbackRow, uploadViaPicker } from "../fixtures/uploadJourney";

const CHANNEL = AUTOJOIN_CHANNELS[0];

const TXT_LINES = ["alpha one", "beta two", "gamma three", "delta four"];
// Real markdown, so "shown as source" is a claim about something a renderer
// would visibly have eaten.
const MD_LINES = ["# Release notes", "", "**bold** and [a link](https://example.com)"];

test("#1764 — a .txt upload opens as readable source with line numbers, and a .md stays source", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // ---- Phase 1: .txt — the bytes are on screen and the gutter counts them.
  const txt = await uploadViaPicker(
    page,
    {
      name: "issue1764.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(`${TXT_LINES.join("\n")}\n`, "utf8"),
    },
    { postTimeout: 10_000 },
  );
  expect(txt.url).toMatch(new RegExp(`/uploads/${txt.slug}\\.txt$`));

  const txtRow = await mediaScrollbackRow(page, "📄", txt.slug);
  // The reversal itself: before #1764 a `.txt` anchor carried no media class
  // and the click never reached the viewer (issue418's spec pinned exactly
  // that, and is rewritten in this change).
  await expect(txtRow.link).toHaveClass(/scrollback-media-link/);

  const cicUrl = page.url();
  const viewer = await openMediaViewer(page, txtRow.link);
  expect(page.url()).toBe(cicUrl);

  const source = viewer.getByTestId("media-viewer-text-source");
  const gutter = viewer.getByTestId("media-viewer-text-gutter");

  // 🔴 `textContent` through `expect.poll`, NOT `toHaveText`. Playwright
  // NORMALIZES whitespace for that matcher, which collapses every newline to a
  // space — so a viewer that rendered four lines as one run-on paragraph would
  // pass it, and so would one that lost the gutter's line breaks. Line
  // structure is the entire subject here, so the assertion has to see the raw
  // characters. `poll` keeps the retry the matcher would have given.
  await expect
    .poll(() => source.textContent(), {
      message: "the uploaded lines must be on screen, in order, as source",
      timeout: 10_000,
    })
    .toBe(TXT_LINES.join("\n"));
  // …and the numbers are really there, one per line and no phantom for the
  // file's trailing newline.
  await expect.poll(() => gutter.textContent()).toBe("1\n2\n3\n4");

  // Not a rendered document: the source element is a <pre>.
  expect(await source.evaluate((el) => el.tagName)).toBe("PRE");

  await closeMediaViewer(viewer);

  // ---- Phase 2: .md — same pane, and markdown is still markdown.
  const md = await uploadViaPicker(
    page,
    {
      name: "issue1764.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(`${MD_LINES.join("\n")}\n`, "utf8"),
    },
    { postTimeout: 10_000 },
  );
  // The server minted the extension, which is the whole type signal the
  // classifier keys off (#418). A `.md` could not exist at all before this
  // change: text/markdown was in neither the accept-allowlist nor MimeExt.
  expect(md.url).toMatch(new RegExp(`/uploads/${md.slug}\\.md$`));

  const mdRow = await mediaScrollbackRow(page, "📄", md.slug);
  await expect(mdRow.link).toHaveClass(/scrollback-media-link/);

  const mdViewer = await openMediaViewer(page, mdRow.link);
  const mdSource = mdViewer.getByTestId("media-viewer-text-source");
  // Raw characters again, and here it matters twice over: MD_LINES carries a
  // BLANK line, which whitespace normalisation would erase outright.
  await expect
    .poll(() => mdSource.textContent(), {
      message: "markdown must arrive as its own source, blank line included",
      timeout: 10_000,
    })
    .toBe(MD_LINES.join("\n"));
  await expect
    .poll(() => mdViewer.getByTestId("media-viewer-text-gutter").textContent())
    .toBe("1\n2\n3");

  // The three shapes a renderer would have produced. Asserted on generated
  // HTML rather than on looks: cic has no sanitisation surface anywhere today,
  // and this change must not be the reason it grows one.
  const pane = mdViewer.locator(".media-viewer-text");
  await expect(pane.locator("h1")).toHaveCount(0);
  await expect(pane.locator("strong")).toHaveCount(0);
  await expect(pane.locator("a")).toHaveCount(0);

  await closeMediaViewer(mdViewer);
  expect(page.url()).toBe(cicUrl);
});
