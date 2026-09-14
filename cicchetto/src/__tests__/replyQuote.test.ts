// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";
import { getDraft, setDraft } from "../lib/compose";
import { appendToCompose } from "../lib/composeAppend";
import { quotableBody, replyQuoteHeadLength } from "../lib/quotableBody";
import {
  REPLY_QUOTE_BODY_LIMIT,
  REPLY_QUOTE_ELLIPSIS,
  REPLY_QUOTE_TAIL,
  replyQuote,
  replyToMessage,
} from "../lib/replyQuote";
import {
  PASTED_REPLY_ANSWER,
  PASTED_REPLY_BODY,
  PASTED_REPLY_HEAD,
} from "./helpers/pastedReplyQuote";

// #1067 — the reply verb: a swipe (or the menu's Reply item) drops
// `<nick> quoted message<< ` into the compose box with the caret at the end,
// ready for the answer to be typed straight after it.

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

describe("replyQuote", () => {
  it("renders the irssi-shaped quote the issue specifies", () => {
    expect(replyQuote(msg({}))).toBe("<vjt> ciao mondo << ");
  });

  // The body on the wire can carry mIRC colour/bold control bytes; the operator
  // is quoting what they SEE, and a control byte pasted into compose would be
  // re-sent verbatim as formatting they never chose.
  it("strips mIRC control codes out of the quoted body", () => {
    expect(replyQuote(msg({ body: "\x02bold\x02 plain" }))).toBe("<vjt> bold plain << ");
  });

  // Presence rows (join/part/quit/mode/…) have no author speaking and often no
  // body at all — there is nothing to quote, and `<vjt> << ` is not a reply.
  it("refuses a presence row", () => {
    expect(replyQuote(msg({ kind: "join", body: null }))).toBeNull();
  });

  it("refuses a row whose body is empty or whitespace", () => {
    expect(replyQuote(msg({ body: "" }))).toBeNull();
    expect(replyQuote(msg({ body: "   " }))).toBeNull();
    expect(replyQuote(msg({ body: null }))).toBeNull();
  });

  it("refuses a row with no sender", () => {
    expect(replyQuote(msg({ sender: "" }))).toBeNull();
  });

  it("quotes a notice like speech — it has an author and a body", () => {
    expect(replyQuote(msg({ kind: "notice" }))).toBe("<vjt> ciao mondo << ");
  });

  // #1126 — a real action row carries the wire envelope (`\x01ACTION …\x01`);
  // the server stores it verbatim per the CLAUDE.md "preserved as-is" rule.
  // The pre-#1126 quote ran the raw body through `mircPlainText`, which leaves
  // \x01 alone by design, so BOTH the `ACTION` verb and the two delimiters
  // ended up in the compose box and from there onto the wire.
  it("quotes an action in ACTION form, envelope stripped — #1126", () => {
    expect(replyQuote(msg({ kind: "action", body: "\x01ACTION si dà alla fuga\x01" }))).toBe(
      "* vjt si dà alla fuga << ",
    );
  });

  // The delimiters are the protocol half of the defect: a \x01 we generated
  // inside an ordinary PRIVMSG. Asserted separately from the shape above so a
  // future reshaping of the quote cannot quietly take the guard with it.
  it("leaves no \\x01 in the quote of an action — #1126", () => {
    const quote = replyQuote(msg({ kind: "action", body: "\x01ACTION waves\x01" })) ?? "";
    expect(quote).not.toContain("\x01");
    expect(quote).not.toContain("ACTION");
  });

  // `stripCtcpAction` is deliberately defensive about a missing envelope (a
  // future server-side pre-strip, or a row persisted before the wire form was
  // stored). The action SHAPE must not depend on the envelope being there.
  it("still uses action form when the envelope is absent — #1126", () => {
    expect(replyQuote(msg({ kind: "action", body: "ciao mondo" }))).toBe("* vjt ciao mondo << ");
  });

  // An envelope with nothing inside is not a quotable action: after the strip
  // the body is empty, and `* vjt << ` is not a reply to anything.
  it("refuses an action whose envelope is empty — #1126", () => {
    expect(replyQuote(msg({ kind: "action", body: "\x01ACTION \x01" }))).toBeNull();
  });
});

// #1123 — replying to a reply used to nest: the quoted body already carried a
// quote plus its `<< ` tail, so every hop dragged the whole history forward and
// the line actually being answered ended up buried mid-string.
describe("replyQuote — a previous quote is dropped (#1123)", () => {
  it("quotes only what the sender wrote, not the quote they were answering", () => {
    expect(replyQuote(msg({ sender: "alice", body: "<bob> original<< answer" }))).toBe(
      "<alice> answer << ",
    );
  });

  // The cut is at the LAST tail, not the first: a body persisted before this
  // fix carries several hops, and stopping at the first `<< ` would keep every
  // one of them but the oldest.
  it("cuts at the last tail, not the first", () => {
    expect(
      replyQuote(msg({ sender: "carol", body: "<alice> <bob> original<< answer<< reply" })),
    ).toBe("<carol> reply << ");
  });

  // #1126 gave actions their own quote head (`* nick …`), so the client emits
  // two shapes and both nest. One bug, both doors.
  it("drops a previous action-shaped quote too", () => {
    expect(replyQuote(msg({ sender: "alice", body: "* bob waves<< sure" }))).toBe(
      "<alice> sure << ",
    );
  });

  it("drops a previous quote inside an action being quoted", () => {
    expect(
      replyQuote(
        msg({ kind: "action", sender: "alice", body: "\x01ACTION <bob> orig<< nods\x01" }),
      ),
    ).toBe("* alice nods << ");
  });

  // Every legal nick special (RFC 2812 `special` plus the tail-only dash),
  // mirroring `Grappa.IRC.Identifier`'s nick regex. A charset invented here
  // instead of derived would silently refuse to strip these.
  it("recognises a head with every legal nick special", () => {
    expect(replyQuote(msg({ sender: "alice", body: "<_a[b]\\c{d}|e^f`g-1> quoted<< mine" }))).toBe(
      "<alice> mine << ",
    );
  });

  // 30 chars is the cap the server's nick regex enforces; a head at the cap is
  // a real nick and must still be recognised.
  it("recognises a head at the 30-char nick cap", () => {
    const nick = `n${"x".repeat(29)}`;
    expect(nick).toHaveLength(30);
    expect(replyQuote(msg({ sender: "alice", body: `<${nick}> quoted<< mine` }))).toBe(
      "<alice> mine << ",
    );
  });

  // A body that is nothing BUT a previous quote leaves the sender with no words
  // of their own; `<alice> <bob> orig<<<< ` is not a reply to anything. Both
  // spellings are asserted, but they are ONE input: the body is trimmed before
  // the cut, so the tail sits flush against the end either way — which is also
  // how a wire that eats trailing whitespace delivers it.
  it("refuses a body that is only a previous quote", () => {
    expect(replyQuote(msg({ sender: "alice", body: "<bob> original<< " }))).toBeNull();
    expect(replyQuote(msg({ sender: "alice", body: "<bob> original<<" }))).toBeNull();
  });

  // The cut consumes exactly one space of the tail, so anything the sender
  // typed after a wider gap would arrive with the gap still on it.
  it("does not carry the gap after the tail into the new quote", () => {
    expect(replyQuote(msg({ sender: "alice", body: "<bob> original<<   spaced" }))).toBe(
      "<alice> spaced << ",
    );
  });
});

describe("replyQuote — what must NOT be mistaken for a quote (#1123)", () => {
  // `<<` is ordinary text: a bare substring search would eat a real message,
  // which is worse than the nesting it fixes.
  it("leaves a shift expression alone", () => {
    expect(replyQuote(msg({ body: "shift << 2 gives four" }))).toBe(
      "<vjt> shift << 2 gives four << ",
    );
  });

  it("leaves a heredoc alone", () => {
    expect(replyQuote(msg({ body: "cat <<EOF > f" }))).toBe("<vjt> cat <<EOF > f << ");
  });

  it("leaves a leading angle bracket that is not a nick head alone", () => {
    expect(replyQuote(msg({ body: "<3 you << me" }))).toBe("<vjt> <3 you << me << ");
    expect(replyQuote(msg({ body: "<two words> a << b" }))).toBe("<vjt> <two words> a << b << ");
  });

  // The head must be at position 0. `appendToCompose` drops the quote AFTER an
  // existing draft, so a mid-string quote means the leading text is the
  // sender's own words — cutting there would delete what they wrote.
  it("leaves a quote that is not at the start of the body alone", () => {
    expect(replyQuote(msg({ sender: "alice", body: "bozza <bob> ciao<< risposta" }))).toBe(
      "<alice> bozza <bob> ciao<< risposta << ",
    );
  });
});

// #1235 — vjt: "sul reply limitiamo a 42 i caratteri di cui facciamo reply, se
// sforano mettiamo un ellipsis `...`, e poi mettiamo sempre uno spazio prima
// del `<<` finale". #1277 raised that 42 to 100 — the number moved, every
// reading below did not. The cap lives in the WRAPPER, never in
// `quotableBody`: that helper is shared with `!addquote` (#1107), which
// archives the line and must keep it whole. `addQuote.test.ts` is the control
// group for that.
describe("replyQuote — the quoted body is capped (#1235, #1277)", () => {
  const AT_LIMIT = "a".repeat(REPLY_QUOTE_BODY_LIMIT);

  it("leaves a body at the limit whole, with no ellipsis", () => {
    expect(replyQuote(msg({ body: AT_LIMIT }))).toBe(`<vjt> ${AT_LIMIT} << `);
  });

  // The first body over the limit is where an off-by-one shows: one way it
  // clips a body that fits, the other it lets a 101st character through.
  it("caps the first body that overflows", () => {
    expect(replyQuote(msg({ body: `${AT_LIMIT}b` }))).toBe(`<vjt> ${AT_LIMIT}... << `);
  });

  // The 100 counts BODY characters and the ellipsis is ADDED past them — the
  // quoted run is 103, not 100 with three of them spent on dots.
  it("keeps a full 100 characters and adds the ellipsis after them", () => {
    const quote = replyQuote(msg({ body: "x".repeat(200) })) ?? "";
    const quoted = quote.slice("<vjt> ".length, -REPLY_QUOTE_TAIL.length);
    expect(quoted).toBe(`${"x".repeat(REPLY_QUOTE_BODY_LIMIT)}${REPLY_QUOTE_ELLIPSIS}`);
    expect(quoted).toHaveLength(REPLY_QUOTE_BODY_LIMIT + REPLY_QUOTE_ELLIPSIS.length);
  });

  // Hardcoded on purpose, against the constant: the request spells the marker
  // `...`, and a U+2026 that renders identically would still be a different
  // byte sequence going onto the wire.
  it("marks the overflow with three ASCII dots, not U+2026", () => {
    const quote = replyQuote(msg({ body: "x".repeat(200) })) ?? "";
    expect(quote).toContain("x...");
    expect(quote).not.toContain("…");
  });

  // A flat cut, with no backing off to the last word boundary: that is the
  // request read literally, and a word-boundary rule would make the quote
  // length depend on where the spaces happen to fall. The body is sized by
  // hand against 100 so the cut lands INSIDE the last word — a body that
  // happened to end on a space would pass under either rule.
  it("cuts flat at the limit, mid-word", () => {
    const body = `${"parola ".repeat(14)}spezzata`;
    expect(body).toHaveLength(106);
    expect(replyQuote(msg({ body }))).toBe(`<vjt> ${"parola ".repeat(14)}sp... << `);
  });

  // The cap is on the BODY: a long nick does not eat into what the sender said.
  it("does not count the nick head against the limit", () => {
    const nick = "n".repeat(30);
    expect(replyQuote(msg({ sender: nick, body: AT_LIMIT }))).toBe(`<${nick}> ${AT_LIMIT} << `);
  });

  // The cap runs AFTER the #1123 de-nesting cut, on what the sender actually
  // wrote. Capping first would spend the whole budget on the quote they were
  // answering and truncate their answer to nothing.
  it("counts what the sender wrote, not the quote they were answering", () => {
    const body = `<bob> ${"o".repeat(200)}<< breve`;
    expect(replyQuote(msg({ sender: "alice", body }))).toBe("<alice> breve << ");
  });

  // A UTF-16 slice at 100 can land between the halves of a surrogate pair and
  // emit a lone surrogate — an unpaired code unit in the compose box, and from
  // there onto the wire. The cut counts code points: the emoji is the 100th of
  // them but sits at UTF-16 indices 99 and 100, so a unit-wise `slice(0, 100)`
  // would keep its high surrogate alone.
  it("does not cut an astral character in half", () => {
    const quote = replyQuote(msg({ body: `${"a".repeat(99)}🍺x` })) ?? "";
    expect(quote).toBe(`<vjt> ${"a".repeat(99)}🍺... << `);
    expect(quote.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")).not.toMatch(/[\uD800-\uDFFF]/);
  });
});

// #1235 — the tail grew a leading space. The de-nesting regex
// (`quotableBody.ts`) is `^(?:<nick>|\* nick) [\s\S]*<<(?: |$)`, whose greedy
// head absorbs a space as happily as a word character, so the nesting cut is
// supposed to keep working on BOTH spellings. That is the one thing which would
// silently break every line already persisted, so it is asserted, not assumed.
describe("replyQuote — the spaced tail still de-nests, both spellings (#1235)", () => {
  it("strips a quote persisted with the OLD flush tail", () => {
    expect(replyQuote(msg({ sender: "alice", body: "<bob> original<< answer" }))).toBe(
      "<alice> answer << ",
    );
  });

  it("strips a quote written with the NEW spaced tail", () => {
    expect(replyQuote(msg({ sender: "alice", body: "<bob> original << answer" }))).toBe(
      "<alice> answer << ",
    );
  });

  // The full round trip: what the wrapper emits today, quoted again tomorrow.
  it("round-trips its own output", () => {
    const first = replyQuote(msg({ sender: "bob", body: "original" })) ?? "";
    expect(replyQuote(msg({ sender: "alice", body: `${first}answer` }))).toBe("<alice> answer << ");
  });

  // And the same trip on a CAPPED line, where the tail follows an ellipsis
  // rather than a word — the shape the cap makes commonplace.
  it("round-trips a capped quote", () => {
    const first = replyQuote(msg({ sender: "bob", body: "o".repeat(200) })) ?? "";
    expect(replyQuote(msg({ sender: "alice", body: `${first}answer` }))).toBe("<alice> answer << ");
  });
});

describe("appendToCompose", () => {
  it("appends to the draft and leaves the caret at the very end", async () => {
    const ta = mountCompose();
    setDraft(KEY, "gia scritto ");
    appendToCompose(NET, CHAN, "coda");
    expect(getDraft(KEY)).toBe("gia scritto coda");
    // The caret lands on the next microtask, after the controlled value commits.
    ta.value = getDraft(KEY);
    await Promise.resolve();
    expect(ta.selectionStart).toBe("gia scritto coda".length);
    expect(document.activeElement).toBe(ta);
  });

  // #1105 — the caret is placed at the end, but the rows=1 textarea is an
  // internal scroll container: a draft that wraps leaves it pinned at
  // scrollTop 0 with the caret below the fold. jsdom does no layout, so
  // `scrollHeight` is 0 on every element and a bare assertion here would pass
  // vacuously — the overflow is stubbed so this pins the assignment itself.
  // That a real viewport then shows the caret is the e2e spec's job.
  it("scrolls the overflowing textarea down to the caret", async () => {
    const ta = mountCompose();
    Object.defineProperty(ta, "scrollHeight", { value: 75, configurable: true });
    setDraft(KEY, "x".repeat(110));
    appendToCompose(NET, CHAN, "coda");
    ta.value = getDraft(KEY);
    await Promise.resolve();
    expect(ta.scrollTop).toBe(75);
  });

  it("is a no-op when no compose textarea is mounted", () => {
    setDraft(KEY, "resta");
    appendToCompose(NET, CHAN, "x");
    expect(getDraft(KEY)).toBe("resta");
  });
});

describe("replyToMessage", () => {
  it("fills an empty compose with exactly the quote", () => {
    mountCompose();
    replyToMessage(msg({}), NET, CHAN);
    expect(getDraft(KEY)).toBe("<vjt> ciao mondo << ");
  });

  // Never destroy work in progress — #1067's rule, and it still holds: the
  // half-typed line survives the gesture whole. #1688 changed only WHERE the
  // quote goes relative to it. The old expectation here was
  // `bozza <vjt> ciao mondo << `, which is the defect peluche reported.
  it("does not clobber an existing draft", () => {
    mountCompose();
    setDraft(KEY, "bozza ");
    replyToMessage(msg({}), NET, CHAN);
    // Both halves, so a cure that dropped either one cannot pass here while the
    // ordering arms below carry the shape.
    expect(getDraft(KEY)).toContain("bozza ");
    expect(getDraft(KEY)).toContain("<vjt> ciao mondo << ");
  });

  // #1688 — the tail is documented (`replyQuote.ts`) as ending the line "so the
  // answer is typed straight after the caret": quote first, answer last. A
  // draft holding the operator's own words used to come back with the quote
  // BEHIND them, which inverts that and leaves a `<<` reading as if it
  // separated a quote from an answer sitting in front of it.
  it("puts the quote in FRONT of a draft the operator typed — #1688", () => {
    mountCompose();
    setDraft(KEY, "la mia risposta");
    replyToMessage(msg({}), NET, CHAN);
    expect(getDraft(KEY)).toBe("<vjt> ciao mondo << la mia risposta");
  });

  // The documented invariant is about the END of the line, so it is asserted as
  // one: whatever the draft held, the tail is followed by the operator's words
  // and by nothing of ours.
  it("leaves the operator's words after the tail, not before it — #1688", () => {
    mountCompose();
    setDraft(KEY, "la mia risposta");
    replyToMessage(msg({}), NET, CHAN);
    const draft = getDraft(KEY);
    expect(draft.indexOf(REPLY_QUOTE_TAIL)).toBeLessThan(draft.indexOf("la mia risposta"));
  });

  // The caret decision #1688 worried about costs nothing: `updateCompose` places
  // it at the very end unconditionally, which after a prepend IS the end of the
  // typed answer. Asserted rather than assumed — it is the half of the
  // invariant a string comparison cannot see.
  it("leaves the caret at the end of the typed answer after a prepend — #1688", async () => {
    const ta = mountCompose();
    setDraft(KEY, "la mia risposta");
    replyToMessage(msg({}), NET, CHAN);
    ta.value = getDraft(KEY);
    await Promise.resolve();
    expect(ta.selectionStart).toBe("<vjt> ciao mondo << la mia risposta".length);
    expect(document.activeElement).toBe(ta);
  });

  // A draft is OURS to reorder only when it actually carries one of our quotes.
  // `<<` is ordinary text — the same trap `quotableBody`'s de-nesting regex was
  // written to avoid (`shift << 2`, `cat <<EOF`) — so a discriminator that
  // merely searched for the marker would treat a human's shift expression as a
  // quote and append behind it, leaving #1688 unfixed for exactly those drafts.
  it("treats a draft containing a bare << as the operator's own text — #1688", () => {
    mountCompose();
    setDraft(KEY, "shift << 2 gives four");
    replyToMessage(msg({}), NET, CHAN);
    expect(getDraft(KEY)).toBe("<vjt> ciao mondo << shift << 2 gives four");
  });

  // A draft that ENDS with our tail without STARTING with our quote is the
  // shape the pre-#1688 code produced (type first, then reply) — and it can
  // still be sitting in a persisted draft when this change ships. It is ours to
  // extend, not to reorder: #1357's marker shed applies and the quote goes at
  // the end. Found by the mutant bench, which kept a green suite when the
  // `endsWith` half of the test was deleted.
  it("still sheds the marker on a legacy draft that only ENDS with our tail", () => {
    mountCompose();
    setDraft(KEY, "bozza <a> primo << ");
    replyToMessage(msg({ sender: "b", body: "secondo" }), NET, CHAN);
    expect(getDraft(KEY)).toBe("bozza <a> primo <b> secondo << ");
  });

  // Reply, type, reply. The second quote must NOT jump in front of the answer
  // written after the first — that is #1357's acceptance criterion 3, reached
  // here through the #1688 prepend rather than through a hand-set draft.
  it("appends once the draft already carries our quote — #1357 still holds", () => {
    mountCompose();
    replyToMessage(msg({ sender: "a", body: "primo" }), NET, CHAN);
    setDraft(KEY, `${getDraft(KEY)}ciao`);
    replyToMessage(msg({ id: 2, sender: "b", body: "secondo" }), NET, CHAN);
    expect(getDraft(KEY)).toBe("<a> primo << ciao<b> secondo << ");
  });

  it("writes nothing for an unquotable row", () => {
    mountCompose();
    replyToMessage(msg({ kind: "part", body: null }), NET, CHAN);
    expect(getDraft(KEY)).toBe("");
  });

  // #1357 — the line accumulates, the MARKER does not repeat (vjt, 2026-08-15).
  // A second reply used to bury the first tail mid-line, where `<<` reads as
  // part of the quoted text and the answer typed at the caret belongs to the
  // last quote only. The tail's own LEADING space (#1235, so it never sits
  // flush against the last word) is what separates the two quotes afterwards.
  it("keeps both quotes and moves the tail to the end", () => {
    mountCompose();
    replyToMessage(msg({ sender: "a", body: "primo" }), NET, CHAN);
    replyToMessage(msg({ id: 2, sender: "b", body: "secondo" }), NET, CHAN);
    expect(getDraft(KEY)).toBe("<a> primo <b> secondo << ");
  });

  // Stated as a COUNT rather than as a shape, because "one marker" is the
  // ruling — an implementation that emits the right string for two replies and
  // a second tail for three passes the arm above.
  it("leaves exactly one tail after N replies", () => {
    mountCompose();
    for (const sender of ["a", "b", "c"]) {
      replyToMessage(msg({ sender, body: `da ${sender}` }), NET, CHAN);
    }
    expect(getDraft(KEY)).toBe("<a> da a <b> da b <c> da c << ");
    expect(getDraft(KEY).split(REPLY_QUOTE_TAIL.trim())).toHaveLength(2);
  });

  // Acceptance criterion 3: once the operator has typed their answer, the tail
  // is no longer at the end and is no longer OURS to remove — cutting it there
  // would rewrite their sentence, and the new quote must still land after what
  // they wrote. So this line keeps two markers, deliberately: the alternative
  // is mangling text a human typed.
  it("does not touch a tail the operator has already typed past", () => {
    mountCompose();
    setDraft(KEY, "<a> primo << ciao");
    replyToMessage(msg({ sender: "b", body: "secondo" }), NET, CHAN);
    expect(getDraft(KEY)).toBe("<a> primo << ciao<b> secondo << ");
  });
});

// issue 2033 — a BRIDGE relays somebody else's words under its own IRC nick and
// wraps the real author into the body:
//
//   <Gazzurbo> <THREADelli> ne parlavamo in un talk...
//
// `msg.sender` is then the RELAY, not the speaker. Quoting it names a bot and
// buries the person being answered, and the far side receives three
// attributions deep (`<vjt> <Gazzurbo> <THREADelli> …`).
//
// vjt's rulings (2026-09-10, relayed in the issue): detection is the head shape
// ALONE — no configured relay list — and reply re-emits the recovered author as
// `@nick`, a real mention on the far side, because this bridge relays the
// Telegram USERNAME and not the display name.
describe("replyQuote — a bridged message quotes its AUTHOR, not the relay (issue 2033)", () => {
  it("drops the relay's nick and mentions the wrapped author", () => {
    expect(
      replyQuote(msg({ sender: "Gazzurbo", body: "<THREADelli> ne parlavamo in un talk" })),
    ).toBe("@THREADelli ne parlavamo in un talk << ");
  });

  // The `@` is what makes the far side notify the person. Asserted apart from
  // the shape above: an implementation that recovered the author but left it
  // wrapped would pass a `toContain("THREADelli")` and still notify nobody.
  it("leaves the relay's nick nowhere in the quote", () => {
    const quote = replyQuote(msg({ sender: "Gazzurbo", body: "<THREADelli> ciao" })) ?? "";
    expect(quote).toBe("@THREADelli ciao << ");
    expect(quote).not.toContain("Gazzurbo");
    expect(quote).not.toContain("<THREADelli>");
  });

  // The ACCEPTED LIMITATION, pinned as an assertion rather than left to be
  // rediscovered as a bug report (vjt's ruling 1). Detection is structural, so
  // a human writing `<foo> bar` IS read as a relay — and the cost is not a
  // stray `@`: `alice`, the actual speaker, is DROPPED. Priced in knowingly.
  it("misreads a human who writes `<foo> bar` — and drops her, knowingly", () => {
    expect(replyQuote(msg({ sender: "alice", body: "<foo> bar" }))).toBe("@foo bar << ");
  });

  // The other half of the same ruling: what is NOT nick-shaped is not a relay.
  // These are the shapes that keep ordinary prose out of the heuristic.
  it("refuses a head that is not nick-shaped", () => {
    expect(replyQuote(msg({ body: "<3 you" }))).toBe("<vjt> <3 you << ");
    expect(replyQuote(msg({ body: "<two words> a" }))).toBe("<vjt> <two words> a << ");
    expect(replyQuote(msg({ body: "<nospace>x" }))).toBe("<vjt> <nospace>x << ");
  });

  // The head must be at position 0, exactly as #1123 requires of a previous
  // quote: mid-string, the leading text is the sender's own words.
  it("refuses a wrapping that is not at the head of the body", () => {
    expect(replyQuote(msg({ sender: "alice", body: "guarda <bob> ciao" }))).toBe(
      "<alice> guarda <bob> ciao << ",
    );
  });

  // A relay line with nothing past the wrapping is nobody saying anything.
  it("refuses a body that is only the wrapping", () => {
    expect(replyQuote(msg({ sender: "Gazzurbo", body: "<THREADelli> " }))).toBeNull();
  });

  // vjt's ruling 5: the cap is measured on the body AFTER the relay head comes
  // off — the head is not what overflows, the same reading #1235 already made
  // for the nick. Discriminating by construction: `<THREADelli> ` is 13 chars
  // and the body is 95, so the pre-cure string is 108 (capped, ellipsis) and
  // the cured one is 95 (whole).
  it("measures the 100-char cap on the body left AFTER the relay head", () => {
    const words = "x".repeat(95);
    const quote = replyQuote(msg({ sender: "Gazzurbo", body: `<THREADelli> ${words}` })) ?? "";
    expect(quote).toBe(`@THREADelli ${words} << `);
    expect(quote).not.toContain(REPLY_QUOTE_ELLIPSIS);
  });

  it("still caps a bridged body that overflows on its own", () => {
    const words = "y".repeat(REPLY_QUOTE_BODY_LIMIT + 5);
    const quote = replyQuote(msg({ sender: "Gazzurbo", body: `<THREADelli> ${words}` })) ?? "";
    expect(quote).toBe(
      `@THREADelli ${"y".repeat(REPLY_QUOTE_BODY_LIMIT)}${REPLY_QUOTE_ELLIPSIS}${REPLY_QUOTE_TAIL}`,
    );
  });

  // NOT ruled, and decided here rather than left ambiguous: an ACTION row is
  // never read as bridged. #1126 forbids rendering an action as speech, and
  // `!addquote` — which shares this detection — would emit exactly that
  // (`<THREADelli> waves` for something nobody said). No transcript of an
  // action-shaped relay exists, so this falls back to today's behaviour, the
  // same bounded silence rulings 1 and 3 already accept.
  it("never reads an ACTION as bridged — #1126 outranks the heuristic", () => {
    expect(
      replyQuote(
        msg({ kind: "action", sender: "Gazzurbo", body: "\x01ACTION <THREADelli> waves\x01" }),
      ),
    ).toBe("* Gazzurbo <THREADelli> waves << ");
  });

  // The ORDER of the two peels is forced, not free. #1123's cut runs FIRST: a
  // plain reply body (`<bob> original<< answer`) opens with a nick wrapping
  // too, so peeling the relay first would recover `bob` — who is being QUOTED,
  // not speaking — and strand `original<< answer` past a cut that no longer
  // matches. This is the test that fails if the two are swapped.
  it("peels a previous quote BEFORE looking for a relay head", () => {
    expect(replyQuote(msg({ sender: "alice", body: "<bob> original<< answer" }))).toBe(
      "<alice> answer << ",
    );
  });
});

// issue 2086 — the render dims the quoted head, and it must dim EXACTLY the
// region a re-reply strips. `replyQuoteHeadLength` is the one door that answers
// "how far does the quote reach"; `startsWithReplyQuote` is now derived from
// it, so the boolean and the offset cannot come apart.
//
// The structural assertion is the last `it` below: what stays visible past the
// dimmed head is byte-for-byte what `quotableBody` keeps. If the two ever
// disagree, one of them is lying to the reader.
describe("replyQuoteHeadLength — how far the quote reaches (issue 2086)", () => {
  it("counts the head up to and including the tail's trailing space", () => {
    const body = "<bob> ciao mondo << risposta";
    expect(body.slice(0, replyQuoteHeadLength(body))).toBe("<bob> ciao mondo << ");
  });

  it("counts an action-shaped head the same way", () => {
    const body = "* bob saluta << ricambio";
    expect(body.slice(0, replyQuoteHeadLength(body))).toBe("* bob saluta << ");
  });

  it("lands on the LAST tail, so a chain sheds every hop", () => {
    const body = "<a> uno << <b> due << tre";
    expect(body.slice(0, replyQuoteHeadLength(body))).toBe("<a> uno << <b> due << ");
  });

  it("reaches the whole body when the sender wrote nothing past the tail", () => {
    const body = "<bob> ciao mondo <<";
    expect(replyQuoteHeadLength(body)).toBe(body.length);
  });

  it("answers 0 for the shapes that only LOOK like a quote", () => {
    expect(replyQuoteHeadLength("shift << 2 gives four")).toBe(0);
    expect(replyQuoteHeadLength("cat <<EOF > f")).toBe(0);
    expect(replyQuoteHeadLength("<3 you << me")).toBe(0);
    expect(replyQuoteHeadLength("bozza <bob> ciao<< risposta")).toBe(0);
    expect(replyQuoteHeadLength("nessuna citazione qui")).toBe(0);
  });

  it("agrees with what quotableBody keeps — same region, by construction", () => {
    for (const body of [
      "<bob> ciao mondo << risposta",
      "* bob saluta << ricambio",
      "<a> uno << <b> due << tre",
      "shift << 2 gives four",
      "nessuna citazione qui",
    ]) {
      expect(body.slice(replyQuoteHeadLength(body)).trim()).toBe(quotableBody(msg({ body })));
    }
  });
});

// issue 2156 — the same head, wearing the decorations ANOTHER client prints.
// vjt pasted a line from an irssi-shaped client into #grappa and the grey did
// not reach it. Two decorations sit at the head and EITHER ONE alone takes the
// match to 0: the pasting client's `HH:MM:SS ` in front, and the channel-status
// sigil inside the wrapper. cic produces neither, by an explicit decision
// (`replyQuote.ts`: the quote is built from the MESSAGE so the row's timestamp
// and prefix glyph stay out of it) — so the detector was never too narrow by
// accident, it was exactly as narrow as what WE emit.
//
// Only the HEAD widens. The nick wrapper stays mandatory and the tail is
// untouched, which is what keeps `shift << 2` somebody's sentence.
describe("replyQuoteHeadLength — a quote pasted by another client (issue 2156)", () => {
  const head = (body: string): string => body.slice(0, replyQuoteHeadLength(body));

  // The fixture is evidence, so it is checked before it is used: a head plus an
  // answer that do not reconstitute the transcript would let every assertion
  // below pass against a paste nobody ever sent.
  it("pins the reported transcript: head + answer IS the pasted body", () => {
    expect(PASTED_REPLY_HEAD + PASTED_REPLY_ANSWER).toBe(PASTED_REPLY_BODY);
  });

  it("reaches through the timestamp AND the sigil — the body vjt reported", () => {
    expect(head(PASTED_REPLY_BODY)).toBe(PASTED_REPLY_HEAD);
  });

  // Each decoration on its own, because the fix is two independent widenings
  // and a test that only carried both would stay green with one of them gone.
  it("reaches through a leading timestamp alone, at every width a paste carries", () => {
    expect(head("19:19:22 <bob> ciao << risposta")).toBe("19:19:22 <bob> ciao << ");
    expect(head("19:19 <bob> ciao << risposta")).toBe("19:19 <bob> ciao << ");
    expect(head("9:19 <bob> ciao << risposta")).toBe("9:19 <bob> ciao << ");
  });

  // Wider than cic's own `MODE_PREFIX_TABLE` (`@%+`, the ohv we model) on
  // purpose: the paste comes from somebody else's client on somebody else's
  // network, where `~` (founder) and `&` (admin) are printed too. A sigil is
  // not a nick character in RFC 2812, so none of these can be read as the nick
  // itself and the widening buys no ambiguity.
  it("reaches through a channel-status sigil alone, for every prefix a paste carries", () => {
    for (const sigil of ["@", "%", "+", "~", "&"]) {
      expect(head(`<${sigil}bob> ciao << risposta`)).toBe(`<${sigil}bob> ciao << `);
    }
  });

  it("still lands on the LAST tail when the paste is itself a chain", () => {
    expect(head("19:00 <@a> uno << 19:01 <+b> due << tre")).toBe(
      "19:00 <@a> uno << 19:01 <+b> due << ",
    );
  });

  // The nick wrapper stays MANDATORY. A timestamp is not what makes a quote —
  // if it were, every line somebody pasted with a `<<` in it would go grey.
  it("keeps the nick wrapper mandatory — a timestamp alone is not a quote", () => {
    expect(replyQuoteHeadLength("12:30 roba << altro")).toBe(0);
    expect(replyQuoteHeadLength("19:19:22 shift << 2 gives four")).toBe(0);
    expect(replyQuoteHeadLength("<@> ciao << risposta")).toBe(0);
    expect(replyQuoteHeadLength("19:19:22<bob> ciao << risposta")).toBe(0);
  });

  // Deliberately NOT widened (issue 2156 says so, and these are the spellings
  // that would take the head back to "accepts anything in front of a `<<`").
  // None was ever reported; each is another client's dialect.
  it("stays shut on the spellings this issue deliberately did not widen", () => {
    expect(replyQuoteHeadLength("[19:19] <bob> ciao << risposta")).toBe(0);
    expect(replyQuoteHeadLength("2026-09-14 19:19:22 <bob> ciao << risposta")).toBe(0);
    expect(replyQuoteHeadLength("19:19 <       bob> ciao << risposta")).toBe(0);
  });

  // THE SECOND DOOR, stated rather than discovered. `PREVIOUS_QUOTE` is also
  // what a REQUOTE strips, so widening the head means re-quoting a pasted line
  // now drops the pasted timestamp and sigil along with the quote. That is the
  // intent — the strip means "what the sender actually wrote" — and this is
  // where it is written down.
  it("strips the pasted decorations at the requote door too — one region", () => {
    const body = PASTED_REPLY_BODY;
    expect(quotableBody(msg({ body }))).toBe(PASTED_REPLY_ANSWER);
    expect(body.slice(replyQuoteHeadLength(body)).trim()).toBe(quotableBody(msg({ body })));
  });
});

// THE THIRD DOOR — `startsWithReplyQuote` (#1688), which decides whether a
// compose draft already carries a quote and so whether a new one is appended or
// prepended. Issue 2156 names two consumers; there are three, and this one also
// changes behaviour: a draft the operator PASTED from another client used to
// read as their own text and take the quote in front, and now reads as
// quote-shaped and takes it behind. Consistent with the head being the only
// discriminator anywhere, but it is a change, so it is pinned.
describe("draft ordering against a PASTED quote (issue 2156, third door)", () => {
  it("appends behind a draft that is a quote pasted from another client", () => {
    mountCompose();
    setDraft(KEY, "19:19:22 <@Johnny^Lizard> ciao << lol");
    replyToMessage(msg({}), NET, CHAN);
    expect(getDraft(KEY)).toBe("19:19:22 <@Johnny^Lizard> ciao << lol<vjt> ciao mondo << ");
  });

  // The other side of the same discriminator, so the arm above cannot be
  // satisfied by an implementation that simply stopped prepending.
  it("still puts the quote in FRONT of a draft that merely opens with a time", () => {
    mountCompose();
    setDraft(KEY, "19:19:22 la mia risposta");
    replyToMessage(msg({}), NET, CHAN);
    expect(getDraft(KEY)).toBe("<vjt> ciao mondo << 19:19:22 la mia risposta");
  });
});
