// #984 — the QUERY branch of the rail had no scroll owner, so a tall WHOIS
// bundle pushed the `.rail-actions` launcher below the fold. vjt hit it on
// iPhone with the keyboard up (the drawer's height tracks `--viewport-height`,
// so the keyboard IS the fold), but the mechanism is form-factor-independent:
// `.shell-members` is `overflow-y: visible` by decision (#500 — the launcher's
// absolute overlay menu must not be clipped), which means an inner child has to
// own the scroll. `.members-pane` does; `.rail-query-context` was `flex: 0 0
// auto`, i.e. never shrink, no internal scroll.
//
// This is the exact twin of `issue500-rail-launcher-overflow`, one window kind
// over, and it is asserted the same way and for the same reason: boundingBox,
// never a plain click. Playwright auto-scrolls an element into its scroll
// container before clicking, so a click would MASK the defect. And never
// `getComputedStyle` for the reachability question — a computed-style
// assertion under device emulation has already lied once (#963). Geometry is
// the outcome the operator actually experiences.
//
// The second test covers the half no desktop assertion can see. The fix has a
// touch component: the mobile drawer sits under the `.shell-mobile {
// touch-action: none }` blanket (UX-3 PENT), so a NEW scroller must re-assert
// `pan-y` on itself AND on its subtree (touch-action does not inherit, CSS UI
// L4 — UX-6 bucket A v2). Without it the card scrolls under a mouse and
// refuses to scroll under a finger. There is no geometry for a gesture
// contract; the computed-style assertion on the webkit-iPhone project is the
// established shape for it (`ux-6-a-mobile-members-scroll.spec.ts`), and
// touch-action is not the paint-adjacent property #963 caught lying.

import {
  composeSend,
  loginAs,
  openMembersDrawer,
  selectChannel,
  waitForQueryWindowReady,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

// Unique suffix so retries / sibling specs never collide on a nick already in
// use upstream (same rule as issue606-query-rail-whois).
const RUN_ID = crypto.randomUUID().slice(0, 8);
const PEER = `Q984${RUN_ID}`;
const CHANNEL = AUTOJOIN_CHANNELS[0];

// A long realname is what makes the card GENUINELY overflow rather than merely
// fit-with-no-margin. The rail track is capped at `fit-content(14rem)` (#605)
// and `.whois-card-fields dd` is `word-break: break-word`, so this wraps into
// many rows inside a narrow card — the same shape as a real gecos, just longer.
// A short bundle would false-pass against the BROKEN build (nothing overflows,
// nothing is pushed anywhere), which is the trap #500's spec calls out.
const LONG_GECOS = "a deliberately long realname so the rail whois card overflows a short viewport";

// Short enough that the stacked WHOIS card cannot fit — the fold has to bite.
const SHORT_VIEWPORT = { width: 1280, height: 220 };

// Peer connect + upstream WHOIS round-trip + a viewport-resize reflow.
test.setTimeout(90_000);

test("#984 — a tall query WHOIS card keeps the rail launcher reachable", async ({ page }) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const peer = await IrcPeer.connect({ nick: PEER, gecos: LONG_GECOS });
  try {
    // Share a channel so the peer is WHOIS-able and the bundle carries a
    // channels line (one more row of card height).
    await peer.join(CHANNEL);

    await composeSend(page, `/q ${PEER}`);
    await waitForQueryWindowReady(page, NETWORK_SLUG, PEER);

    // Wait for the card to actually render before shrinking — the fetch is a
    // real upstream round-trip, and resizing against an empty card would
    // measure nothing.
    const rail = page.locator(".shell-members");
    const ctx = rail.getByTestId("rail-query-context");
    await expect(ctx).toBeVisible({ timeout: 5_000 });
    const railCard = rail.getByTestId("whois-card");
    await expect(railCard).toBeVisible({ timeout: 8_000 });
    await expect(railCard.locator(".whois-card-target")).toHaveText(PEER);

    await page.setViewportSize(SHORT_VIEWPORT);

    // Precondition — the card CONTENT is genuinely taller than the rail column
    // that has to hold it. Deliberately NOT `ctx.scrollHeight >
    // ctx.clientHeight`: that phrasing is the fix's own symptom (pre-fix the
    // context is not a scroll container at all, so its two heights are equal
    // and the precondition would fail for the wrong reason, telling us nothing
    // about whether the scenario was reproduced). Content-vs-column holds on
    // both sides of the fix and is what "the launcher gets pushed out" means.
    const overflows = await ctx.evaluate((el) => {
      const aside = el.closest(".shell-members");
      return aside !== null && el.scrollHeight > aside.clientHeight;
    });
    expect(overflows, "the whois card must overflow the rail for this test to mean anything").toBe(
      true,
    );

    // THE DEFECT: the launcher must still be inside the viewport. boundingBox
    // is viewport-relative and does NOT scroll, so a launcher pushed past the
    // fold by a non-shrinking card reports a y beyond it here.
    const launcher = page.getByTestId("rail-actions-launcher");
    await expect(launcher).toBeVisible();
    const box = await launcher.boundingBox();
    expect(box, "launcher must have a layout box").not.toBeNull();
    if (box) {
      expect(box.y, "launcher must not be above the viewport top").toBeGreaterThanOrEqual(0);
      expect(
        box.y + box.height,
        "launcher must not be pushed below the fold by the whois card",
      ).toBeLessThanOrEqual(SHORT_VIEWPORT.height + 1);
    }
  } finally {
    await peer.disconnect("#984 done");
  }
});

test("@webkit @touch #984 — the query rail scroller carries pan-y, and so does its subtree", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const peer = await IrcPeer.connect({ nick: `M${PEER}`, gecos: LONG_GECOS });
  try {
    await peer.join(CHANNEL);
    await composeSend(page, `/q M${PEER}`);
    await waitForQueryWindowReady(page, NETWORK_SLUG, `M${PEER}`);

    await openMembersDrawer(page);
    const ctx = page.locator(".shell-mobile .shell-members .rail-query-context");
    await expect(ctx).toBeVisible({ timeout: 5_000 });
    await expect(ctx.getByTestId("whois-card")).toBeVisible({ timeout: 8_000 });

    // The scroller itself: it owns the overflow, so it must own the gesture.
    const scroller = await ctx.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        overflowY: cs.overflowY,
        touchAction: cs.touchAction,
        overscrollBehaviorY: cs.overscrollBehaviorY,
      };
    });
    expect(scroller.overflowY).toBe("auto");
    expect(scroller.touchAction).toBe("pan-y");
    expect(scroller.overscrollBehaviorY).toBe("contain");

    // And the subtree: `touch-action` does not inherit, so a drag whose
    // hit-test target is a card row would otherwise be routed by that
    // descendant's default `auto` to a non-root scroll ancestor — `<body>`
    // with the keyboard up — and the scroller's own pan-y never fires. This is
    // the UX-6 bucket A v2 finding, re-applied to the query branch.
    const rowTouchAction = await ctx
      .locator(".whois-card-fields dd")
      .first()
      .evaluate((el) => getComputedStyle(el).touchAction);
    expect(rowTouchAction).toBe("pan-y");
  } finally {
    await peer.disconnect("#984 mobile done");
  }
});
