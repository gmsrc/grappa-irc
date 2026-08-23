// #682 — internet radio: the picker is reachable from the RailActions drawer,
// picking a station drives the ONE audio element, and both surfaces name it.
//
// WHAT THIS SPEC ASSERTS, AND WHY EACH ONE IS AN OUTCOME AND NOT A MIRROR:
//   (a) the radio launcher is in the rail drawer and opens the picker — the
//       shape vjt decided, and the only door to the feature;
//   (b) the picker lists the curated stations;
//   (c) picking one puts THAT station's stream on the <audio> element and the
//       browser actually ISSUES the request for it (the route handler counts
//       the hits) — so this fails if the URL never reaches the element, which
//       a "the bar appeared" assertion alone would not catch;
//   (d) the docked transport shows the station's NAME. This is the assertion
//       that matters most on a phone: the rail carrying the chrome is a
//       drawer slid off-screen while playing, so the docked bar is the only
//       surface answering "what am I listening to";
//   (e) the rail's own station chrome names it too, and the picked row is
//       marked so the picker is not a blind list.
//
// NO THIRD-PARTY NETWORK. Both the stream and the station logos are served by
// `page.route` from local bytes (fixtures/bytes `silentMp3`), so the suite
// never depends on somafm.com being up and a station outage cannot turn this
// red. The route is scoped to the station's real URL, so a change that stops
// requesting that URL still fails.
//
// WHAT THIS SPEC DELIBERATELY DOES NOT ASSERT, and where it IS asserted.
// The transport's LIVE mode — no seek slider, no download anchor, elapsed
// shown alone — is not checked here, and the omission is a platform limit
// rather than a gap left open. Live mode keys off a non-finite
// `HTMLMediaElement.duration`, and `route.fulfill` must serve a COMPLETE
// body, which is by definition finite: any stream this spec can serve
// deterministically reports a finite duration and takes the file branch.
// Serving a genuinely endless body would mean reaching a real Icecast host
// and reintroducing the external dependency this spec exists without. So
// live mode is pinned in `src/__tests__/AudioMiniPlayer.test.tsx`, which
// drives `duration` (Infinity and NaN) directly on the element. Weakening
// the assertion here to something a finite body could satisfy would have
// been a green that proves the opposite of what it claims.

import { silentMp3 } from "../fixtures/bytes";
import { loginAs, openRailMenu, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// The station the spec tunes. Kept as literals rather than imported from
// `src/lib/radioStations` so that a table edit which silently drops or
// renames this station fails HERE, loudly, instead of the spec following the
// rename and asserting nothing about what shipped.
const STATION_ID = "groovesalad";
const STATION_TITLE = "Groove Salad";
const STATION_STREAM = "https://ice.somafm.com/groovesalad-128-mp3";

test.setTimeout(90_000);

test("#682 — the rail picker tunes a station onto the docked transport", async ({ page }) => {
  let streamRequests = 0;

  // Serve the stream locally. `**` on the host path so a redirect or a query
  // string cannot slip past the intercept and reach the real host.
  await page.route("https://ice.somafm.com/**", async (route) => {
    streamRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "audio/mpeg",
      body: silentMp3(8),
    });
  });
  // Logos too: an <img> to a third party is still a third-party request.
  await page.route("https://api.somafm.com/logos/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.alloc(0) });
  });

  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // (a) the launcher lives in the ONE rail drawer, on both form factors.
  await openRailMenu(page);
  await page.getByTestId("rail-action-radio").click();

  const picker = page.getByTestId("rail-radio-picker");
  await expect(picker).toBeVisible();

  // (b) and it carries stations, this one among them.
  const row = page.getByTestId(`rail-radio-station-${STATION_ID}`);
  await expect(row).toBeVisible();

  await row.click();

  // (c) the station's stream reached the element AND was requested.
  const audio = page.getByTestId("audio-mini-player-el");
  await expect(audio).toHaveJSProperty("src", STATION_STREAM);
  await expect.poll(() => streamRequests, { timeout: 10_000 }).toBeGreaterThan(0);

  // (d) the docked transport names it — the phone's only answer to "what is
  // playing", since the rail behind it is off-screen while playing.
  await expect(page.getByTestId("audio-mini-player")).toBeVisible();
  await expect(page.getByTestId("audio-mini-player-label")).toHaveText(STATION_TITLE);

  // (e) the rail says so too, and marks the row it tuned.
  await expect(page.getByTestId("rail-radio-now")).toContainText(STATION_TITLE);
  await expect(row).toHaveAttribute("aria-pressed", "true");
});
