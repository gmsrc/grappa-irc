// #370 — custom /hilight words render with the SAME in-message visual
// emphasis own-nick mentions get, e2e.
//
// #356 shipped the /hilight keyword LIST + the notify path (the OS/push
// notification is computed server-side, `Grappa.Mentions.mentioned?/3` = own
// nick ∪ patterns). But the CLIENT visual matcher (`matchesWatchlist`) only
// ever received the own nick, so a message matching a custom word FIRED the
// notification yet rendered as a PLAIN line — the on-screen highlight was the
// gap. This spec drives the VISIBLE outcome against the real integration
// stack: a peer PRIVMSG carrying a custom keyword (and NOT the own nick) must
// paint the same `.scrollback-mention` + `.scrollback-highlight` classes an
// own-nick mention gets.
//
// Two phases in one flow, both required:
//   1. LIVE — the word is added this session (`highlightPatterns()` populated
//      by the /hilight round-trip); the next peer line highlights.
//   2. AFTER RELOAD — a fresh boot starts with an EMPTY keyword list (it has
//      NO server broadcast, unlike the presence watch list). The list is
//      re-pulled on the user-topic (re)join (userTopic.ts onJoinOk →
//      refreshHighlights), so a NEW matching line still highlights WITHOUT
//      the operator opening the watch-lists settings section. This is the
//      hydration half of the #370 fix — pin it, or a reload silently
//      regresses the highlight to plain until settings is opened.
//
// SINGLE subject arm (vjt): the visual matcher is a client-side render
// decision and the keyword list is subject-agnostic user_settings — there is
// no subject-shaped branch to parameterize (the parity-matrix rule applies
// only to subject-shaped surfaces).

import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
// Alphanumeric so the word-boundary match is unambiguous, own-nick-free so
// ONLY the custom pattern can drive the highlight (not an incidental mention).
const KEYWORD = "i370hilite";
const PEER_NICK = "i370peer";

test.setTimeout(90_000);

test("#370 — a custom /hilight word paints the same visual highlight own-nick mentions get, live and after reload", async ({
  page,
}) => {
  const vjt = specUser();
  let peer: IrcPeer | null = null;
  try {
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: specNick() });

    // Configure the custom highlight word. The green confirmation notice is
    // the deterministic signal the add round-tripped to the server (so the
    // reload phase below has a durable pattern to re-pull).
    await composeSend(page, `/hilight ${KEYWORD}`);
    await expect(page.locator(".compose-box-notice")).toContainText(KEYWORD, { timeout: 8_000 });

    // A peer in the channel says something carrying the keyword but NOT the
    // own nick — so the highlight can ONLY come from the custom word.
    peer = await IrcPeer.connect({ nick: PEER_NICK });
    await peer.join(SEED_CHANNEL);
    peer.privmsg(SEED_CHANNEL, `first ${KEYWORD} landed on prod`);

    // VISIBLE outcome (phase 1): emphasised exactly like an own-nick mention.
    const liveLine = scrollbackLine(page, "privmsg", `first ${KEYWORD}`);
    await expect(liveLine).toBeVisible({ timeout: 15_000 });
    await expect(liveLine).toHaveClass(/scrollback-highlight/);
    await expect(liveLine).toHaveClass(/scrollback-mention/);

    // #1298 — the highlight must not INDENT the row. The accent bar used to be
    // `border-left: 2px` + `padding-left: 0.25rem`, inline space no other row
    // reserved, so a highlighted line's text column sat 5.5px right of every
    // neighbour (measured, irssi-dark at the 14px font pref). The bar is
    // painted in the pane's gutter now, which is only half the contract: the
    // text column must be flush with a plain row's AND the bar must still be
    // painted. A plain peer line, sent here, is the external reference box —
    // measuring the highlighted row against itself could not fail.
    peer.privmsg(SEED_CHANNEL, "i370 plain neighbour line");
    const plainLine = scrollbackLine(page, "privmsg", "i370 plain neighbour line");
    await expect(plainLine).toBeVisible({ timeout: 15_000 });
    await expect(plainLine).not.toHaveClass(/scrollback-highlight/);

    const highlightedTime = await liveLine.locator(".scrollback-time").boundingBox();
    const plainTime = await plainLine.locator(".scrollback-time").boundingBox();
    if (highlightedTime === null || plainTime === null) {
      throw new Error("a scrollback row has no timestamp box — the markup or the classes drifted");
    }
    expect(
      Math.abs(highlightedTime.x - plainTime.x),
      "a highlighted row's text column must start where a plain row's does",
    ).toBeLessThan(0.5);

    const bar = await liveLine.evaluate((el) => {
      const cs = getComputedStyle(el, "::before");
      return { content: cs.content, width: cs.width, background: cs.backgroundColor };
    });
    expect(bar.content).not.toBe("none");
    expect(bar.width).toBe("2px");
    expect(bar.background).not.toBe("rgba(0, 0, 0, 0)");

    // Phase 2 — fresh reload: the keyword list starts empty and is re-pulled
    // on the user-topic (re)join. A NEW matching line must still highlight
    // without opening settings.
    await page.reload();
    await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: specNick() });
    peer.privmsg(SEED_CHANNEL, `second ${KEYWORD} shipped clean`);

    const rehydratedLine = scrollbackLine(page, "privmsg", `second ${KEYWORD}`);
    await expect(rehydratedLine).toBeVisible({ timeout: 15_000 });
    await expect(rehydratedLine).toHaveClass(/scrollback-highlight/);
    await expect(rehydratedLine).toHaveClass(/scrollback-mention/);
  } finally {
    // Self-clean the durable keyword list (no REST cleanup surface; the
    // /dehilight command is the tool) + tear down the peer.
    await composeSend(page, `/dehilight ${KEYWORD}`).catch(() => {});
    if (peer) await peer.disconnect("bye");
  }
});
