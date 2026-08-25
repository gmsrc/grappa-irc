// #1751 — the safe-area top inset reaches the radio picker's band through its
// ANCESTOR, exactly once, on both form factors.
//
// This spec is what caught the real defect, and it caught it by failing. The
// first reading of #1751 was that the symptom could not exist — the picker is
// `position: absolute; inset: 0` inside `.shell-members`, that aside insets
// itself, so the picker must already be clear. This spec's MOBILE arm returned
// a 0px delta and killed that argument: padding on a container is invisible to
// its abspos descendants, because the containing rectangle is the padding EDGE
// and INCLUDES the padding. The clearance now sits on the drawer's `top`, which
// moves the border box and every child with it.
//
// The desktop arm passes by a DIFFERENT mechanism and always did: there the
// aside is a grid item of the inset `.shell`, so its border box moves. Keeping
// both arms is the point — one mechanism per form factor, and only one of them
// was broken.
//
// THE MEASUREMENT PROBLEM, and the same answer #913 found. Playwright
// synthesizes `env(safe-area-inset-*)` on NO engine — they resolve to 0, and
// the `webkit-iphone-15` project is `devices["iPhone 15"]`, a viewport and a
// touch flag, not a notch. So no absolute claim about a 59px inset can be
// honest here. What IS observable is the WIRING: measure the same band twice,
// once at the Playwright value and once with the inset stubbed, and assert it
// moved by exactly that much.
//
// EXACTLY is the whole point, and it is what makes this more than a #913
// clone. `>= STUB` would pass on a build that insets the picker AS WELL as its
// ancestor — the regression the issue asked for, which lands the band a full
// inset too low with nothing red. `=== STUB` fails on both sides: 0 if the
// inset never reaches the picker, 2× if it reaches it twice.
//
// The stub goes through `--safe-area-inset-top`, and that indirection is what
// #1751 generalized: before it, `.shell` and `.shell-members` wrote `env()`
// inline and this spec could not have been written at all — the delta would be
// 0 on a correct build and on a broken one alike.
//
// BOTH CHAINS, because they are different. On mobile the picker's ancestor is
// the fixed `.shell-members` drawer carrying its own inset; on desktop it is a
// grid child of the inset `.shell`. `isMobile()` is a `matchMedia` width query
// (lib/theme.ts), so a viewport resize crosses the same 768px breakpoint the
// stylesheet does and both chains are reachable from one project. The felt
// result on a notched device is still vjt's to confirm; this spec does not
// claim it.

import { loginAs, openRailMenu, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// A plausible notch: iPhone 17 Pro reports ~59px. The exact number does not
// matter — the assertion is a delta — only that it is non-zero and large
// enough to dwarf sub-pixel layout noise. Same value as the #913 sibling.
const STUB_INSET = 59;

// Sub-pixel slack. `toBeCloseTo`'s second argument is a DIGIT COUNT rather than
// a tolerance, which reads like a tolerance and is not one, so the comparison
// is written out.
const EPSILON = 0.5;

const FORM_FACTORS = [
  {
    name: "desktop — the picker's ancestor is a grid child of the inset .shell",
    width: 1280,
    height: 800,
  },
  {
    name: "mobile — the picker's ancestor is the fixed .shell-members drawer",
    width: 390,
    height: 844,
  },
] as const;

test.setTimeout(90_000);

for (const factor of FORM_FACTORS) {
  test(`#1751 — the top inset reaches the radio picker's band exactly once (${factor.name})`, async ({
    page,
  }) => {
    // #1739 — the station-logo stub that used to sit here is GONE, not
    // retargeted. It existed because the picker's rows were third-party <img>
    // requests and a somafm outage could turn a layout assertion red; the
    // logos are vendored into `public/radio-logos/` now, so they are ordinary
    // same-origin assets and there is no outage left to guard against. Keeping
    // a route that can never fire would be worse than none: it fulfils with
    // empty bytes, so a regression that DID reach out again would be absorbed
    // here in silence. `issue682-rail-radio-picker.spec.ts` is the one spec
    // that still watches for such a request, and it aborts and counts it.
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    // Resized after the session is up, mirroring the #913 sibling: the login
    // and channel-select fixtures are written against the default viewport.
    await page.setViewportSize({ width: factor.width, height: factor.height });

    await openRailMenu(page);
    await page.getByTestId("rail-action-radio").click();
    await expect(page.getByTestId("rail-radio-picker")).toBeVisible();

    // The band, not the panel: "the `radio` header is hidden behind the status
    // bar" is what was reported, so the band's own top edge is the thing whose
    // clearance is in question. It is the panel's first child with no margin,
    // so the two move together — measuring the band keeps the assertion on the
    // reported surface.
    const band = page.locator(".rail-radio-picker .topic-bar");
    await expect(band).toBeVisible();

    const boxBefore = await band.boundingBox();
    expect(boxBefore, "the picker's band must have a layout box").not.toBeNull();

    // `:root:root` (0,2,0) rather than `:root` (0,1,0) so the override wins on
    // specificity without depending on where the bundler injected the sheet.
    await page.addStyleTag({
      content: `:root:root { --safe-area-inset-top: ${STUB_INSET}px; }`,
    });

    // Read straight back, as the #913 sibling does: the band is laid out by an
    // ancestor's padding, so the reflow is synchronous with the style tag and
    // `boundingBox()` forces layout anyway. Deliberately NOT polled for a
    // change first — that would turn the delta-is-0 case (the inset never
    // reaching the picker, i.e. the defect) into an unhelpful poll timeout
    // instead of the message below, which names both failure directions.
    const boxAfter = await band.boundingBox();
    expect(boxAfter, "the picker's band must still have a layout box").not.toBeNull();

    const moved = (boxAfter?.y ?? 0) - (boxBefore?.y ?? 0);
    expect(
      Math.abs(moved - STUB_INSET),
      `band moved ${moved}px for a ${STUB_INSET}px inset — 0 means the inset never reaches the picker, ${2 * STUB_INSET} means it reaches it twice (the #205 double-count the issue asked for)`,
    ).toBeLessThan(EPSILON);

    // The other half of the same claim, stated positively: the picker itself
    // must own no inset. A rule added there would show up as the 2× delta
    // above, but this says WHERE to look when it does.
    const pickerPadding = await page
      .getByTestId("rail-radio-picker")
      .evaluate((el) => getComputedStyle(el).paddingTop);
    expect(pickerPadding, "the picker carries no top padding of its own").toBe("0px");
  });
}
