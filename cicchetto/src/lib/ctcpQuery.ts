import { channelKey } from "./channelKey";
import { ctcpFrame } from "./ctcpAction";
import { registerPing } from "./pingCorrelation";
import { sendMessage } from "./scrollback";

// #1192 — the ONE door an outbound CTCP query goes through.
//
// A CTCP query is a control-surface probe, not conversation, and it has two
// halves that must stay welded together:
//
//   1. #640 — the self-echo belongs in the SOURCE window (the one the operator
//      is looking at), with the wire recipient travelling in `ctcpTarget`. Send
//      it to the recipient's window instead and a probe mints a phantom query
//      tab for somebody the operator never talked to.
//   2. #600 — a PING's pending correlation entry MUST be registered BEFORE the
//      send is awaited. `sendMessage` is a REST POST; on a loaded runner its ack
//      resolves AFTER the peer's reply has already been processed on the
//      separate, already-open WS. Register behind the await and
//      `maybeConsumePingReply → resolvePing` finds nothing, the RTT line never
//      renders, and the failure is deterministic on CI and invisible locally.
//
// compose.ts held both by hand while `/ping` and `/ctcp` were the only callers.
// #1192 adds a second, independent caller — the nick context menu's CTCP
// submenu — and a hand-held invariant with two callers is an invariant with a
// drift date. So the ordering lives here, and the callers lose the ability to
// get it wrong.
//
// Deliberately NOT here:
//
//   * ACTION. `/me` and `/ctcp <t> ACTION …` ARE conversation, so they belong in
//     the TARGET window and ride the ordinary send path; the server rejects an
//     ACTION through the CTCP route anyway (`Session.send_ctcp`'s non-ACTION
//     gate). compose.ts keeps that branch above this call.
//   * Token minting. `args` is the caller's bytes, framed verbatim. `/ping` is
//     sugar that mints a timestamp token; `/ctcp` is the raw escape hatch and
//     must put exactly what the operator typed on the wire. A seam that invented
//     a token to make its own correlation tidier would silently rewrite the
//     escape hatch. A BARE ping still correlates — through the #637 token-less
//     fallback, since the peer echoes a bare `\x01PING\x01` back.
//   * The clock. `sentAtMs` is passed in, keeping the whole correlation chain
//     wall-clock-free the way `pingCorrelation` is, so the RTT origin is a value
//     the caller can pin and this module's ordering can be asserted without
//     mocking time.
type CtcpQuery = {
  networkSlug: string;
  networkId: number;
  // The window the operator asked from — where the echo, and a PING's RTT, land.
  sourceChannel: string;
  // The wire recipient. NOT the window: see #640 above.
  targetNick: string;
  verb: string;
  args: string;
  sentAtMs: number;
};

export const sendCtcpQuery = async (query: CtcpQuery): Promise<void> => {
  // PING is the one verb whose reply cic can attribute back to the question, so
  // it is the one verb that registers. Everything else is fire-and-forget: its
  // reply is an asynchronous NOTICE the server routes to `$server`, and a
  // pending entry for it could only ever leak. Folded because the verb reaches
  // here from a parser that upper-cases AND from a menu that passes a literal.
  if (query.verb.toUpperCase() === "PING") {
    registerPing(
      query.networkId,
      query.targetNick,
      query.args,
      channelKey(query.networkSlug, query.sourceChannel),
      query.sourceChannel,
      query.sentAtMs,
    );
  }

  await sendMessage(query.networkSlug, query.sourceChannel, ctcpFrame(query.verb, query.args), {
    kind: "ctcp",
    target: query.targetNick,
  });
};
