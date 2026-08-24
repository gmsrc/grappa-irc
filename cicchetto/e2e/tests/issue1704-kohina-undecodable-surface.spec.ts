// #1704 — Kohina ships knowing it will NOT play for some phones, and this spec
// is the reason that is allowed.
//
// THE SHIP ARGUMENT, and what it rests on. Every other row in the curated table
// is `audio/mpeg`; Kohina is Ogg Vorbis, measured off the stream's own bytes
// (`OggS` then `\x01vorbis`). Per the vendored caniuse-lite, iOS Safari decodes
// Ogg Vorbis from 18.4 (`y`), is partial from 17.4 to 18.3 (`a`, and the packed
// data carries no note text to say partial HOW), and does not decode it at all
// at 17.3 and below (`n`). So this row is silent for a population — and #1703's
// standing condition was that a station which cannot play must not ship while a
// stream that fails says nothing to anybody. #1744 built the saying-so; this
// spec is the proof that it fires, in a real browser, for THIS row.
//
// WHY A FAKE BODY AND NOT A REAL OGG. The point under test is the SURFACE, not
// anyone's codec support: `route.fulfill` serves bytes that are not decodable
// audio, so the element takes its resource-failure path and populates
// `MediaError` — which is the same door an unsupported codec walks through. A
// real Ogg body would instead measure whether THIS Playwright build decodes
// Vorbis, which is a fact about this Playwright build and not about iOS 17.3.
//
// ⚠️ WHAT THIS DOES NOT ESTABLISH, stated because a green here is easy to
// over-read. It does not establish that iOS below 18.4 fails on Kohina — that
// is caniuse's claim and it is not measurable from CI at any browser version we
// can drive. What it establishes is the conditional: GIVEN the element reports
// a media error, the operator is told, on the transport and on the rail, and
// the bar stops dressing the dead source as a zero-second file. The spec runs
// on both configured projects, so the WebKit half is measured on WebKit rather
// than inferred from Chromium.

import {
  closeMembersDrawer,
  loginAs,
  openRailMenu,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Literals, not an import from `src/lib/radioStations` — the posture #682's
// spec established one file over: a table edit that drops or renames this
// station must fail HERE, loudly, rather than have the spec follow the rename
// and assert nothing about what shipped.
const STATION_ID = "kohina";
const STATION_TITLE = "Kohina";
const STATION_STREAM = "https://kohina.brona.dk/icecast/stream.ogg";

test.setTimeout(90_000);

test("#1704 — a Kohina stream the browser cannot decode says so on every surface", async ({
  page,
}) => {
  let streamRequests = 0;

  // Bytes that are NOT decodable audio, served under the type Kohina really
  // answers with. Scoped to the station's real host so a change that stops
  // requesting that URL fails here instead of quietly passing.
  await page.route("https://kohina.brona.dk/**", async (route) => {
    streamRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "audio/ogg",
      body: Buffer.from("this is not an ogg vorbis stream", "utf8"),
    });
  });

  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  await openRailMenu(page);
  await page.getByTestId("rail-action-radio").click();
  await expect(page.getByTestId("rail-radio-picker")).toBeVisible();
  await page.getByTestId(`rail-radio-station-${STATION_ID}`).click();

  const audio = page.getByTestId("audio-mini-player-el");
  await expect(audio).toHaveJSProperty("src", STATION_STREAM);
  await expect.poll(() => streamRequests, { timeout: 10_000 }).toBeGreaterThan(0);

  // The element really failed — the precondition of everything below, asserted
  // rather than assumed, because a spec whose subject never happened would pass
  // its remaining assertions vacuously. The CODE is deliberately not pinned to
  // 4: the two engines are free to classify an unusable resource differently,
  // and the surface's job is to name whatever they said, not to make them agree.
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () =>
            document.querySelector<HTMLAudioElement>("[data-testid='audio-mini-player-el']")?.error
              ?.code ?? 0,
        ),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  // Picking deliberately leaves the picker up (#682: auditioning stations is a
  // control the operator flips in place), and the picker is an `inset: 0`
  // overlay ON the rail — so the station chrome underneath it is only genuinely
  // on screen once the picker is dismissed. Closing it is what makes the next
  // assertion a claim about something an operator could actually see.
  await page.getByTestId("rail-radio-picker-close").click();
  await expect(page.getByTestId("rail-radio-picker")).toHaveCount(0);

  // (1) THE RAIL SAYS IT — the desktop answer to "what is playing", and the one
  // left standing when the operator hides the docked transport (#1697).
  await expect(page.getByTestId("rail-radio-now-error")).toBeVisible();
  await expect(page.getByTestId("rail-radio-now-title")).toHaveText(STATION_TITLE);

  // (2) And the station Kohina publishes no logo for draws SOMETHING — our own
  // placeholder, never a broken-image glyph. Asserted as the SHAPE (a data URI)
  // rather than the exact bytes, which `radioLogoPlaceholder.test.ts` pins.
  await expect(page.locator(".rail-radio-now-logo")).toHaveAttribute(
    "src",
    /^data:image\/svg\+xml,/,
  );

  // On the iPhone profile the rail is a DRAWER whose backdrop is a full-viewport
  // scrim over the docked transport; on desktop there is no drawer and no
  // backdrop. Guarded on the element rather than on the project name, so the
  // spec follows the app's own layout rule instead of restating it.
  const backdrop = page.locator(".shell-drawer-backdrop.open");
  if ((await backdrop.count()) > 0) await closeMembersDrawer(page);

  // (3) THE OPERATOR IS TOLD ON THE TRANSPORT. Asserted as "there is a sentence
  // here" rather than as one particular sentence: which of the five reasons the
  // element reported is the engine's call, and pinning the prose would make a
  // wording change a spec failure while a SILENT bar stayed green — the wrong
  // way round.
  const notice = page.getByTestId("audio-mini-player-error");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText(/\S{4,}/);

  // (4) AND THE BAR STOPS LYING. The half a "some text appeared" assertion would
  // miss: with no metadata the element's `duration` is a finite 0, so before
  // #1744 this row drew the FILE readout — a scrubber at `max="0"` and a
  // `0:00 / 0:00` clock over a stream that produced no audio at all.
  await expect(page.getByTestId("audio-mini-player-seek")).toHaveCount(0);
  await expect(page.getByTestId("audio-mini-player-time")).toHaveCount(0);

  // (5) The station is still NAMED. A reason with nothing beside it does not
  // tell the operator which station to re-pick.
  await expect(page.getByTestId("audio-mini-player-label")).toHaveText(STATION_TITLE);
});
