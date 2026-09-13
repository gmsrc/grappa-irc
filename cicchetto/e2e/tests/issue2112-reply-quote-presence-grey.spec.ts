// issue 2112 — the quoted head of a reply takes the grey the PRESENCE rows read
// as ON SCREEN (`* nick … has joined #chan`), not the `--muted` it shared with
// timestamps. Asked for on #grappa by peluche and Fairy, confirmed by vjt.
//
// WHY THIS NEEDS A REAL BROWSER, and no jsdom test can stand in: the grey being
// matched is not declared anywhere. `.scrollback-presence` says `--muted` and
// never reaches the text — `.scrollback-body` is a descendant that declares
// `color: var(--fg)` on itself — and then `.scrollback-line.scrollback-muted`
// damps the whole row with `opacity`. The target is the product of a cascade
// and a composite. jsdom resolves neither `var()` nor `color-mix()` and has no
// compositor, so only an engine can answer.
//
// Two independent legs, because each catches what the other cannot:
//
//   1. RESOLVED — the quote's computed colour is `--fg` damped by EXACTLY the
//      opacity the presence row applies, both read off the live engine. No
//      literal 75 appears in this file: the test asserts the RELATIONSHIP, so
//      changing one number without the other is what goes red.
//
//   2. PAINTED — the pixels. A resolved colour that never reaches the screen
//      (overridden, clipped, composited away) passes leg 1 and fails the user.
//      Methodology is the issue's: the 5% of each region's pixels furthest in
//      luminance from that region's dominant colour — its ink — averaged per
//      channel. Asserted RELATIVELY (the quote is far closer to the presence
//      ink than to its own row's timestamp ink) so no tuned constant decides
//      the verdict, plus the one absolute threshold that is not ours to pick:
//      WCAG's 4.5:1 floor for text, which the `--muted` spelling FAILED at a
//      measured 3.88:1.
//
// Both legs run on both shipped themes. Theme-independence is a constraint of
// the issue, not a bonus: the rule stays relative to `--fg`/`--bg` so the
// gallery themes and the theme editor need no per-theme work.
//
// WHAT THIS DOES NOT PROVE: that `opacity` on the fragment would have looked
// different. It would not, on a uniform backdrop — the two are the same paint
// at every coverage, and in this container they measured 1.17/255 apart with
// zero channel spread either way (headless Chromium renders grayscale
// antialiasing, so the subpixel-AA divergence the issue worried about is
// unreachable from here). The choice is argued on the rule in default.css.

import type { Page } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

// The reply shape the renderer dims: `<nick> …body… << ` then the answer.
const QUOTED = "<bob> ciao mondo";
const REPLY_BODY = `${QUOTED} << si certo davvero`;

type Ink = { rgb: [number, number, number]; contrast: number };
type Census = {
  quote: Ink;
  presence: Ink;
  timestamp: Ink;
  resolvedQuote: string;
  resolvedTarget: string;
  opacity: number;
};

/**
 * One screenshot, three regions, both legs. Everything happens in the page so
 * the PNG is decoded once and every region is read off the same frame — two
 * screenshots could straddle a repaint and compare inks that never coexisted.
 */
async function census(page: Page, peerNick: string): Promise<Census> {
  const shot = (await page.screenshot({ fullPage: false })).toString("base64");
  const result = await page.evaluate(
    async ({ shot, peerNick, reply }: { shot: string; peerNick: string; reply: string }) => {
      const rows = (kind: string) => [
        ...document.querySelectorAll(`[data-testid="scrollback-line"][data-kind="${kind}"]`),
      ];
      const joinRow = rows("join").find((el) => (el.textContent ?? "").includes(peerNick));
      const replyRow = rows("privmsg").find((el) => (el.textContent ?? "").includes(reply));
      if (joinRow === undefined) throw new Error(`no join row for ${peerNick}`);
      if (replyRow === undefined) throw new Error(`no reply row for ${reply}`);

      const pick = (root: Element, sel: string): Element => {
        const el = root.querySelector(sel);
        if (el === null) throw new Error(`missing ${sel} in ${root.className}`);
        return el;
      };
      const quoteEl = pick(replyRow, ".scrollback-reply-quote");
      const presenceEl = pick(joinRow, ".scrollback-body");
      const timeEl = pick(replyRow, ".scrollback-time");

      const img = new Image();
      img.src = `data:image/png;base64,${shot}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("no 2d context");
      ctx.drawImage(img, 0, 0);

      const lin = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      const lum = (p: number[]) => 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);

      const inkOf = (el: Element) => {
        const r = el.getBoundingClientRect();
        const dsf = window.devicePixelRatio;
        const x0 = Math.max(0, Math.floor(r.left * dsf));
        const y0 = Math.max(0, Math.floor(r.top * dsf));
        const w = Math.min(canvas.width - x0, Math.ceil(r.width * dsf));
        const h = Math.min(canvas.height - y0, Math.ceil(r.height * dsf));
        if (w <= 0 || h <= 0) throw new Error("region is off-screen — nothing to sample");
        const { data } = ctx.getImageData(x0, y0, w, h);

        const px: number[][] = [];
        for (let i = 0; i < data.length; i += 4) px.push([data[i], data[i + 1], data[i + 2]]);

        // The region's dominant colour is its background; the ink is whatever
        // sits furthest from it in luminance. Deriving the background rather
        // than naming it is what lets one function read a dark theme and a
        // light one — on `irssi-dark` the ink is the brightest 5%, on
        // `mirc-light` the darkest, and neither is hardcoded here.
        const tally = new Map<number, number>();
        for (const p of px) {
          const k = (p[0] << 16) | (p[1] << 8) | p[2];
          tally.set(k, (tally.get(k) ?? 0) + 1);
        }
        let bgKey = 0;
        let bgCount = -1;
        for (const [k, c] of tally) if (c > bgCount) [bgKey, bgCount] = [k, c];
        const bgLum = lum([(bgKey >> 16) & 255, (bgKey >> 8) & 255, bgKey & 255]);

        const sorted = [...px].sort((a, b) => Math.abs(lum(b) - bgLum) - Math.abs(lum(a) - bgLum));
        const top = sorted.slice(0, Math.max(1, Math.floor(px.length * 0.05)));
        const mean = [0, 1, 2].map(
          (c) => Math.round((top.reduce((s, p) => s + p[c], 0) / top.length) * 100) / 100,
        );
        const [hi, lo] = [lum(mean), bgLum].sort((a, b) => b - a);
        return {
          rgb: mean as [number, number, number],
          contrast: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
        };
      };

      // Leg 1, built in the engine rather than in JS arithmetic: a probe
      // painted with `--fg` damped by the presence row's OWN opacity. Whatever
      // the engine makes of that expression is what the quote has to equal.
      const root = getComputedStyle(document.documentElement);
      const opacity = Number.parseFloat(getComputedStyle(joinRow).opacity);
      const probe = document.createElement("span");
      probe.style.color = `color-mix(in srgb, ${root.getPropertyValue("--fg").trim()} ${
        opacity * 100
      }%, ${root.getPropertyValue("--bg").trim()})`;
      document.body.appendChild(probe);
      const resolvedTarget = getComputedStyle(probe).color;
      probe.remove();

      return {
        quote: inkOf(quoteEl),
        presence: inkOf(presenceEl),
        timestamp: inkOf(timeEl),
        resolvedQuote: getComputedStyle(quoteEl).color,
        resolvedTarget,
        opacity,
      };
    },
    { shot, peerNick, reply: REPLY_BODY },
  );
  return result;
}

const distance = (a: Ink, b: Ink): number =>
  Math.max(...a.rgb.map((c, i) => Math.abs(c - b.rgb[i])));

function assertCensus(theme: string, c: Census): void {
  // Leg 1 — resolved. Exact: the engine evaluated both sides.
  expect(c.opacity, `${theme}: the presence row still damps itself`).toBeGreaterThan(0);
  expect(c.opacity, `${theme}: …and is not opaque, or there is no grey to match`).toBeLessThan(1);
  expect(
    c.resolvedQuote,
    `${theme}: the quote resolves to ${c.resolvedQuote}, but --fg damped by the presence ` +
      `row's own ${c.opacity} opacity is ${c.resolvedTarget}`,
  ).toBe(c.resolvedTarget);

  // Leg 2 — painted. Relative, so no tuned constant decides it: the quote must
  // sit far closer to the presence ink than to the timestamp ink it used to
  // share. Measured on mirc-light: 3.50 vs 61-odd after the fix (ratio ~17),
  // and 58.17 vs ~0 before it, so the two regimes are nowhere near the margin.
  const toPresence = distance(c.quote, c.presence);
  const toTimestamp = distance(c.quote, c.timestamp);
  expect(
    toTimestamp,
    `${theme}: the quote ink ${c.quote.rgb} and the timestamp ink ${c.timestamp.rgb} are the ` +
      "same colour — the quote is still wearing --muted",
  ).toBeGreaterThan(3 * toPresence);

  // The one absolute threshold that is not ours to choose. `--muted` against
  // the row background measures 3.88:1 here and derives to 4.00:1 on both
  // shipped themes — under the floor. The presence grey is comfortably over it.
  expect(
    c.quote.contrast,
    `${theme}: the quote paints at ${c.quote.contrast}:1 against its background`,
  ).toBeGreaterThanOrEqual(4.5);
}

test("issue 2112 — the reply quote paints the presence grey, on both themes", async ({ page }) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  const channel = AUTOJOIN_CHANNELS[0];
  await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });

  const peer = await IrcPeer.connect({ nick: "grey2112" });
  try {
    await peer.join(channel);
    peer.privmsg(channel, REPLY_BODY);

    await expect(
      page
        .locator('[data-testid="scrollback-line"][data-kind="join"]')
        .filter({ hasText: peer.nick }),
    ).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator(".scrollback-reply-quote").first()).toBeVisible({ timeout: 15_000 });

    // The default the bench boots on, whichever it is — read, never assumed.
    const booted = await page.evaluate(() => document.documentElement.dataset.theme ?? "(unset)");
    const first = await census(page, peer.nick);
    console.log(`[2112] ${booted}: ${JSON.stringify(first)}`);
    assertCensus(booted, first);

    // The other shipped palette, driven through the same attribute the theme
    // switcher writes. Theme-independence is the issue's constraint: the rule
    // must follow `--fg`/`--bg` with no per-theme work, and this is what would
    // go red if it ever grew a literal.
    const other = booted === "irssi-dark" ? "mirc-light" : "irssi-dark";
    await page.evaluate((t: string) => {
      document.documentElement.dataset.theme = t;
    }, other);
    const second = await census(page, peer.nick);
    console.log(`[2112] ${other}: ${JSON.stringify(second)}`);
    assertCensus(other, second);

    // The two palettes must not have produced the same paint, or the switch
    // did not take and both halves above measured one theme twice.
    expect(
      distance(first.quote, second.quote),
      `${booted} and ${other} painted the quote the same — the theme switch did not take`,
    ).toBeGreaterThan(20);
  } finally {
    await peer.disconnect("2112 census done");
  }
});
