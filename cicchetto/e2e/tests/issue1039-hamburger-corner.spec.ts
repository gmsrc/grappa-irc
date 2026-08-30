// @webkit — #1039. The mobile ☰ rail opener must land on the SAME pixel on
// every window kind, so switching windows never moves the one door into the
// rail.
//
// The defect: two containers host that one control. On a channel it is a flex
// child of `.topic-bar`, placed by the bar's own `padding: 0.5rem 1rem`; on
// every other kind it is #985's float, placed by `margin: 0.25rem 0.5rem`.
// Both anchor to the same box — `.shell-main` → `.drop-upload-zone` (no
// padding) → `.topic-bar` on one side, `.shell-main` → `.shell-chrome` on the
// other — so the two offsets are directly comparable, and they disagreed:
// 0.25rem higher and 0.5rem further right on a non-channel window.
//
// Why an e2e and not a vitest: the defect IS rendered geometry, and the two
// hosts are different elements in different subtrees — no unit can compare
// where they land. jsdom has no layout engine. The SOURCE-level half (both
// rules reading one token, so they cannot drift apart again) is pinned in
// `src/__tests__/hamburgerCorner.test.ts`; what only a real engine answers is
// whether the two rectangles actually coincide.
//
// Mobile-only by construction (`ShellChrome` mounts only in Shell's
// `isMobile()` branch, and `.topic-bar-hamburger` is `display: none` above
// 768px), so this runs on webkit-iphone-15 alone — the @webkit tag; the
// chromium project grepInverts it.
//
// The third host used to be the open question here: `.admin-pane-header`
// (#1033, 2026-08-07) put the same ☰ at the pane's top-LEFT, deliberately,
// because the top-right corner was taken by its close × and refresh. #1073
// settled it by deleting the disagreement rather than unifying an offset — the
// admin pane now renders `.topic-bar` itself, so its ☰ is the same trailing
// child measured below and lands in the same corner by construction. No arm is
// added here for it: this spec's two hosts differ in their BOX (a floated
// zero-height row vs a real band), which is the thing that could drift apart,
// and admin is no longer a third box.
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: this is a UI shape
// contract, subject-shape-agnostic. The registered seed suffices.

import type { Locator } from "@playwright/test";
import {
  composeSend,
  loginAs,
  selectChannel,
  sidebarWindow,
  waitForQueryWindowReady,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

// Per-run-unique: a literal nick / channel collides with itself upstream on
// rapid reruns (--repeat-each), the rule every peer-driven spec here follows.
const RUN = crypto.randomUUID().slice(0, 8);
const PEER = `F1039${RUN}`;
const WRAP_CHANNEL = `#t1039-${RUN}`;
const CHANNEL = AUTOJOIN_CHANNELS[0];

// Both hosts derive from one `rem` pair, so an exact match is the expectation
// and any slack here is only against layout rounding. Half a pixel is two
// orders below the defect it must still catch (0.25rem = 3.5px vertical,
// 0.5rem = 7px horizontal at the 14px root), so it discriminates.
const SUBPIXEL_PX = 0.5;

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator, what: string): Promise<Box> {
  await expect(locator, `${what} must be on screen before it can be measured`).toBeVisible({
    timeout: 15_000,
  });
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${what}: visible but has no bounding box`);
  return box;
}

test.setTimeout(120_000);

test("@webkit @touch #1039 — the ☰ occupies the same rectangle on a channel and on a query window", async ({
  page,
}) => {
  const vjt = specUser();
  const marker = `t1039-${RUN}`;
  // Long enough to wrap several times in the narrow mobile strip; under
  // bahamut's TOPICLEN so the peer's exact-echo await matches (as #262).
  const longTopic =
    `${marker} a deliberately long channel topic whose only job is to make the ` +
    `topic bar's text column outgrow the hamburger, so the hamburger's vertical ` +
    `anchor is put under load instead of being measured only in the easy case`;

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // PRECONDITION — we are on the CHANNEL branch, so the ☰ we measure is the
  // TopicBar's. Without this the whole test could compare the float to itself.
  await expect(page.locator(".shell-chrome")).toHaveCount(0);
  const channelBox = await boxOf(page.locator(".topic-bar-hamburger"), "the channel ☰");

  const peer = await IrcPeer.connect({ nick: PEER });
  try {
    // Share a channel so the peer is addressable, then open + focus the query.
    await peer.join(CHANNEL);
    await composeSend(page, `/q ${PEER}`);
    await waitForQueryWindowReady(page, NETWORK_SLUG, PEER);

    // PRECONDITION — the non-channel branch: no TopicBar, so this really is
    // the float and not the same element measured twice.
    await expect(page.locator(".topic-bar")).toHaveCount(0);
    const queryBox = await boxOf(page.getByTestId("shell-chrome-rail-opener"), "the query ☰");

    // THE OUTCOME. Same rectangle, not merely same size: x/y is where #1039
    // said it jumps, width/height is what makes "same rectangle" true rather
    // than "same corner of two different boxes".
    const detail =
      `channel ☰ at (${channelBox.x}, ${channelBox.y}) ${channelBox.width}×${channelBox.height}; ` +
      `query ☰ at (${queryBox.x}, ${queryBox.y}) ${queryBox.width}×${queryBox.height}`;
    for (const axis of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(queryBox[axis] - channelBox[axis]),
        `${axis} must agree across the kind switch — ${detail}`,
      ).toBeLessThanOrEqual(SUBPIXEL_PX);
    }

    // ---- the vertical anchor under load -------------------------------
    // The horizontal case is a constant; the vertical one is not. On a channel
    // the ☰ used to be CENTRED in a bar that grows with the topic, so matching
    // only the single-line case would leave it jumping the moment the text
    // column outgrew it. `align-self: flex-start` is what pins it. Prove that
    // on a bar whose text column really is the taller child.
    await peer.join(WRAP_CHANNEL);
    await peer.topic(WRAP_CHANNEL, longTopic);
    await composeSend(page, `/join ${WRAP_CHANNEL}`);
    await expect(sidebarWindow(page, NETWORK_SLUG, WRAP_CHANNEL)).toBeVisible({ timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, WRAP_CHANNEL, { ownNick: specNick() });
    // Anti-false-green: the long topic is RENDERED before anything is measured.
    await expect(page.locator(".topic-bar-topic")).toContainText(marker, { timeout: 15_000 });

    // #262 clamps the strip to 2 lines, which may well keep the text column
    // UNDER the 48px ☰ — in which case a natural long topic does not exercise
    // the anchor at all and asserting on it would be a green that proves
    // nothing. So report the natural numbers, then force the column taller by
    // dropping the clamp inline (the #262 spec's own isolation technique) and
    // assert on a bar that is genuinely header-driven.
    const naturalHeader = (await boxOf(page.locator(".topic-bar-header"), "the header block"))
      .height;
    await page.locator(".topic-bar-topic-text").evaluate((el) => {
      const node = el as HTMLElement;
      node.style.maxHeight = "none"; // #262's backstop
      node.style.webkitLineClamp = "unset"; // #307's clamp
      void node.offsetHeight; // force synchronous reflow
    });
    const grownHeader = (await boxOf(page.locator(".topic-bar-header"), "the grown header block"))
      .height;
    const wrapBox = await boxOf(page.locator(".topic-bar-hamburger"), "the ☰ on a grown bar");

    // The leg is DISCRIMINATING: the text column really is the taller child
    // now, so a centred ☰ would sit (grownHeader - height) / 2 lower.
    expect(
      grownHeader,
      `the header block (${grownHeader}px, ${naturalHeader}px before the clamp was dropped) must ` +
        `outgrow the ☰ (${wrapBox.height}px) or this leg cannot tell a pinned anchor from a centred one`,
    ).toBeGreaterThan(wrapBox.height);

    expect(
      Math.abs(wrapBox.y - channelBox.y),
      `the ☰ must not move when the topic column outgrows it — pinned at y=${channelBox.y}, ` +
        `measured y=${wrapBox.y} on a ${grownHeader}px header (a centred ☰ lands ~${
          channelBox.y + (grownHeader - wrapBox.height) / 2
        })`,
    ).toBeLessThanOrEqual(SUBPIXEL_PX);
  } finally {
    await composeSend(page, `/part ${WRAP_CHANNEL}`).catch(() => {});
    await peer.disconnect("t1039 done").catch(() => {});
  }
});
