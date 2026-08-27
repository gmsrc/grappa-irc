// Issue #1769 — presence suppressed by join params, measured ON THE SOCKET.
//
// WHY THIS SPEC EXISTS AND WHY IT LOOKS AT FRAMES
//
// #1680 already stops a paused channel from APPLYING peer join/part/quit: the
// events cross the socket, get decoded, wake the main thread, and are dropped
// at cic's dispatch edge. So the obvious end-to-end assertion — "the member
// list does not move on a paused channel" — is green with or without #1769.
// It would be a spec that cannot fail for the reason it was written.
//
// What #1769 buys is the thing #1680 could not: the bytes never arrive. That
// is only observable at the transport, so this spec counts WebSocket frames
// (`page.on("websocket")` → `framereceived`, the same instrument
// `issue375-rehash-option.spec.ts` and `i2b-image-upload-litterbox-host.spec.ts`
// use) and asserts on which ones are absent.
//
// THE CONTROLS, BECAUSE AN ABSENCE PROVES NOTHING BY ITSELF
//
// "No frame arrived" is also what a broken fixture, a peer that never joined,
// and a dead socket look like. Three positive controls run in the same page,
// against the same peer, on the same socket:
//
//   1. BEFORE the pause, a peer JOIN on the very same channel DOES produce a
//      frame. Same topic, same event, same everything — only the pause differs.
//   2. AFTER the pause, the FOCUSED channel still receives its peer JOIN. The
//      suppression is per-channel, not per-socket, and this is the arm that
//      fails if the whole socket went quiet.
//   3. AFTER the pause, a PRIVMSG to the PAUSED channel still arrives. This is
//      vjt's ruling as an assertion — a paused window goes quiet, never blind
//      — and it is the one that fails if someone "simplifies" the pause into
//      an abandoned topic.
//
// And one more, on the outbound side: the join frame cic SENT for the paused
// channel must carry `{"presence":false}`. Without it the absence downstream
// would prove the server dropped frames nobody asked it to drop.
//
// THE CLOCK
//
// `PRESENCE_COOLDOWN_MS` is two minutes. Rather than burn that in wall-clock
// on every CI run, or add a production seam to shorten it, the spec drives
// Playwright's clock: install → resume (so boot and the network run at real
// speed) → `fastForward` past the window, which fires the pending cooldown
// timer and nothing else that matters. The cooldown's own arithmetic is
// covered by `presencePause.test.ts` under fake timers; what this spec is for
// is everything downstream of it.

import type { Page, WebSocket } from "@playwright/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

// The channel that gets blurred and paused: the seeded autojoin one.
const PAUSED_CHANNEL = AUTOJOIN_CHANNELS[0];
// The channel that stays focused, so control (2) can tell "this channel is
// suppressed" from "this socket is dead".
const FOCUSED_CHANNEL = `#pp1769-${crypto.randomUUID().slice(0, 8)}`;

// Boot + two joins + a peer + a clock jump. Well inside the reconnect-class
// budgets, but past the 30s default.
test.setTimeout(90_000);

const PRESENCE_COOLDOWN_MS = 120_000;

type Frame = {
  topic: string;
  event: string;
  payload: unknown;
};

// phoenix.js v2 serializer: every frame is the JSON array
// `[join_ref, ref, topic, event, payload]`. Anything else (a heartbeat reply
// shape we do not care about, a binary frame) is not a Frame for our purposes.
function parseFrame(raw: string): Frame | null {
  try {
    const a: unknown = JSON.parse(raw);
    if (!Array.isArray(a) || a.length !== 5) return null;
    const [, , topic, event, payload] = a as [unknown, unknown, unknown, unknown, unknown];
    if (typeof topic !== "string" || typeof event !== "string") return null;
    return { topic, event, payload };
  } catch {
    return null;
  }
}

type Recorder = {
  received: Frame[];
  sent: Frame[];
};

/**
 * Record every app frame in BOTH directions. Must be attached before `goto`,
 * or the boot socket is missed entirely (`issue1061-offline-does-nothing.spec.ts`
 * makes the same point about attach order).
 */
function recordFrames(page: Page): Recorder {
  const rec: Recorder = { received: [], sent: [] };
  page.on("websocket", (ws: WebSocket) => {
    ws.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const f = parseFrame(payload);
      if (f) rec.received.push(f);
    });
    ws.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const f = parseFrame(payload);
      if (f) rec.sent.push(f);
    });
  });
  return rec;
}

// Topics are user-rooted; matching on the suffix keeps the assertion readable
// without rebuilding the server's `Topic.channel/3` here.
function onChannel(frames: Frame[], channel: string): Frame[] {
  return frames.filter((f) => f.topic.endsWith(`/channel:${channel.toLowerCase()}`));
}

// A scrollback row of `kind` from `sender`, as it appears inside an "event"
// frame's payload (`Grappa.Scrollback.Wire.message_payload/2`).
function rows(frames: Frame[], kind: string, sender: string): Frame[] {
  return frames.filter((f) => {
    if (f.event !== "event") return false;
    const p = f.payload as { kind?: unknown; message?: { kind?: unknown; sender?: unknown } };
    if (p?.kind !== "message") return false;
    return (
      p.message?.kind === kind &&
      String(p.message?.sender ?? "").toLowerCase() === sender.toLowerCase()
    );
  });
}

let peer: IrcPeer | null = null;

test.afterEach(async () => {
  if (peer) {
    await peer.disconnect("e2e cleanup").catch(() => {});
    peer = null;
  }
});

test("issue #1769 — a paused channel stops RECEIVING peer presence, while messages and the focused channel keep arriving", async ({
  page,
}) => {
  // #1848 — SUSPENDED, not broken. The pause it exercises ships OFF
  // (`PRESENCE_PAUSE_ENABLED = false` in `src/lib/presencePause.ts`) until
  // #1847 re-anchors the scrollback, so cic never re-joins with
  // `{"presence": false}` and every arm past CONTROL 1 below asserts a
  // suppression that is deliberately not happening.
  //
  // Skipped rather than weakened: the arms are correct and must come back
  // UNTOUCHED with the flag. There is no fixture that could rescue them here
  // — the switch is a build-time constant with no runtime seam, deliberately
  // (a seam is exactly the "second way to say the same thing" #1769 refused),
  // so an e2e driving a real bundle cannot turn it on. The unit-level twin in
  // `src/__tests__/subscribe.test.ts` DOES keep running against the flag on,
  // via `vi.doMock`; what is suspended here is only the live-socket proof.
  //
  // Restore by deleting this call in the same commit that flips the flag.
  test.skip(
    true,
    "#1848 — presence pause is switched off until #1847; nothing re-joins with {presence:false}",
  );

  const frames = recordFrames(page);

  // install() pauses the page clock; resume() lets it tick again immediately,
  // so boot, the WS handshake and every REST call run at real speed. The only
  // thing we will do with the clock is jump it once, later.
  await page.clock.install();
  await page.clock.resume();

  const vjt = specUser();
  await loginAs(page, vjt);

  const ownNick = specNick();
  await selectChannel(page, NETWORK_SLUG, PAUSED_CHANNEL, { ownNick });

  // A second REAL channel, so the focused-control arm has somewhere to live.
  // Joined through cic's own compose so the window exists in the sidebar the
  // way a user's would.
  await composeSend(page, `/join ${FOCUSED_CHANNEL}`);
  await selectChannel(page, NETWORK_SLUG, FOCUSED_CHANNEL, { ownNick });

  peer = await IrcPeer.connect({ nick: `pp1769-${crypto.randomUUID().slice(0, 6)}` });
  // Bound once: `peer` is nullable for the afterEach teardown, and the arms
  // below would otherwise each need a non-null assertion.
  const peerNick = peer.nick;
  const livePeer = peer;

  // ── CONTROL 1 — the same channel, before the pause, DOES deliver a peer
  // JOIN over the socket. The selection has already moved on, so the channel
  // is BLURRED here — its cooldown is armed but has not fired, which is
  // exactly the state that must still deliver. Establishes that the
  // instrument works, that the peer is real, and that this topic carries
  // these frames at all. Without it the absence asserted later is
  // unfalsifiable.
  await livePeer.join(PAUSED_CHANNEL);
  await expect
    .poll(() => rows(onChannel(frames.received, PAUSED_CHANNEL), "join", peerNick).length, {
      message: `no peer JOIN frame arrived for ${PAUSED_CHANNEL} before its cooldown elapsed — the instrument or the fixture is broken, not the feature`,
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  // The paused channel is currently BLURRED (the selection moved to
  // FOCUSED_CHANNEL above), so its cooldown window is already armed. Jump
  // past it: the timer fires, cic re-joins the topic with `presence: false`.
  const sentBefore = frames.sent.length;
  await page.clock.fastForward(PRESENCE_COOLDOWN_MS + 5_000);

  // ── The outbound half, asserted rather than assumed. If cic never sent the
  // param, every absence below would be measuring something else entirely.
  await expect
    .poll(
      () =>
        frames.sent
          .slice(sentBefore)
          .filter(
            (f) =>
              f.event === "phx_join" &&
              f.topic.endsWith(`/channel:${PAUSED_CHANNEL.toLowerCase()}`) &&
              (f.payload as { presence?: unknown } | null)?.presence === false,
          ).length,
      {
        message: `cic never sent a phx_join carrying {"presence": false} for ${PAUSED_CHANNEL}`,
        timeout: 15_000,
      },
    )
    .toBeGreaterThan(0);

  // Everything from here on is measured AFTER the re-join landed, so the
  // baseline JOIN from control 1 cannot leak into the counts.
  const receivedAfter = frames.received.length;
  const since = () => frames.received.slice(receivedAfter);

  // The peer leaves and re-enters BOTH channels. Same peer, same instant,
  // same socket — the only difference between the two channels is the param.
  await livePeer.part(PAUSED_CHANNEL, "cycling");
  await livePeer.join(PAUSED_CHANNEL);
  await livePeer.join(FOCUSED_CHANNEL);

  // ── CONTROL 2 — the focused channel still receives its peer JOIN. This is
  // what separates "that channel is suppressed" from "the socket is dead".
  await expect
    .poll(() => rows(onChannel(since(), FOCUSED_CHANNEL), "join", peerNick).length, {
      message: `the FOCUSED channel stopped receiving peer JOINs — suppression is meant to be per-channel, not per-socket`,
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  // ── CONTROL 3 — the paused channel is QUIET, not BLIND. vjt's ruling:
  // messages must not be lost.
  const body = `pp1769-${crypto.randomUUID().slice(0, 8)}`;
  livePeer.privmsg(PAUSED_CHANNEL, body);
  await expect
    .poll(
      () =>
        onChannel(since(), PAUSED_CHANNEL).some((f) => {
          const p = f.payload as { message?: { body?: unknown } };
          return p?.message?.body === body;
        }),
      {
        message: `a PRIVMSG to the paused channel never arrived — the pause made the window BLIND, which is exactly what the shape was chosen to avoid`,
        timeout: 15_000,
      },
    )
    .toBe(true);

  // ── THE ASSERTION THE SPEC IS FOR. The message above is the ordering
  // barrier: it was broadcast on the SAME topic AFTER the peer's part/join,
  // and it has arrived — so if the presence rows were coming, they would
  // already be here. No sleep, no window to tune.
  const presenceOnPaused = onChannel(since(), PAUSED_CHANNEL).filter((f) => {
    const p = f.payload as { kind?: unknown; message?: { kind?: unknown } };
    return p?.kind === "message" && (p.message?.kind === "join" || p.message?.kind === "part");
  });

  expect(
    presenceOnPaused,
    `peer presence still crossed the socket for the paused channel — #1680's dispatch-edge drop would hide this in the UI, which is why this spec reads frames`,
  ).toEqual([]);
});
