// Login Advanced-section reachability — the login card must SCROLL so its
// full content stays reachable when it exceeds a short viewport.
//
// ## The bug (measured on current code)
//
// `.login` was `display:flex; align-items:center; justify-content:center;
// min-height:100%; overflow:hidden`. Open the Advanced disclosure and the
// `.login-form` grows to ~643px; on a 480px viewport it overflows. But NO
// ancestor is a scroll container (`overflow:hidden` clips, nothing offers
// `auto`), so a real user wheel/touch gesture scrolls NOTHING — Connect (and
// the realname/ident inputs in the disclosure, plus the always-visible
// password field at the top) sit permanently off-screen, unreachable.
// `overflow:hidden` was deliberate (it blocks the iOS document-drag-chrome
// bug), so the fix makes the card scroll INTERNALLY without letting the
// document overflow.
//
// ## Why a REAL wheel gesture, not scrollIntoViewIfNeeded
//
// `locator.scrollIntoViewIfNeeded()` sets `scrollTop` PROGRAMMATICALLY, which
// bypasses `overflow:hidden` — so it "reaches" Connect even on the broken
// code and would GREEN-wash the bug. A user has only wheel/touch, which
// `overflow:hidden` blocks. This spec drives the wheel the operator actually
// has, so it is RED on the clipped layout and GREEN only once a real scroll
// container exists.
//
// RED pre-fix: wheel scrolls nothing → Connect never enters the viewport →
// the poll times out. GREEN post-fix: the card scrolls, both ends reachable.
//
// No auth is seeded (we test the login screen itself). We DO seed
// `cic.installChoice = "browser"` so the install splash doesn't overlay the
// form (mirror of issue204-foolproof-login).

import { expect, test } from "@playwright/test";

test.describe("login Advanced section stays reachable on a short viewport", () => {
  // Short enough that the open Advanced form (brand + nick + password + hint +
  // toggle + realname + ident + hint + Connect) overflows. #284 moved the
  // password OUT to the main form above the toggle; realname + ident are the
  // disclosure content below it.
  test.use({ viewport: { width: 390, height: 480 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("cic.installChoice", "browser");
    });
    await page.goto("/login");
    await expect(page.getByLabel(/nick or email/i)).toBeVisible({ timeout: 10_000 });
  });

  test("open Advanced → wheel reaches Connect (bottom) then password (top)", async ({ page }) => {
    const connect = page.getByRole("button", { name: /^connect$/i });
    const password = page.getByLabel(/password/i);
    const realname = page.getByLabel(/real name/i);

    // Open the disclosure so the form grows past the viewport.
    await page.getByRole("button", { name: /advanced/i }).click();
    await expect(realname).toBeVisible();

    // Sanity: the form overflows this short viewport — Connect sits below the
    // fold before any scroll. If this ever fails the viewport got too tall and
    // the rest of the test would be vacuous.
    await expect(connect).not.toBeInViewport();

    // A scroll container must exist and actually overflow (reinforces the
    // outcome below; fails loud if a refactor removes the scroller). RED
    // pre-fix: no ancestor has overflow-y:auto/scroll with content taller than
    // its box.
    const hasScroller = await page.evaluate(() => {
      let el: Element | null = document.querySelector(".login-connect");
      while (el) {
        const cs = getComputedStyle(el);
        const e = el as HTMLElement;
        if (["auto", "scroll"].includes(cs.overflowY) && e.scrollHeight > e.clientHeight) {
          return true;
        }
        el = el.parentElement;
      }
      return false;
    });
    expect(hasScroller).toBe(true);

    // Wheel DOWN over the login area — the operator's real gesture. Poll:
    // keep wheeling until Connect enters the viewport. RED pre-fix: nothing
    // scrolls, Connect never appears, the poll times out.
    await page.locator("main.login").hover();
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, 600);
          return await connect.isVisible().then(() =>
            connect.evaluate((el) => {
              const r = el.getBoundingClientRect();
              return r.top >= 0 && r.bottom <= window.innerHeight;
            }),
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect(connect).toBeInViewport();
    await expect(connect).toBeEnabled();
    // #284's witness here was `realname`, the disclosure's TOP, on the claim
    // that it sits immediately above Connect. #1322 put two more rows between
    // them, so at 390x480 the disclosure no longer fits alongside Connect and
    // that assertion would now be demanding the impossible. The intent —
    // "a regression that clips ONLY the disclosure is caught here, not masked
    // by Connect" — is kept by witnessing the disclosure's BOTTOM instead,
    // which is what is genuinely adjacent to Connect now. The top end is
    // asserted on the upward leg below, so neither end goes unwatched.
    await expect(page.getByRole("button", { name: /^recovery code$/i })).toBeInViewport();

    // Wheel back UP — the TOP of the card must be reachable too (the
    // centered-clip bug clipped BOTH ends). Pass through the disclosure's top
    // (realname) on the way to the always-visible password field, so a clip
    // that swallowed only the middle of the card cannot hide between them.
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, -600);
          return await realname.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= window.innerHeight;
          });
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect(realname).toBeInViewport();

    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, -600);
          return await password.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= window.innerHeight;
          });
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect(password).toBeInViewport();
  });
});

test.describe("login on a tall viewport — fix must not break the common case", () => {
  // Desktop-shaped. Guards the margin:auto centering — the fix must not push
  // the card off-screen or make anything unreachable when there's room.
  test.use({ viewport: { width: 1024, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("cic.installChoice", "browser");
    });
    await page.goto("/login");
    await expect(page.getByLabel(/nick or email/i)).toBeVisible({ timeout: 10_000 });
  });

  // #1322 — the COLLAPSED view keeps the strict assertion, and gains from the
  // move: the alt-auth pair left this view, so the card is one 44px row
  // SHORTER than it was on #442's layout. Asserting their absence next to the
  // no-scroll claim ties the height win to its cause, so a future change that
  // puts a button back here reds the geometry test that pays for it.
  test("collapsed → every control is visible with no scroll at all", async ({ page }) => {
    await expect(page.getByRole("button", { name: /^passkey$/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^recovery code$/i })).toHaveCount(0);

    await expect(page.getByLabel(/nick or email/i)).toBeInViewport();
    await expect(page.getByLabel(/password/i)).toBeInViewport();
    await expect(page.getByRole("button", { name: /advanced/i })).toBeInViewport();
    await expect(page.getByRole("button", { name: /^connect$/i })).toBeInViewport();

    // No wheel was driven above, so nothing may have scrolled to get there.
    const scrolled = await page.evaluate(() => {
      const scroller = document.querySelector(".login-scroll");
      return (scroller?.scrollTop ?? 0) + window.scrollY;
    });
    expect(scrolled).toBe(0);
  });

  // #1322 — with Advanced OPEN the height constraint is relaxed by ruling: a
  // scroll is acceptable, so the contract is REACHABILITY, not fit. Driven
  // with the real wheel rather than scrollIntoViewIfNeeded for the reason in
  // this file's header — a programmatic scrollTop bypasses `overflow:hidden`
  // and would green-wash a card that a user cannot actually scroll. The
  // assertion is deliberately agnostic to whether the card overflows at this
  // size: if it fits, the first poll iteration already finds the control in
  // view; if it does not, the wheel brings it there. That is what "relax the
  // height" has to mean for a spec that must not need relaxing again.
  const reachableByWheel = async (
    page: import("@playwright/test").Page,
    target: import("@playwright/test").Locator,
    direction: -1 | 1,
  ) => {
    await page.locator("main.login").hover();
    await expect
      .poll(
        async () => {
          const inView = await target.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= window.innerHeight;
          });
          if (inView) return true;
          await page.mouse.wheel(0, direction * 400);
          return false;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  };

  test("open Advanced → every field, both alt-auth doors and Connect are reachable", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /advanced/i }).click();
    await expect(page.getByLabel(/real name/i)).toBeVisible();

    // Downward leg: everything from the disclosure's own fields to Connect.
    for (const target of [
      page.getByLabel(/real name/i),
      page.getByLabel(/^ident$/i),
      page.getByRole("button", { name: /^passkey$/i }),
      page.getByRole("button", { name: /^recovery code$/i }),
      page.getByRole("button", { name: /^connect$/i }),
    ]) {
      await reachableByWheel(page, target, 1);
      await expect(target).toBeInViewport();
      // Reachable is not enough — the ruling says reachable AND clickable.
      await expect(target).toBeEnabled();
    }

    // Upward leg: the TOP of the card must come back. A layout that reaches
    // Connect by clipping the head of the card fails here.
    await reachableByWheel(page, page.getByLabel(/password/i), -1);
    await expect(page.getByLabel(/password/i)).toBeInViewport();
  });
});
