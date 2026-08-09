// The CTCP ACTION envelope, and the one place that knows its shape.
//
// The server stores the wire-form body verbatim per the CLAUDE.md CTCP
// "preserved as-is" rule (round-trip fidelity for ACTION and other verbs), so
// every consumer that wants the text a human actually saw has to unwrap it.
//
// #1126 — this used to be a module-local `const` inside `ScrollbackPane.tsx`,
// which meant the RENDER layer unwrapped the envelope and the REPLY layer did
// not: replying to an `/me` quoted `<nick> \x01ACTION text\x01<< ` and shipped
// both delimiters back onto the wire inside an ordinary PRIVMSG. One parser,
// one shape, both doors.

export const CTCP_DELIMITER = "\x01";
const CTCP_ACTION_PREFIX = `${CTCP_DELIMITER}ACTION `;

// The inner text of an action body, or the body unchanged when the envelope
// isn't there. Defensive on purpose: a future server-side pre-strip, or a row
// persisted before the wire form was stored, must still render.
export const stripCtcpAction = (body: string | null): string => {
  if (!body) return "";
  if (!body.startsWith(CTCP_ACTION_PREFIX)) return body;
  const inner = body.slice(CTCP_ACTION_PREFIX.length);
  return inner.endsWith(CTCP_DELIMITER) ? inner.slice(0, -1) : inner;
};

// Scrub every CTCP delimiter out of operator-typed free text.
//
// `\x01` is framing, and cic has exactly ONE sanctioned producer of it
// (`ctcpFrame` in compose.ts). A delimiter arriving in free text is either a
// paste or a bug upstream; either way it is not framing the operator chose, so
// it must not survive to the wire. Scrub rather than reject — the byte is
// invisible, so refusing the whole message would be an unexplainable failure,
// and the tree's posture for a stray \x01 is already "scrub it" (#641).
export const scrubCtcpDelimiters = (text: string): string => text.replaceAll(CTCP_DELIMITER, "");
