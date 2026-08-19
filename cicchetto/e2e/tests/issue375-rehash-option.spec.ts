// Issue #375 (P2) — /rehash <option> must forward the option on the wire.
//
// The TWIN of #374 (/motd <target>), but cicchetto-ONLY: the grappa side is
// a clean raw passthrough — `/rehash` rides the #153-de-gated `pushRaw`
// transport and grappa's `handle_in("raw", …)` ships the line VERBATIM via
// `Session.send_raw` (grappa_channel.ex). So a forwarded option reaches the
// ircd intact; the bug was entirely in cic — the slash parser dropped the
// option arg and compose hardcoded a bare `REHASH`, so bahamut ran the
// DEFAULT full-config reload instead of the scoped `REHASH MOTD`.
//
// OBSERVABLE — the raw outbound frame. We cannot prove the option upstream
// via the reply numeric: a non-oper's REHASH (with OR without an option)
// gets the same 481 ERR_NOPRIVILEGES back — bahamut's m_rehash checks
// !OPCanRehash BEFORE it looks at the option, so the reply can't distinguish
// `REHASH` from `REHASH MOTD`. And we must NOT oper-then-rehash: an OPER'd
// REHASH triggers the real config reload, which SIGSEGVs THIS testnet
// bahamut build (#164) and poisons the whole suite (see the #155 e2e note).
//
// So the unforgeable evidence is the raw frame cic SENDS: `pushRaw` ships
// `["raw",{network_id,line}]` over the Phoenix WS, and `line` is exactly
// what grappa forwards to the ircd. We capture every `framesent` and assert
// the option rides `line`. The 481 rendering in $server is kept as a
// belt-and-suspenders witness that the frame genuinely reached upstream (not
// just emitted into the void) — the same non-oper reply #155 relies on.
//
// RED pre-fix: cic drops the option → the sent frame carries a bare
// `"REHASH"` even for `/rehash MOTD` → the "REHASH MOTD" assertion times out.
// GREEN post-fix: `/rehash MOTD` sends `line: "REHASH MOTD"`; bare `/rehash`
// still sends exactly `"REHASH"` (the null-filter drops the absent option).

import {
  bootVisitor,
  composeSend,
  expectShellReady,
  scrollbackLine,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// 481 ERR_NOPRIVILEGES trailing text bahamut-azzurra sends (src/s_err.c):
//   `:%s 481 %s :Permission Denied, You do not have the correct irc
//    operator privileges`
// A non-oper's REHASH reply — routed to `$server` by the numeric_router
// :scan fallback, same as #155. Matched on the stable core phrase.
const ERR_NOPRIVILEGES_TEXT = /permission denied/i;

test("issue #375 — /rehash <option> forwards the option on the raw wire, bare /rehash stays REHASH", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const visitorNick = `v375-${Date.now()}`;
  const visitor = await mintVisitor(visitorNick);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Every raw `line` cic ships upstream via pushRaw. Phoenix v2 frames are
  // JSON arrays `[join_ref, ref, topic, "raw", {network_id, line}]`; the
  // heartbeat/other events never contain `"raw"`, so guard on it then pull
  // out `line`. Attached BEFORE goto so we catch the app WS from the moment
  // it opens (and any reconnect).
  const sentRawLines: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", ({ payload }) => {
      if (typeof payload !== "string" || !payload.includes('"raw"')) return;
      const m = payload.match(/"line":"([^"]*)"/);
      if (m) sentRawLines.push(m[1]);
    });
  });

  try {
    // Boot cic straight into Shell as the visitor (no captcha/anon dance),
    // exactly like issue155/issue148. Onto the page made above, NOT a fresh
    // context: the websocket listener has to be attached before the boot
    // navigates, or the raw frames it records are missed.
    await bootVisitor(page, { id: visitor.id, token: visitor.token });
    await expectShellReady(page);

    // Focus the visitor's $server window and wait for the upstream
    // registration numerics (:notice rows) — proves the session is connected
    // and the pane is live, so the reply numeric won't race an empty pane.
    await selectChannel(page, visitor.network_slug, "Server", { awaitWsReady: false });
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="notice"]').first(),
    ).toBeVisible({ timeout: 20_000 });

    // (1) THE FIX — /rehash MOTD must ship `REHASH MOTD` on the raw wire.
    // Pre-fix cic drops the option → a bare `REHASH` frame → this times out.
    await composeSend(page, "/rehash MOTD");
    await expect
      .poll(() => sentRawLines, { timeout: 15_000, message: "raw frame REHASH MOTD not sent" })
      .toContain("REHASH MOTD");

    // …and it genuinely reached upstream: the non-oper gets 481 back, the
    // server's reply to the frame we shipped, rendered as a :notice in
    // $server. (Non-oper 481 is scoped-agnostic — safe, no config reload.)
    await expect(scrollbackLine(page, "notice", ERR_NOPRIVILEGES_TEXT).first()).toBeVisible({
      timeout: 15_000,
    });

    // (2) REGRESSION GUARD — bare /rehash still ships EXACTLY `REHASH` (full
    // config reload). The null-filter must not leak a trailing space or a
    // stringified null into the frame.
    await composeSend(page, "/rehash");
    await expect
      .poll(() => sentRawLines, { timeout: 15_000, message: "raw frame REHASH not sent" })
      .toContain("REHASH");
    expect(sentRawLines.some((l) => l === "REHASH " || l.toLowerCase().includes("null"))).toBe(
      false,
    );

    // The native verb never surfaces the parser's unknown-command error.
    await expect(page.getByText(/unknown command/i)).toHaveCount(0);
  } finally {
    await ctx.close();
    await reapVisitors(admin.token, visitor.id);
  }
});
