// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { addQuoteCommand, addQuoteToCompose } from "../lib/addQuote";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";
import { getDraft, setDraft } from "../lib/compose";

// #1107 — the `!addquote` menu item: it drops `!addquote ` plus the message
// text into the compose box and stops there. cic never sends it and never
// interprets it; whatever bot sits in the channel does.
//
// THE PAYLOAD IS THE BARE BODY — no `<nick>` head, no `<< ` tail. That is the
// issue's open question, ruled on the requester's literal words ("mette nel
// composebox '!addquote' e poi il messaggio"). The rule is pinned by its own
// assertion below so a later reshaping cannot take it silently.

const NET = "azzurra";
const CHAN = "#grappa";
const KEY = channelKey(NET, CHAN);

function msg(over: Partial<ScrollbackMessage>): ScrollbackMessage {
  return {
    id: 1,
    network: NET,
    channel: CHAN,
    server_time: 1_700_000_000_000,
    kind: "privmsg",
    sender: "vjt",
    body: "ciao mondo",
    meta: {},
    ...over,
  } as ScrollbackMessage;
}

function mountCompose(): HTMLTextAreaElement {
  const box = document.createElement("div");
  box.className = "compose-box";
  const ta = document.createElement("textarea");
  box.appendChild(ta);
  document.body.appendChild(box);
  return ta;
}

beforeEach(() => {
  document.body.innerHTML = "";
  setDraft(KEY, "");
});

describe("addQuoteCommand", () => {
  it("prefixes the message text with the bot command", () => {
    expect(addQuoteCommand(msg({}))).toBe("!addquote ciao mondo");
  });

  // The ruling, pinned on its own. Co-killed with the shape assertion above by
  // a "carry the nick" implementation, and kept anyway: it is the answer to the
  // issue's open question, and a future reshaping of the payload must trip over
  // it explicitly rather than quietly reword the string above.
  it("carries no nick — the payload is the bare body", () => {
    expect(addQuoteCommand(msg({ sender: "vjt", body: "ciao mondo" }))).not.toContain("vjt");
  });

  // The wire body can carry mIRC control bytes (\x02 bold, \x03 colour…). The
  // operator is quoting what they SEE, and a control byte round-tripped through
  // compose would be re-sent as formatting they never chose.
  it("strips mIRC control codes out of the quoted body", () => {
    expect(addQuoteCommand(msg({ body: "\x02bold\x02 plain" }))).toBe("!addquote bold plain");
  });

  // A presence row has no author speaking, and a PART carries its reason in
  // `body` — a bare body check would happily quote `!addquote Leaving`.
  it("refuses a presence row", () => {
    expect(addQuoteCommand(msg({ kind: "join", body: null }))).toBeNull();
  });

  it("refuses a row whose body is empty or whitespace", () => {
    expect(addQuoteCommand(msg({ body: "" }))).toBeNull();
    expect(addQuoteCommand(msg({ body: "   " }))).toBeNull();
    expect(addQuoteCommand(msg({ body: null }))).toBeNull();
  });

  // Same posture as Reply: an authorless content row is not somebody being
  // quoted, so the item stays disabled rather than producing an orphan quote.
  it("refuses a row with no sender", () => {
    expect(addQuoteCommand(msg({ sender: "" }))).toBeNull();
  });

  it("quotes a notice like speech — it has an author and a body", () => {
    expect(addQuoteCommand(msg({ kind: "notice" }))).toBe("!addquote ciao mondo");
  });

  // An action's stored body is the raw `\x01ACTION …\x01` wire form (the
  // CLAUDE.md "preserved as-is" rule). `mircPlainText` deliberately leaves \x01
  // alone, so without the unwrap both delimiters and the verb would ride into
  // the compose box — the #1126 defect, at a second door.
  it("unwraps a CTCP action down to its text", () => {
    expect(addQuoteCommand(msg({ kind: "action", body: "\x01ACTION si dà alla fuga\x01" }))).toBe(
      "!addquote si dà alla fuga",
    );
  });

  // The protocol half of the same defect, asserted separately: a \x01 we
  // generated inside an ordinary PRIVMSG. Co-killed with the shape above by a
  // missing unwrap, kept because it is the byte-level statement.
  it("leaves no \\x01 and no ACTION verb in the command", () => {
    const cmd = addQuoteCommand(msg({ kind: "action", body: "\x01ACTION waves\x01" })) ?? "";
    expect(cmd).not.toContain("\x01");
    expect(cmd).not.toContain("ACTION");
  });

  it("refuses an action whose envelope is empty", () => {
    expect(addQuoteCommand(msg({ kind: "action", body: "\x01ACTION \x01" }))).toBeNull();
  });

  // #1123's rule, inherited: the body being quoted may itself be a reply,
  // carrying the quote it answered plus the `<< ` tail. Quoting the whole hop
  // into a quote DATABASE is worse than into a reply — the stored quote would
  // attribute someone else's line to this sender forever.
  it("drops a previous reply-quote out of the body", () => {
    expect(addQuoteCommand(msg({ sender: "alice", body: "<bob> original<< answer" }))).toBe(
      "!addquote answer",
    );
  });

  it("refuses a body that is only a previous reply-quote", () => {
    expect(addQuoteCommand(msg({ sender: "alice", body: "<bob> original<< " }))).toBeNull();
  });

  // `<<` is ordinary text and must not be mistaken for a quote tail.
  it("leaves a shift expression alone", () => {
    expect(addQuoteCommand(msg({ body: "shift << 2 gives four" }))).toBe(
      "!addquote shift << 2 gives four",
    );
  });
});

describe("addQuoteToCompose", () => {
  it("fills an empty compose with exactly the command", () => {
    mountCompose();
    addQuoteToCompose(msg({}), NET, CHAN);
    expect(getDraft(KEY)).toBe("!addquote ciao mondo");
  });

  // Never destroy work in progress: the command lands AFTER what is already
  // there, the same posture Reply takes.
  it("does not clobber an existing draft", () => {
    mountCompose();
    setDraft(KEY, "bozza ");
    addQuoteToCompose(msg({}), NET, CHAN);
    expect(getDraft(KEY)).toBe("bozza !addquote ciao mondo");
  });

  it("writes nothing for an unquotable row", () => {
    mountCompose();
    addQuoteToCompose(msg({ kind: "part", body: null }), NET, CHAN);
    expect(getDraft(KEY)).toBe("");
  });

  // The caret must land at the END and be VISIBLE: `!addquote ` plus a body
  // overflows the rows=1 textarea essentially every time, which is why #1107
  // was blocked on #1105/#1113. Shared through `appendToCompose`, so this pins
  // that the item uses that verb rather than writing the draft by hand.
  it("leaves the caret at the end of the filled draft", async () => {
    const ta = mountCompose();
    addQuoteToCompose(msg({}), NET, CHAN);
    ta.value = getDraft(KEY);
    await Promise.resolve();
    expect(ta.selectionStart).toBe("!addquote ciao mondo".length);
    expect(document.activeElement).toBe(ta);
  });
});
