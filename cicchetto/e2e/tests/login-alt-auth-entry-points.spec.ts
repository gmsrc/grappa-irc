// #712 — the login card's alternate-auth entry points (Passkey / Recovery
// code, shipped in #696 / refs #442) had ZERO direct coverage.
//
// ## Why this spec exists
//
// Both regressions that held #696 back for three CI rounds were caught by
// specs that only *neighbour* these buttons:
//
//   * `issue281-account-switch-no-replay` — strict-mode violation, because
//     the new buttons reused the `.login-advanced-toggle` class and the
//     visitor branch then rendered three of them.
//   * `login-advanced-scroll-reachability` — the buttons added a ROW to the
//     card, pushing Connect out of the viewport at 390x480 and at 1024x900.
//
// Nothing asserted that the controls themselves render, are reachable, or do
// anything when clicked. This spec closes that: it guards the two failure
// modes that already happened (the selector contract, the card geometry) AND
// the behaviour nobody was watching (click → the ceremony actually fires;
// keyboard order with Connect still last).
//
// ## What is deliberately NOT asserted
//
// The WebAuthn ceremony itself. `onPasskeyLogin` calls
// `POST /auth/passkeys/options` FIRST and only reaches
// `navigator.credentials.get()` on a 200. An identifier with no passwordless
// account 401s at the options step, so the whole click→request→user-visible-
// error path is exercised without a virtual authenticator — and stays
// browser-agnostic. Driving a real assertion needs a CDP virtual
// authenticator (chromium-only) and belongs to a passkey *registration*
// spec, not to this entry-point one.
//
// No auth is seeded (this is the login screen itself). `cic.installChoice`
// is seeded so the install splash doesn't overlay the form — mirror of
// issue204-foolproof-login and login-advanced-scroll-reachability.

import { expect, type Page, test } from "@playwright/test";

// Per-run unique so a re-run (`--repeat-each`) never depends on, or leaves
// behind, account state. Letters-first + digits keeps it inside the nick
// grammar `classifyLoginIdentifier` enforces, so the value reaches the
// server instead of tripping the client-side inline validator.
const probeIdentifier = (): string => `p712probe${Date.now()}`;

async function openLogin(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("cic.installChoice", "browser");
  });
  await page.goto("/login");
  await expect(page.getByLabel(/nick or email/i)).toBeVisible({ timeout: 10_000 });
  // Every geometry assertion below is in px; a late webfont swap would
  // reflow the card underneath the measurement.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

const passkeyButton = (page: Page) => page.getByRole("button", { name: /^passkey$/i });
const recoveryButton = (page: Page) => page.getByRole("button", { name: /^recovery code$/i });
const connectButton = (page: Page) => page.getByRole("button", { name: /^connect$/i });

// #1322 — both doors now live behind the Advanced disclosure, so every test
// below that touches them opens it first. Written out at each call site
// rather than hidden in `openLogin`, because "you must open Advanced to get
// here" IS the behaviour this issue introduced and a spec that buries it in
// setup stops asserting it.
async function openAdvanced(page: Page): Promise<void> {
  await page.getByRole("button", { name: /advanced/i }).click();
  await expect(page.getByLabel(/real name/i)).toBeVisible();
}

test.describe("login alt-auth entry points — 390x480 (shortest supported viewport)", () => {
  test.use({ viewport: { width: 390, height: 480 } });

  test.beforeEach(async ({ page }) => {
    await openLogin(page);
  });

  test("both doors stay hidden until Advanced opens, and keep the toggle selector single", async ({
    page,
  }) => {
    // #1322 — the collapsed card is the default view; neither door is in it.
    // `toHaveCount(0)` and not `not.toBeVisible()`: the disclosure is a
    // conditional render, so the absence is from the DOM, not a style.
    await expect(passkeyButton(page)).toHaveCount(0);
    await expect(recoveryButton(page)).toHaveCount(0);
    await expect(page.locator(".login-alt-auth")).toHaveCount(0);
    // The toggle's own count is invariant across the disclosure — that is
    // the issue281 contract, and it must not move when the pair does.
    await expect(page.locator(".login-advanced-toggle")).toHaveCount(1);

    await openAdvanced(page);

    await expect(passkeyButton(page)).toBeVisible();
    await expect(recoveryButton(page)).toBeVisible();
    await expect(page.locator(".login-alt-auth")).toHaveCount(2);
    await expect(page.locator(".login-advanced-toggle")).toHaveCount(1);

    // #204 tap-target rule: `--tap-min` is an absolute 44px (the root font
    // is 14px here, so a rem-based assertion would silently under-measure).
    // The ruling picked full 44px buttons over compact text actions, so this
    // is the floor that choice has to keep paying.
    for (const control of [passkeyButton(page), recoveryButton(page)]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  test("each door gets its own row inside the disclosure", async ({ page }) => {
    // #1322 inverts #442: the pair no longer rides the toggle's row. The
    // oracle is the pair's own geometry — on the superseded layout all three
    // boxes shared a `y`, so "stacked" is exactly the assertion that was
    // false before and is true now, and it fails at the CAUSE rather than at
    // some downstream viewport symptom.
    await openAdvanced(page);

    const panel = page.locator("#login-advanced");
    await expect(panel.locator(".login-alt-auth")).toHaveCount(2);

    const passkey = await passkeyButton(page).boundingBox();
    const recovery = await recoveryButton(page).boundingBox();
    const toggle = await page.locator(".login-alt-auth-row .login-advanced-toggle").boundingBox();
    expect(passkey).not.toBeNull();
    expect(recovery).not.toBeNull();
    expect(toggle).not.toBeNull();

    // Recovery starts at or below where Passkey ends: two rows, not one.
    expect(recovery?.y ?? 0).toBeGreaterThanOrEqual((passkey?.y ?? 0) + (passkey?.height ?? 0));
    // And neither shares the toggle's row any more.
    expect(passkey?.y ?? 0).toBeGreaterThanOrEqual((toggle?.y ?? 0) + (toggle?.height ?? 0));
  });

  test("Passkey with an empty identifier surfaces the inline prompt, no request", async ({
    page,
  }) => {
    // Pure client-side arm of `passkeyIdentifier()`: an empty field must be
    // named as the blocker instead of firing a doomed ceremony.
    let requested = false;
    await page.route("**/auth/passkeys/**", async (route) => {
      requested = true;
      await route.continue();
    });

    await openAdvanced(page);
    await passkeyButton(page).click();
    await expect(page.getByRole("alert")).toHaveText(/account name or email/i);
    expect(requested).toBe(false);

    // Positive control (#1117 / #1336). `requested` stays false both when
    // the client-side validator blocks the ceremony — what this test is
    // for — and when the route glob stopped matching the passkey
    // endpoints, which is a broken instrument reading as a pass. The
    // sibling test below fires the ceremony, but it registers its own
    // waiter: nothing in THIS test proves THIS registration is live.
    // Fill the identifier the validator was missing and click again — the
    // options POST then travels through the same `**/auth/passkeys/**`
    // handler asserted silent above.
    await page.getByLabel(/nick or email/i).fill(probeIdentifier());
    await passkeyButton(page).click();
    await expect.poll(() => requested, { timeout: 10_000 }).toBe(true);
  });

  test("Passkey with an identifier fires the ceremony request and reports the refusal", async ({
    page,
  }) => {
    const identifier = probeIdentifier();
    await page.getByLabel(/nick or email/i).fill(identifier);
    await openAdvanced(page);

    // Armed BEFORE the click — a waiter installed after the action races the
    // response and can miss the request entirely.
    const optionsRequest = page.waitForRequest(
      (r) => r.url().includes("/auth/passkeys/options") && r.method() === "POST",
      { timeout: 10_000 },
    );
    await passkeyButton(page).click();
    const request = await optionsRequest;
    expect(request.postDataJSON()).toEqual({ identifier });

    // No passwordless account answers that identifier, so the options step
    // 401s and the user gets told so. The negative assert is the important
    // half: it proves we got PAST the client-side validator rather than
    // greening on the same alert the empty-field case produces.
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).not.toHaveText(/account name or email/i);
    await expect(alert).toHaveText(/invalid name or password/i);
  });

  test("Recovery code reveals its field and a bogus code is reported", async ({ page }) => {
    const identifier = probeIdentifier();
    await page.getByLabel(/nick or email/i).fill(identifier);
    await openAdvanced(page);

    const recoveryField = page.locator("#login-recovery-code");
    await expect(recoveryField).toBeHidden();
    await recoveryButton(page).click();
    // #1322/#724 — the field must be revealed INSIDE the panel it was opened
    // from. Its enclosing form is unchanged (that is what keeps the Enter
    // swallow honest), so escaping the panel would be a silent regression
    // that no behavioural assertion below would notice.
    await expect(page.locator("#login-advanced #login-recovery-code")).toHaveCount(1);
    // `toBeVisible`, deliberately NOT `toBeInViewport`: an earlier draft
    // asserted the latter and a mutation run proved it fires on card
    // GEOMETRY (a taller card pushes the revealed field below the fold),
    // which is this file's tests 2 and 7 and, at this viewport,
    // login-advanced-scroll-reachability — which drives a real wheel
    // gesture rather than a static viewport check. Keeping it here would
    // duplicate that guard under a title about recovery behaviour, and put
    // an unbounded margin between the assert and a flake.
    await expect(recoveryField).toBeVisible();

    await recoveryField.fill("0000-0000");
    const recoverRequest = page.waitForRequest(
      (r) => r.url().includes("/auth/passkeys/recover") && r.method() === "POST",
      { timeout: 10_000 },
    );
    await page.getByRole("button", { name: /^recover account$/i }).click();
    const request = await recoverRequest;
    expect(request.postDataJSON()).toEqual({ identifier, recovery_code: "0000-0000" });

    await expect(page.getByRole("alert")).toHaveText(/invalid or already-used/i);

    // The toggle is a toggle: clicking again puts the card back the way it
    // was, so an aborted recovery doesn't strand an orphan field.
    await recoveryButton(page).click();
    await expect(recoveryField).toBeHidden();
  });

  test("both doors are keyboard-reachable inside Advanced and Connect is still last", async ({
    page,
  }) => {
    // #1322 — the collapsed tab walk is now THREE stops. Pinned exactly,
    // because "the default view got shorter" is the win this issue bought
    // and an extra stop appearing here is precisely how it would be spent.
    // The toggle carries a ▸/▾ glyph in its label; match it loosely so the
    // ORDER is what's under test, not the disclosure's copy.
    await page.getByLabel(/nick or email/i).focus();
    const collapsed = await tabThroughForm(page);
    expect(collapsed).toEqual(["login-password", expect.stringMatching(/advanced/i), "Connect"]);

    // Expanded: the pair is now INSIDE the panel, so it must follow the
    // panel's own fields rather than precede them, and Connect must remain
    // the tail — a row appended after it would strand the primary CTA behind
    // the whole form. Asserted by relative order, not as a frozen list: the
    // panel's contents are a product decision that has already changed twice
    // (#152 realname/ident, #363 incognito), and re-pinning the whole walk
    // every time would make this test about the panel, not about the doors.
    await page.reload();
    await expect(page.getByLabel(/nick or email/i)).toBeVisible();
    await openAdvanced(page);
    await recoveryButton(page).click();
    await page.getByLabel(/nick or email/i).focus();
    const expanded = await tabThroughForm(page);

    expect(expanded.slice(0, 2)).toEqual(["login-password", expect.stringMatching(/advanced/i)]);
    const at = (needle: string) => expanded.indexOf(needle);
    expect(at("login-realname")).toBeGreaterThan(1);
    expect(at("Passkey")).toBeGreaterThan(at("login-realname"));
    expect(at("Recovery code")).toBeGreaterThan(at("Passkey"));
    // The revealed field follows the button that reveals it, not the form.
    expect(at("login-recovery-code")).toBeGreaterThan(at("Recovery code"));
    expect(expanded.at(-1)).toBe("Connect");
  });
});

// Presses Tab until focus leaves `.login-form`, returning the id (or trimmed
// label) of each element it passed through. A real Tab walk, not a DOM-order
// query: the two differ the moment anything grows a `tabindex`, and "is it
// keyboard-reachable" is precisely the question.
async function tabThroughForm(page: Page): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (el === null || el.closest(".login-form") === null) return null;
      return el.id !== "" ? el.id : (el.textContent ?? "").trim();
    });
    if (label === null) return seen;
    seen.push(label);
  }
  throw new Error(`tab walk never left the login form: ${seen.join(" → ")}`);
}

test.describe("login alt-auth entry points — 1024x900 with Advanced expanded", () => {
  test.use({ viewport: { width: 1024, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await openLogin(page);
  });

  test("the COLLAPSED card fits the viewport", async ({ page }) => {
    // #442 measured 875px of card against 900px of viewport with Advanced
    // OPEN: 25px of slack, less than one 44px tap target, which is why the
    // pair shared a row. #1322 relaxed that for the open state (see the
    // reachability test below), so the fits-in-the-viewport invariant now
    // belongs to the COLLAPSED card — the view every login starts in.
    //
    // The threshold stays at "fits", NOT at some slack the move is supposed
    // to have bought. A collapsed card was already hundreds of px inside a
    // 900px viewport, so any such number would pass with the pair put back
    // on the toggle row and would be decoration reading as a measurement.
    // What actually witnesses "this view got a row shorter" is the absence
    // of the two doors, asserted by count in the 390x480 block above, in
    // issue204-foolproof-login and in login-advanced-scroll-reachability.
    const box = await page.locator(".login-form").boundingBox();
    expect(box).not.toBeNull();
    const height = box?.height ?? Number.POSITIVE_INFINITY;
    expect(
      900 - height,
      `collapsed login card is ${height}px tall in a 900px viewport`,
    ).toBeGreaterThanOrEqual(0);

    await expect(connectButton(page)).toBeInViewport();
  });

  test("with Advanced open both doors and Connect stay reachable", async ({ page }) => {
    // The ruling: with Advanced open a scroll is acceptable, so the claim is
    // reachability, not fit. `scrollIntoViewIfNeeded` is the right tool HERE
    // and not in login-advanced-scroll-reachability: that spec exists to
    // prove a real scroll container exists (a programmatic scrollTop would
    // green-wash `overflow:hidden`), and having proved it there, this test
    // is free to ask the narrower question of whether each control can be
    // brought into view and clicked.
    await page.getByRole("button", { name: /advanced/i }).click();
    await expect(page.getByLabel(/real name/i)).toBeVisible();

    for (const control of [passkeyButton(page), recoveryButton(page), connectButton(page)]) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport();
      await expect(control).toBeEnabled();
    }
  });
});
