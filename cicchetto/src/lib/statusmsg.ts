import { DEFAULT_CHANTYPES, isChannelName } from "./chantypes";

// issue 2179 — a STATUSMSG target (`@#chan` ops-only, `@+#chan` ops AND
// voiced) is a CHANNEL addressed at one or more membership levels. It is not
// a nick, and it is not a new conversation: the ircd delivers it into the
// channel, and grappa's ingress router files every copy of it in the `#chan`
// window (`EventRouter.strip_statusmsg_target/2`, #218/#1247).
//
// cic needs to recognise one for exactly one decision — whether `/msg` opens a
// query window. Before this module it did not, so `/msg @#chan hi` opened a
// sidebar row literally named `@#chan` that no network knows about, on top of
// a 400 from the send door.
//
// ## Why this is pure, and what it is pinned to
//
// The client twin of `Grappa.IRC.Identifier.peel_statusmsg/2`, including its
// backtracking: the LONGEST leading run of sigils whose remainder still starts
// a channel wins, and if no split leaves a channel behind, NOTHING is peeled.
// `+` is the reason — it is both the voice sigil and an RFC channel sigil, so
// a plain greedy peel of `@+chan` (ops level, modeless channel `+chan`) eats
// both bytes and finds no channel behind them.
//
// The membership sigils arrive as DATA (per-network, `PREFIX=`), but the
// "does a channel start here" test is pinned to `DEFAULT_CHANTYPES` and NOT to
// the network's advertised `CHANTYPES=`. That is deliberate and it is not a
// third hardcoded copy — it reuses the named constant `chantypes.ts` already
// owns. The server's own peel asks `Identifier.channel_sigil?/1`, which is the
// RFC 2812 class hardcoded, and the validator behind it
// (`GrappaWeb.Validation.validate_statusmsg_recipient/4`) is RFC-classed too.
// Predicting the send door with a WIDER set would route a target the door then
// refuses; predicting it with a NARROWER one would leave a legitimate ops-only
// send on the phantom-window path. The right set is the one the door uses.
//
// ## Known over-acceptance, and why it is safe
//
// The sigils here are `PREFIX=`, because that is the only membership fact the
// wire publishes today; the ircd's authority is `STATUSMSG=`, which is a
// SUBSET (bahamut advertises `PREFIX=(ohv)@%+` but `STATUSMSG=@+`). So `%#chan`
// peels here and the server refuses it — which is the ACCEPTANCE, not a gap:
// a sigil the network does not advertise must be refused, never silently
// stripped. What the operator gets is a 400 banner instead of a phantom
// window, and the refusal still comes from the one party that holds the 005.

export type StatusmsgTarget = {
  /** The channel behind the run — where the echo lands. */
  readonly channel: string;
  /** The WHOLE peeled run (`"@+"`, never just `"@"` — #1303). */
  readonly level: string;
};

/**
 * `target` as a channel-at-a-membership-level, or `null` when it is an
 * ordinary nick or channel.
 *
 * `sigils` is this network's membership sigil set — pass
 * `sigilRankForNetwork(id)`; order is irrelevant here, membership is all that
 * is asked.
 */
export function peelStatusmsg(target: string, sigils: readonly string[]): StatusmsgTarget | null {
  let best: StatusmsgTarget | null = null;
  for (let i = 0; i < target.length; i += 1) {
    if (!sigils.includes(target.charAt(i))) break;
    const channel = target.slice(i + 1);
    // Keep walking past a viable split rather than returning it: the LONGEST
    // run wins, and a shorter one stays the fallback. `@+#chan` is level `@+`
    // on `#chan`, while `@+chan` is level `@` on `+chan`.
    if (isChannelName(channel, DEFAULT_CHANTYPES)) {
      best = { channel, level: target.slice(0, i + 1) };
    }
  }
  return best;
}
