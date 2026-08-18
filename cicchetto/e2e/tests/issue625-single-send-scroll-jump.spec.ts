// Issue #625 — a single send must NOT jump the pane UP before it settles at
// the tail. (Refs #608 — the single-scroll-authority refactor whose headline
// promise "no double scroll" this pins.)
//
// ## The field report (vjt, staging serving main)
//
// After sending a message the pane scrolls "too far up" and then falls back
// down to the bottom. Discriminating facts from vjt's observations:
//   1. it happens on a SINGLE send, not only in rapid succession — so it is
//      not two writes racing IN FLIGHT; it is two writes in sequence per send;
//   2. "something resets the scroll after a while" — the errant write is
//      DELAYED (a timer / a later render), NOT synchronous with the keypress.
//
// Consequence for the test: a snapshot taken right after the send finds the
// pane at the bottom and FALSE-GREENs. The bug is only visible by sampling the
// scroll geometry OVER TIME, across a window that outlasts every #608 deferred
// writer (the tail-follow's SETTLE_MAX_FRAMES ≈ 0.5s poll, the 0.5s
// scroll-settle / presence-settle timers). This spec samples for ~2.5s.
//
// ## The invariant
//
// The reader is following (or has just sent, which #608 arms follow). After a
// send the pane is carried DOWN with the new tail and must STAY there — it must
// never travel back UP. Appending one short line lifts distance-to-tail by ≪
// the 50px bottom threshold, so any sample above the threshold AFTER the pane
// first reached the tail means the pane was dragged away — the "too far up"
// jump.
//
// Harness mirrors issue580 (DB-seeded 200-row #bofh; tiny 800×300 viewport so
// the buffer overflows and scroll geometry is measurable).

import type { Page } from "@playwright/test";
import {
  composeSend,
  loginAs,
  scrollbackLines,
  selectChannel,
  waitForScrollbackRefreshed,
} from "../fixtures/cicchettoPage";
import {
  fetchScrollbackPage,
  restoreReadCursorToTail,
  setReadCursorToId,
} from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Mirror of ScrollbackPane.SCROLL_BOTTOM_THRESHOLD_PX = 50 (not exported; kept
// in lockstep by hand — same as issue168 / cp14-b1 / issue580).
const SCROLL_BOTTOM_THRESHOLD_PX = 50;

// REST default page size (Grappa.Web.MessagesController.@default_limit).
const REST_PAGE_SIZE = 50;

// Sampling window — must outlast every #608 deferred writer. SETTLE_MAX_FRAMES
// (30) ≈ 0.5s, SCROLL_SETTLE_DEBOUNCE_MS = 500, PRESENCE_CURSOR_SETTLE_MS = 500.
const SAMPLE_WINDOW_MS = 2500;

// A single send's ONE legitimate tail-follow fires at frame 0 of its poll (with
// the WS echo). The regression's SECOND write is the fail-safe of a redundant
// follow-on poll, landing SETTLE_MAX_FRAMES ≈ 0.5s LATER. We measure that gap
// from the FIRST observed write, NOT from probe-install: the echo's own latency
// (fill+press CDP round-trip + WS round-trip, tolerated up to 10s below) floats
// the legitimate write's absolute timestamp, so an absolute cutoff would
// false-RED on a slow run. The defect IS the ~0.5s gap between two writes.
const SETTLE_GRACE_MS = 300;

// The delayed double-scroll: any container scroll write that lands more than the
// grace window AFTER the send's first (legitimate) tail-follow write.
function delayedWrites(writes: readonly WriteEvent[]): WriteEvent[] {
  if (writes.length === 0) return [];
  const first = writes[0] as WriteEvent;
  return writes.filter((w) => w.t - first.t > SETTLE_GRACE_MS);
}

type Sample = { t: number; top: number; height: number; client: number };
type WriteEvent = { t: number; kind: string; detail: string; before: number };

async function distanceToBottom(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) throw new Error("scrollback container not found");
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  });
}

// Install an in-page sampler + a scroll-write spy on the scrollback container,
// BEFORE the send. The sampler records the geometry on every native `scroll`
// event AND on a rAF tick (to catch a programmatic write that lands between
// scroll events), for SAMPLE_WINDOW_MS. The spy wraps `scrollIntoView` + the
// `scrollTop` setter (page-context only — no production behaviour changes).
async function installScrollProbe(page: Page, windowMs: number): Promise<void> {
  await page.evaluate((windowMsArg) => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) throw new Error("scrollback container not found for probe");
    type Sample = { t: number; top: number; height: number; client: number };
    type WriteEvent = { t: number; kind: string; detail: string; before: number };
    const w = window as unknown as { __i625samples: Sample[]; __i625writes: WriteEvent[] };
    w.__i625samples = [];
    w.__i625writes = [];
    const t0 = performance.now();
    const now = () => performance.now() - t0;

    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    const getTop = () => (desc?.get ? (desc.get.call(el) as number) : el.scrollTop);

    if (desc?.get && desc?.set) {
      Object.defineProperty(el, "scrollTop", {
        configurable: true,
        get() {
          return desc.get?.call(this);
        },
        set(v: number) {
          w.__i625writes.push({
            t: Math.round(now()),
            kind: "scrollTop=",
            detail: String(Math.round(v)),
            before: Math.round(getTop()),
          });
          desc.set?.call(this, v);
        },
      });
    }

    const rawSIV = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (arg?: boolean | ScrollIntoViewOptions) {
      if (this === el || el.contains(this as Node)) {
        w.__i625writes.push({
          t: Math.round(now()),
          kind: "scrollIntoView",
          detail: JSON.stringify(arg ?? null),
          before: Math.round(getTop()),
        });
      }
      return rawSIV.call(this, arg as ScrollIntoViewOptions);
    };

    const sample = () => {
      w.__i625samples.push({
        t: Math.round(now()),
        top: Math.round(getTop()),
        height: el.scrollHeight,
        client: el.clientHeight,
      });
    };
    sample();
    el.addEventListener("scroll", sample, { passive: true });
    const loop = () => {
      sample();
      if (now() < windowMsArg) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }, windowMs);
}

// On failure this dump is the whole story: `writes` names every container scroll
// write + its timestamp (the delayed double-scroll shows as a second entry ~0.5s
// in), `topChanges` is the compressed scrollTop timeline.
async function dumpEvidence(
  page: Page,
  tag: string,
): Promise<{ samples: Sample[]; writes: WriteEvent[] }> {
  const samples = await page.evaluate(
    () => (window as unknown as { __i625samples: Sample[] }).__i625samples,
  );
  const writes = await page.evaluate(
    () => (window as unknown as { __i625writes: WriteEvent[] }).__i625writes,
  );
  const dist = (s: Sample) => Math.round(s.height - s.top - s.client);
  const compact: Array<{ t: number; top: number; d: number }> = [];
  let prevTop = Number.NaN;
  for (const s of samples) {
    if (s.top !== prevTop) {
      compact.push({ t: s.t, top: s.top, d: dist(s) });
      prevTop = s.top;
    }
  }
  console.log(`[#625 ${tag}] writes=${JSON.stringify(writes)}`);
  console.log(`[#625 ${tag}] topChanges=${JSON.stringify(compact)}`);
  return { samples, writes };
}

const distOf = (s: Sample) => s.height - s.top - s.client;

test.describe("issue #625 — a single send must not jump the pane up before settling", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  test("send while at the tail: distance-to-tail never spikes up over 2.5s", async ({ page }) => {
    const vjt = specUser();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await waitForScrollbackRefreshed(page, NETWORK_SLUG, CHANNEL);

    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    await expect
      .poll(async () => await distanceToBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);

    await installScrollProbe(page, SAMPLE_WINDOW_MS);
    const marker = `i625 at-tail ${Date.now()}`;
    await composeSend(page, marker);

    const sentLine = scrollbackLines(page).filter({ hasText: marker });
    await expect(sentLine).toHaveCount(1, { timeout: 10_000 });
    await page.waitForTimeout(SAMPLE_WINDOW_MS + 200);

    const { samples, writes } = await dumpEvidence(page, "at-tail");
    expect(samples.length).toBeGreaterThan(10);

    // #625 CORE — no DELAYED second scroll write. A single send performs ONE
    // tail-follow; the regression's redundant follow-on poll fires its fail-safe
    // scroll ~0.5s later. RED on main; GREEN once that write is suppressed.
    expect(
      writes.length,
      `expected the send's tail-follow write; writes=${JSON.stringify(writes)}`,
    ).toBeGreaterThanOrEqual(1);
    const late = delayedWrites(writes);
    expect(
      late,
      `delayed scroll write(s) after the send's tail-follow: ${JSON.stringify(writes)}`,
    ).toEqual([]);

    // Visible-symptom guard: following a send, the pane never travels UP.
    const maxDist = Math.max(...samples.map(distOf));
    expect(maxDist).toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
    await expect(sentLine).toBeInViewport();
  });

  test("send while reading history (unread marker): pane settles at tail and stays", async ({
    page,
  }) => {
    const vjt = specUser();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    // Mid-page cursor → cold-mount lands on the unread marker, ABOVE the fold:
    // the reader is parked in history when they send (vjt's scenario).
    const page0 = await fetchScrollbackPage(vjt.token, NETWORK_SLUG, CHANNEL);
    expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const cursorRow = page0[25];
    if (!cursorRow) throw new Error("seeded page too short for cursor placement");
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, cursorRow.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await waitForScrollbackRefreshed(page, NETWORK_SLUG, CHANNEL);

    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(1);
    // Parked in history, above the fold.
    await expect
      .poll(async () => await distanceToBottom(page), { timeout: 10_000 })
      .toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);

    await installScrollProbe(page, SAMPLE_WINDOW_MS);
    const marker = `i625 from-history ${Date.now()}`;
    await composeSend(page, marker);

    const sentLine = scrollbackLines(page).filter({ hasText: marker });
    await expect(sentLine).toHaveCount(1, { timeout: 10_000 });
    await page.waitForTimeout(SAMPLE_WINDOW_MS + 200);

    const { samples, writes } = await dumpEvidence(page, "from-history");
    expect(samples.length).toBeGreaterThan(10);

    // #625 CORE — same invariant as the at-tail case: a single send must not fire
    // a DELAYED second scroll write. (Here the follow-on rows change is the marker
    // collapse, which cannot settle and hits the fail-safe.)
    expect(
      writes.length,
      `expected the send's tail-follow write; writes=${JSON.stringify(writes)}`,
    ).toBeGreaterThanOrEqual(1);
    const late = delayedWrites(writes);
    expect(
      late,
      `delayed scroll write(s) after the send's tail-follow: ${JSON.stringify(writes)}`,
    ).toEqual([]);

    // #608: a send follows the tail unconditionally → the pane reaches the bottom.
    // Once there, it STAYS (a delayed writer would drag it back UP).
    const firstAtTail = samples.findIndex((s) => distOf(s) <= SCROLL_BOTTOM_THRESHOLD_PX);
    expect(firstAtTail).toBeGreaterThanOrEqual(0);
    const afterSettle = samples.slice(firstAtTail);
    const maxAfterSettle = Math.max(...afterSettle.map(distOf));
    expect(maxAfterSettle).toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
    await expect(sentLine).toBeInViewport();
  });
});
