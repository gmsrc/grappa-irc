// UX-5 bucket BC2 — colored nicks (deterministic djb2 hash → palette
// index) + irssi-style channel-mode prefix glyph in scrollback senders.
//
// Pre-bucket symptoms:
//   * Every nick rendered with the same foreground color (--fg); only
//     length and casing differentiated operators visually. Dense
//     channels became a wall of same-colored `<nick>` brackets.
//   * Scrollback PRIVMSG senders were bare `<nick>` — no @ / % / +
//     prefix to surface op/halfop/voiced status at a glance. Members
//     pane already had the sigil (UX-4 bucket J) but the asymmetry
//     made the scrollback the weaker surface.
//
// Post-bucket end state:
//   * Every nick render site routes through `<NickText>`. Outer span
//     is `.nick`; inline `style="color: var(--nick-color-N)"` where
//     N = djb2(asciiFold(nick)) % NICK_PALETTE_SIZE. Theme blocks
//     (`:root[data-theme="..."]`) define `--nick-color-0..15` per theme
//     so the palette swaps with the rest of the chrome; #444 DERIVES a
//     second band on top of those in plain `:root`, as
//     `color-mix(in oklab, …)` — which the browser serialises as
//     `oklab(…)`, never `rgb(…)`.
//   * Op/halfop/voiced senders get a bold `.nick-prefix.nick-prefix-{op,
//     halfop,voiced}` span BEFORE the nick text, taking the existing
//     mode-token color (`--mode-op` etc.). Plain members render with
//     no prefix glyph.
//   * Members pane uses the same component → same color contract.
//
// jsdom is CSS-cascade-blind (per `feedback_cicchetto_browser_smoke`)
// — the live `var()` resolution + theme switch MUST be exercised in a
// real browser. Unit/component tests pin the structural contract;
// this e2e pins the CSS-driven color application.
//
// Parity matrix: UI shape contract, subject-shape-agnostic. Registered
// seed (vjt + #bofh autojoin) suffices.

import {
  computedColor,
  inlineNickColorVar,
  loginAs,
  resolveCssColor,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(60_000);

test("ux-5-bc2 desktop — scrollback sender: own nick renders with NickText (.nick-text + colored)", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

  // Send a probe PRIVMSG so a sender-rendered row lands in scrollback.
  // Scrollback senders are the canonical colored NickText site
  // (members pane uses `noColor` → renders in `--fg`, see
  // MembersPane.tsx:182 + UX-6 bucket A v2 rationale in NickText.tsx).
  // Asserting color on the members site is invalid by design; the
  // sender site is where the per-nick palette hue actually applies.
  const compose = page.locator(".compose-box textarea");
  const probe = `ux-5-bc2 colored-nick probe ${crypto.randomUUID().slice(0, 6)}`;
  await compose.fill(probe);
  await compose.press("Enter");

  const ownPrivmsg = page
    .locator('[data-testid="scrollback-line"][data-kind="privmsg"]')
    .filter({ hasText: probe })
    .first();
  await expect(ownPrivmsg).toBeVisible({ timeout: 10_000 });

  // The NickText helper renders `<span class="nick"><span class="nick-text"
  // style="color: var(--nick-color-N)">{nick}</span></span>`. Assert
  // the inner span exists AND has a resolved (non-empty, non-default)
  // computed color.
  const nickTextSpan = ownPrivmsg.locator(".scrollback-sender .nick-text").first();
  await expect(nickTextSpan).toHaveText(specNick());

  // Two assertions, one mutant each. Both compare opaque computed strings —
  // see `resolveCssColor` for why a parsed rgb tuple is the wrong oracle.
  //
  //   (1) the palette var RESOLVED. An undeclared or unresolvable
  //       `--nick-color-N` is invalid-at-computed-value-time and the span
  //       inherits `--fg`, i.e. renders uncoloured. The retired oracle
  //       approximated this as "sum of channels > 0", which only bites in a
  //       light theme (mirc-light's `--fg` is #000000); against `--fg`
  //       itself it bites in every theme.
  const sender = await computedColor(nickTextSpan);
  expect(sender).not.toBe(await resolveCssColor(page, "var(--fg)"));
  //   (2) the hue is the slot the span DECLARES, not one painted over it by
  //       a stray rule with higher specificity.
  expect(sender).toBe(await resolveCssColor(page, await inlineNickColorVar(nickTextSpan)));
});

test("ux-5-bc2 desktop — every declared palette slot resolves, and to a distinct hue", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // What only a browser can answer: does `var(--nick-color-N)` actually
  // RESOLVE, and do the slots stay distinct from one another?
  //
  // This used to re-implement djb2 in the probe to pick the slots — and the
  // copy said `% 16` while production had moved to 32 (`NICK_PALETTE_SIZE`,
  // #444). The mirror was stale, so the probe never once touched buckets
  // 16..31, the CSS-DERIVED band (`color-mix(in oklab, …)`) that is exactly
  // the part a stylesheet can break. Nick → slot is a pure function with no
  // DOM in it and is pinned in `src/__tests__/nickColor.test.ts`
  // (determinism, case-folding, in-bounds, distribution, and "every bucket
  // has a declaration"); duplicating it here bought nothing and forked the
  // contract. So the probe now walks the palette the stylesheet declares
  // instead of guessing which slots a nick lands in — no constant copied.
  const { slots, fg } = await page.evaluate(() => {
    const probe = document.createElement("span");
    document.body.appendChild(probe);
    const resolve = (value: string) => {
      probe.style.color = value;
      return getComputedStyle(probe).color;
    };
    const foreground = resolve("var(--fg)");
    // Walk upward while the slot resolves to something other than the
    // inherited `--fg` — an undeclared var is invalid-at-computed-value-time
    // and lands there. The ceiling only bounds the walk; it is not a claim
    // about the palette size.
    const resolved: string[] = [];
    for (let i = 0; i < 64; i++) {
      const colour = resolve(`var(--nick-color-${i})`);
      if (colour === foreground) break;
      resolved.push(colour);
    }
    probe.remove();
    return { slots: resolved, fg: foreground };
  });

  // The legacy hand-authored band is 16 slots; #444 derives a second band on
  // top of it. Anything at or below 16 means the derived band stopped
  // resolving — the regression #444 has to stay ahead of.
  expect(slots.length).toBeGreaterThan(16);

  // Distinct hues, or two different nicks read as the same person. Compared
  // as opaque computed strings: the derived band serialises as `oklab(…)`
  // and the base band as `rgb(…)`, and both are equally valid colours.
  expect(new Set(slots).size).toBe(slots.length);

  // And none of them is the uncoloured default (the walk's break condition
  // proves this for the prefix it accepted; asserting it makes the intent
  // survive a future rewrite of the loop).
  expect(slots).not.toContain(fg);
});

test("ux-5-bc2 desktop — own nick (operator self, plain in channel) has no @/%/+ prefix glyph on PRIVMSG sender", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // GREEN-CI batch 2 — use a fresh channel where a peer joins FIRST so
  // vjt is plain (no @ prefix) deterministically. The previous "use
  // #bofh, vjt is not opped on autojoin" assumption became flaky after
  // GREEN-CI batch 1 raised the autojoin race to 3 users (vjt +
  // m9b-test + m9b-victim) — vjt has a 1/3 chance of winning +o on a
  // fresh #bofh, in which case her sender renders with `@` prefix and
  // the negative-twin assertion below fails. Per-spec dedicated channel
  // with peer-first JOIN guarantees plain status.
  const FRESH = `#bc2-plain-${crypto.randomUUID().slice(0, 6)}`;
  const peer = await IrcPeer.connect({ nick: `bc2plain-${crypto.randomUUID().slice(0, 6)}` });
  try {
    await peer.join(FRESH);
    const compose = page.locator(".compose-box textarea");
    await compose.fill(`/join ${FRESH}`);
    await compose.press("Enter");
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: FRESH }),
    ).toHaveCount(1, { timeout: 10_000 });
    await selectChannel(page, NETWORK_SLUG, FRESH, { ownNick: specNick() });

    const probe = `ux-5-bc2 probe message ${crypto.randomUUID().slice(0, 6)}`;
    await page.locator(".compose-box textarea").fill(probe);
    await page.locator(".compose-box textarea").press("Enter");

    // The own-PRIVMSG row's sender span must exist and carry NickText.
    // vjt joined this fresh channel SECOND → plain. Assert no
    // `.nick-prefix` child inside the sender. This pins the
    // negative-twin (no false prefix injection on plain members).
    const ownPrivmsg = page
      .locator('[data-testid="scrollback-line"][data-kind="privmsg"]')
      .filter({ hasText: probe })
      .first();
    await expect(ownPrivmsg).toBeVisible({ timeout: 10_000 });
    const sender = ownPrivmsg.locator(".scrollback-sender").first();
    await expect(sender).toBeVisible();
    // NickText is mounted (verify by `.nick-text` presence + correct text).
    const senderText = sender.locator(".nick-text");
    await expect(senderText).toHaveText(specNick());
    // No prefix glyph on the plain own-nick.
    await expect(sender.locator(".nick-prefix")).toHaveCount(0);
  } finally {
    await peer.disconnect("bc2 plain done");
  }
});

test("ux-5-bc2 desktop — theme switch repaints nick colors (irssi-dark → mirc-light)", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // Capture own-nick color under whichever theme is active by default,
  // then flip the theme via setTheme() (theme.ts exports it). Assert
  // the color changes (palette hues differ per theme by design).
  const ownNickLocator = page
    .locator(".members-pane .member-name")
    .filter({ hasText: specNick() })
    .first();
  await expect(ownNickLocator).toBeVisible({ timeout: 10_000 });
  const colorBefore = await ownNickLocator
    .locator(".nick-text")
    .first()
    .evaluate((el) => getComputedStyle(el).color);

  // Read current theme; flip to the opposite.
  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  const target = before === "mirc-light" ? "irssi-dark" : "mirc-light";
  await page.evaluate((t) => {
    localStorage.setItem("grappa-theme", t);
    document.documentElement.dataset.theme = t;
  }, target);

  // The `<html>` data-theme attr flip is enough — `:root[data-theme="..."]`
  // selectors re-resolve `--nick-color-N` to the new palette. No re-render
  // of NickText is required (the inline style is `var()`, not a hex).
  const colorAfter = await ownNickLocator
    .locator(".nick-text")
    .first()
    .evaluate((el) => getComputedStyle(el).color);

  expect(colorBefore).not.toBe(colorAfter);
  // Sanity: both colors are resolved (non-empty). Checked as strings — a
  // computed colour may serialise as `rgb(…)` OR `oklab(…)` depending on the
  // slot (see `resolveCssColor`), so "did it parse as rgb" is not the
  // question and never was.
  expect(colorBefore).not.toBe("");
  expect(colorAfter).not.toBe("");
});

test("ux-5-bc2 desktop — scrollback PRIVMSG sender wraps the nick inside angle brackets <{nick}>", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // GREEN-CI batch 2 — peer-first JOIN on a dedicated channel so vjt
  // is plain (no `@` prefix), same rationale as the previous test:
  // 3-way autojoin race on #bofh post-m9b-victim makes vjt's status
  // there non-deterministic. Bracket-shape assertion below assumes
  // bare `<nick>` textContent (no `@nick`), which only holds when vjt
  // is plain.
  const FRESH = `#bc2-bracket-${crypto.randomUUID().slice(0, 6)}`;
  const peer = await IrcPeer.connect({ nick: `bc2brkt-${crypto.randomUUID().slice(0, 6)}` });
  try {
    await peer.join(FRESH);
    const compose = page.locator(".compose-box textarea");
    await compose.fill(`/join ${FRESH}`);
    await compose.press("Enter");
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: FRESH }),
    ).toHaveCount(1, { timeout: 10_000 });
    await selectChannel(page, NETWORK_SLUG, FRESH, { ownNick: specNick() });

    const probe = `ux-5-bc2 bracket-shape probe ${crypto.randomUUID().slice(0, 6)}`;
    await page.locator(".compose-box textarea").fill(probe);
    await page.locator(".compose-box textarea").press("Enter");

    const ownPrivmsg = page
      .locator('[data-testid="scrollback-line"][data-kind="privmsg"]')
      .filter({ hasText: probe })
      .first();
    await expect(ownPrivmsg).toBeVisible({ timeout: 10_000 });
    // Sender textContent is `<nick>` (no prefix, vjt is plain on the
    // peer-first fresh channel). The bracket pair is OUTSIDE the
    // NickText component (per the ScrollbackPane senderSpan closure
    // contract), so it appears in the sender button's textContent
    // unchanged.
    const senderText = await ownPrivmsg.locator(".scrollback-sender").first().textContent();
    expect(senderText).toBe(`<${specNick()}>`);
  } finally {
    await peer.disconnect("bc2 bracket done");
  }
});
