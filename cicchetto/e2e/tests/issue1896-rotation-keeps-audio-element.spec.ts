// #1896 — rotating a phone across the 768px breakpoint must not re-tune the radio.
//
// Reported from a Galaxy S24 Ultra: with a station playing, every rotation —
// both directions — drops the audio for a fraction of a second and then starts
// it again on its own. The mechanism is not audio at all, it is the shell:
// `isMobile()` is `matchMedia("(max-width: 768px)")` and Shell branches on it
// with a `<Show>`, i.e. TWO complete subtrees rather than one laid out two ways.
// A phone whose landscape CSS width clears 768 flips that signal when it turns,
// Solid destroys one subtree and builds the other, and the player used to be
// mounted inside BOTH — so the `<audio>` on the far side was a different
// element. Its open effect then ran as a first tune, and for a STREAM
// `mustRefetch()` is true (#1700: a stream has no position to resume to,
// re-tuning IS its resume), so it re-fetched: a new HTTP connection, heard as
// the gap, with the autoplay behind the "restarts on its own".
//
// WHAT THIS SPEC MEASURES, and why each instrument is here.
//
//   * ELEMENT IDENTITY, marked rather than inferred. A rebuilt `<audio>` is
//     indistinguishable from the original by tag, testid or property — only a
//     mark written onto the live object before the crossing separates them, and
//     the element is what holds the connection.
//   * THE TRANSPORT CALLS, counted from an init script. Identity alone would
//     still pass if something re-assigned `.src` on the surviving element, and
//     `.src` is what re-opens the connection: assigning it re-invokes the media
//     load algorithm even for an unchanged URL. So the two are counted and must
//     not move across a crossing.
//
// And three controls, because each of them is a way for this to go green while
// proving nothing:
//
//   * the counters must be NON-ZERO before the first crossing — an instrument
//     that never fired reports "unchanged" perfectly;
//   * the shell must actually have SWITCHED branch at every crossing, asserted
//     on the root class — a resize that stays on one side of 768 changes
//     nothing and would satisfy every assertion below;
//   * the bar must be back on screen AFTER each crossing. An element that
//     survives into a shell with no transport driving it is not the fix.
//
// WHAT IT DOES NOT ESTABLISH, stated because the green is easy to over-read.
// Not a device rotation: this is `setViewportSize` in desktop Chromium, so it
// reproduces the BREAKPOINT CROSSING (the same `matchMedia` edge, the same JSX
// flip) and not an orientation change on a handset. The S24 Ultra's real
// landscape CSS width was never read off the handset either — 844x390 below is
// a phone-shaped viewport chosen to straddle 768, not a measurement of the
// reporter's device. The desktop project is deliberate: the defect is in the
// shell's regime signal and its DOM, neither of which is touch- or
// engine-specific, and the untagged project is where the login/rail helpers
// this spec leans on are proven.
//
// NO THIRD-PARTY NETWORK, the #682/#1701 posture: the stream is served from
// local bytes by `page.route`, scoped to the station's real URL so a change
// that stops requesting it fails here rather than passing quietly.

import type { Page } from "@playwright/test";
import { silentMp3 } from "../fixtures/bytes";
import { loginAs, openRailMenu, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Literals rather than an import from `src/lib/radioStations`, matching #682
// and #1701: a table edit that drops or renames this station must fail HERE
// instead of being followed silently.
const STATION_ID = "groovesalad";
const STATION_STREAM = "https://ice.somafm.com/groovesalad-128-mp3";

// A phone, portrait and landscape. Both sides of 768 by a wide margin — the
// crossing must be unambiguous, because a viewport that lands NEAR the
// breakpoint turns a branch assertion into a coin toss on a scrollbar.
const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };

type TransportCounts = { plays: number; srcSets: number };

// Count the two calls that re-open a connection, from before the app's first
// script runs. Wrapping the prototype rather than watching the element: the
// point of this spec is that there is only ever ONE element, and an instrument
// bound to a particular one could not tell a rebuild from a re-tune.
async function installTransportCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __transport1896: TransportCounts };
    const counts = { plays: 0, srcSets: 0 };
    w.__transport1896 = counts;

    const proto = HTMLMediaElement.prototype;
    const play = proto.play;
    proto.play = function patchedPlay(this: HTMLMediaElement) {
      counts.plays += 1;
      return play.call(this);
    };

    // `src` is an IDL attribute of HTMLMediaElement, so the descriptor lives on
    // that prototype and every <audio> reaches it through the chain. Throwing
    // when it is absent rather than skipping: a silently un-instrumented setter
    // would report zero re-tunes for the rest of the run.
    const descriptor = Object.getOwnPropertyDescriptor(proto, "src");
    const setSrc = descriptor?.set;
    if (descriptor === undefined || setSrc === undefined) {
      throw new Error("#1896 counter: HTMLMediaElement.prototype has no `src` setter");
    }
    Object.defineProperty(proto, "src", {
      ...descriptor,
      set(this: HTMLMediaElement, value: string) {
        counts.srcSets += 1;
        setSrc.call(this, value);
      },
    });
  });
}

const transportCounts = (page: Page): Promise<TransportCounts> =>
  page.evaluate(() => (window as unknown as { __transport1896: TransportCounts }).__transport1896);

// Login + channel join on the testnet, a station tune, and three reflows.
test.setTimeout(120_000);

test("#1896 — crossing 768px keeps the same <audio> element and never re-tunes", async ({
  page,
}) => {
  test.slow();
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

  await installTransportCounter(page);
  await page.route("https://ice.somafm.com/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "audio/mpeg", body: silentMp3(8) });
  });

  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // Tune at the project's own (desktop) viewport, where `openRailMenu` takes
  // its proven path. WHERE the tune happens is not what this spec is about —
  // the subject is what a CROSSING does to an already-tuned player, and the
  // first resize below is itself one.
  await openRailMenu(page);
  await page.getByTestId("rail-action-radio").click();
  await expect(page.getByTestId("rail-radio-picker")).toBeVisible();
  await page.getByTestId(`rail-radio-station-${STATION_ID}`).click();

  const audio = page.getByTestId("audio-mini-player-el");
  await expect(audio).toHaveJSProperty("src", STATION_STREAM);
  await expect(page.getByTestId("audio-mini-player")).toBeVisible({ timeout: 15_000 });

  // The picker holds an overlay lock and covers the rail; close it so the
  // resizes below are a plain regime change and nothing else.
  await page.getByTestId("rail-radio-picker-close").click();
  await expect(page.getByTestId("rail-radio-picker")).toBeHidden();

  // CONTROL — the instrument is alive. Everything after this reads "unchanged",
  // which a counter that never incremented satisfies perfectly.
  const tuned = await transportCounts(page);
  expect(tuned.srcSets, "the tune must have gone through the `src` setter").toBeGreaterThan(0);
  expect(tuned.plays, "the tune must have called play()").toBeGreaterThan(0);

  // Mark the live object. `toHaveJSProperty` on a fresh element would match the
  // same src just as well — only something written onto THIS object separates
  // "the element survived" from "an identical one was built".
  await audio.evaluate((el) => {
    el.setAttribute("data-rotation-probe", "survived");
  });

  // Three crossings: into the phone's portrait shell, out to its landscape one
  // (the rotation the report is about), and back. Both directions, because the
  // report says both directions.
  const crossings = [
    { label: "desktop → portrait phone", size: PORTRAIT, mobileAfter: true },
    { label: "portrait → landscape (the rotation)", size: LANDSCAPE, mobileAfter: false },
    { label: "landscape → portrait (rotated back)", size: PORTRAIT, mobileAfter: true },
  ];

  for (const crossing of crossings) {
    await page.setViewportSize(crossing.size);

    // CONTROL — the branch really flipped. Without this a resize that never
    // crossed 768 would satisfy every assertion that follows.
    await expect(
      page.locator(".shell-mobile"),
      `${crossing.label}: the shell must have switched branch`,
    ).toHaveCount(crossing.mobileAfter ? 1 : 0);

    // One element, and the SAME one. The attribute rides on the object; a
    // rebuilt <audio> comes back without it.
    await expect(audio, `${crossing.label}: exactly one player`).toHaveCount(1);
    await expect(
      audio,
      `${crossing.label}: the element must be the one that was playing`,
    ).toHaveAttribute("data-rotation-probe", "survived");

    // No re-tune: neither the connection-opening assignment nor the autoplay
    // behind the "restarts on its own" may have happened again.
    expect(
      await transportCounts(page),
      `${crossing.label}: the transport must not have been driven again`,
    ).toEqual(tuned);

    // And the bar came with it — a surviving element nobody can stop is not a fix.
    await expect(
      page.getByTestId("audio-mini-player"),
      `${crossing.label}: the transport must be docked in the new shell`,
    ).toBeVisible({ timeout: 15_000 });
  }
});
