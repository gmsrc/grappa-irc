// #1228 — on a phone the settings drawer's notifications sub-page renders
// past the drawer's own right border: the master-toggle label, both text
// inputs, the mute select and the devices rows' `remove` buttons are all
// sliced by the screen edge.
//
// MEASURED cause (none of this was established when the issue was filed —
// the issue was written from a screenshot and listed four candidates, three
// of which the measurement refutes):
//
//   * The `mute:` <select> is the only box in the sub-page whose width
//     depends on the USER'S DATA — a <select> takes its intrinsic width from
//     its longest OPTION, and the options are `"<conversation> — <network>"`.
//     With short names it needs 173px; with one long conversation name it
//     needs 367px, against 239px of available drawer width.
//   * A <fieldset> defaults to `min-inline-size: min-content` and, unlike
//     other boxes, will not shrink below it. So the select's 367px becomes
//     the fieldset's 381px floor, and EVERY control inside is then laid out
//     against a box 142px wider than the drawer. That is why the whole
//     sub-page is cut and not one control — and why the drawer HEADER, which
//     lives outside the fieldset, is not.
//   * Refuted by the same measurement: the two text inputs (intrinsic 156px
//     and 155px — their `size` attribute is not the driver), the devices
//     rows (163px), the master toggle (116px). Adding `min-width: 0` to the
//     labels' flex children changes nothing; removing the fieldset's
//     `min-inline-size` removes the overflow and restoring it brings it
//     back.
//
// jsdom has no layout engine, so vitest is structurally blind to this class
// of defect — the only oracle is a real engine at a real phone width, hence
// @webkit (iPhone 15). The reported device was wider (~440 CSS px, read off
// the screenshot), but the drawer is `width: 22rem` and so is 263px wide on
// both: the available width this spec measures against is identical.
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: a subject-shape-
// agnostic CSS layout contract — registered vjt suffices.

import type { Page } from "@playwright/test";
import {
  composeSend,
  loginAs,
  openSettingsSection,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { GRAPPA_BASE_URL } from "../fixtures/grappaApi";
import { pushCatcherEndpoint, resetPushSubscriptions } from "../fixtures/push";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

// A real iPhone Safari UA so the devices row renders the shape the operator
// sees (`📱 Safari on iOS`), not a placeholder.
const DEVICE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// The smallest text size — the one the report came from. `--font-size` drives
// the root font size, so S is where the 22rem drawer is NARROWEST (263px) and
// the squeeze is worst.
const FONT_SIZE = "S";

// 32 chars, bahamut's CHANNELLEN. The long name is the whole point: it is what
// makes the mute select's intrinsic width exceed the drawer, and it is the
// difference between a seeded account and vjt's.
const LONG_CHANNEL = `#${"z".repeat(31)}`;

// Seed a push subscription straight over REST. The devices list only renders
// when there is at least one row, and both of its `remove` buttons are named
// on the issue — but going through the real SW/PushManager stub would buy
// nothing: the row's GEOMETRY is what is under test, and the server takes the
// same row either way.
async function seedOneDevice(token: string, id: string): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/push/subscriptions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": DEVICE_UA,
    },
    body: JSON.stringify({
      endpoint: pushCatcherEndpoint(id),
      keys: { p256dh: "BJ1228p256dhkeymaterialplaceholder", auth: "auth1228placeholder" },
    }),
  });
  if (!res.ok) throw new Error(`seedOneDevice: ${res.status} ${await res.text()}`);
}

type Offender = {
  tag: string;
  cls: string;
  testid: string | null;
  text: string;
  width: number;
  right: number;
  overflow: number;
};

// The five boxes the issue names as sliced by the screen edge. They are the
// probe's own non-vacuity check: if the sub-page did not render, or the
// devices list came up empty, the offender list would be trivially empty and
// this spec would pass on the broken build.
const WITNESSES = {
  masterToggle: ".notifications-fieldset .master-toggle",
  channelsInput: '[data-testid="pref-channels-only"]',
  nicksInput: '[data-testid="pref-nicks-only"]',
  mutePicker: '[data-testid="pref-mute-picker"]',
  deviceRemove: ".devices-list .device-remove",
} as const;

type Witness = { found: boolean; width: number; right: number };

type Measurement = {
  viewportWidth: number;
  rootFontSize: string;
  drawerLeft: number;
  drawerRight: number;
  drawerClientWidth: number;
  drawerScrollWidth: number;
  witnesses: Record<string, Witness>;
  // Every box ranked by right edge, overflowing or not — so a failure report
  // names the widest box even when the list of offenders is long.
  widest: Offender[];
  offenders: Offender[];
};

async function measure(page: Page): Promise<Measurement> {
  return await page.locator(".settings-drawer.open").evaluate((drawer, witnessSelectors) => {
    const style = getComputedStyle(drawer);
    const box = drawer.getBoundingClientRect();
    const contentRight =
      box.right - Number.parseFloat(style.paddingRight) - Number.parseFloat(style.borderRightWidth);

    const witnesses: Record<string, Witness> = {};
    for (const [name, selector] of Object.entries(witnessSelectors)) {
      const el = drawer.querySelector(selector);
      const r = el === null ? null : el.getBoundingClientRect();
      witnesses[name] =
        r === null
          ? { found: false, width: 0, right: 0 }
          : {
              found: true,
              width: Math.round(r.width * 10) / 10,
              right: Math.round(r.right * 10) / 10,
            };
    }

    const boxes: Offender[] = [];
    for (const el of Array.from(drawer.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      boxes.push({
        tag: el.tagName.toLowerCase(),
        cls: el.getAttribute("class") ?? "",
        testid: el.getAttribute("data-testid"),
        text: (el.textContent ?? "").trim().slice(0, 40),
        width: Math.round(r.width * 10) / 10,
        right: Math.round(r.right * 10) / 10,
        overflow: Math.round((r.right - contentRight) * 10) / 10,
      });
    }
    boxes.sort((a, b) => b.right - a.right);

    return {
      viewportWidth: window.innerWidth,
      rootFontSize: getComputedStyle(document.documentElement).fontSize,
      drawerLeft: Math.round(box.left * 10) / 10,
      drawerRight: Math.round(box.right * 10) / 10,
      drawerClientWidth: drawer.clientWidth,
      drawerScrollWidth: drawer.scrollWidth,
      witnesses,
      widest: boxes.slice(0, 5),
      offenders: boxes.filter((b) => b.overflow > 0.5),
    };
  }, WITNESSES);
}

test("@webkit @touch #1228 — a long conversation name does not push the notifications sub-page off the drawer", async ({
  page,
}) => {
  const vjt = specUser();
  await resetPushSubscriptions(vjt.token);
  // Two devices, as in the report — both `remove` buttons were sliced there.
  await seedOneDevice(vjt.token, "1228-a");
  await seedOneDevice(vjt.token, "1228-b");

  await page.addInitScript((s) => localStorage.setItem("cicchetto.fontSize", s), FONT_SIZE);
  await loginAs(page, vjt);

  // The long name has to reach the mute picker's OPTIONS, which are built
  // from the open windows.
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });
  await composeSend(page, `/join ${LONG_CHANNEL}`);

  await openSettingsSection(page, "push");
  await expect(page.getByTestId("devices-list").locator("li")).toHaveCount(2);
  // PRECONDITION (anti-hollow-green): the long option is actually IN the
  // select. Without it the drawer has nothing wide to lay out and every
  // assertion below passes on the broken build too.
  await expect(page.getByTestId("pref-mute-picker")).toContainText(LONG_CHANNEL);

  const m = await measure(page);
  console.log(
    `#1228 vw=${m.viewportWidth} root=${m.rootFontSize} drawer=${m.drawerLeft}..${m.drawerRight} client=${m.drawerClientWidth} scroll=${m.drawerScrollWidth} widest=${JSON.stringify(m.widest[0])}`,
  );

  // PRECONDITION: this is the phone geometry the issue is about — the drawer
  // pinned to the screen's right edge, at its narrowest text size.
  expect(m.viewportWidth).toBeLessThanOrEqual(440);
  expect(m.drawerRight).toBeCloseTo(m.viewportWidth, 0);

  // PRECONDITION: the five boxes the issue names were rendered AND laid out.
  for (const [name, w] of Object.entries(m.witnesses)) {
    expect(w, `witness ${name} must be present`).toMatchObject({ found: true });
    expect(w.width, `witness ${name} must have been laid out`).toBeGreaterThan(0);
  }

  // The drawer's own scroller is the second half of the same fact: content
  // wider than the box is exactly what the operator sees cut by the screen.
  expect(m.drawerScrollWidth).toBe(m.drawerClientWidth);
  expect(m.offenders).toEqual([]);
});
