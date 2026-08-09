// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";
import { getDraft, setDraft } from "../lib/compose";
import { appendToCompose } from "../lib/composeAppend";
import { replyQuote, replyToMessage } from "../lib/replyQuote";

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
    expect(replyQuote(msg({}))).toBe("<vjt> ciao mondo<< ");
  });

  // The body on the wire can carry mIRC colour/bold control bytes; the operator
  // is quoting what they SEE, and a control byte pasted into compose would be
  // re-sent verbatim as formatting they never chose.
  it("strips mIRC control codes out of the quoted body", () => {
    expect(replyQuote(msg({ body: "\x02bold\x02 plain" }))).toBe("<vjt> bold plain<< ");
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
    expect(replyQuote(msg({ kind: "notice" }))).toBe("<vjt> ciao mondo<< ");
  });

  // #1126 — a real action row carries the wire envelope (`\x01ACTION …\x01`);
  // the server stores it verbatim per the CLAUDE.md "preserved as-is" rule.
  // The pre-#1126 quote ran the raw body through `mircPlainText`, which leaves
  // \x01 alone by design, so BOTH the `ACTION` verb and the two delimiters
  // ended up in the compose box and from there onto the wire.
  it("quotes an action in ACTION form, envelope stripped — #1126", () => {
    expect(replyQuote(msg({ kind: "action", body: "\x01ACTION si dà alla fuga\x01" }))).toBe(
      "* vjt si dà alla fuga<< ",
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
    expect(replyQuote(msg({ kind: "action", body: "ciao mondo" }))).toBe("* vjt ciao mondo<< ");
  });

  // An envelope with nothing inside is not a quotable action: after the strip
  // the body is empty, and `* vjt << ` is not a reply to anything.
  it("refuses an action whose envelope is empty — #1126", () => {
    expect(replyQuote(msg({ kind: "action", body: "\x01ACTION \x01" }))).toBeNull();
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
    expect(getDraft(KEY)).toBe("<vjt> ciao mondo<< ");
  });

  // Never destroy work in progress: the quote lands AFTER what is already
  // there, so a half-typed line survives the gesture.
  it("does not clobber an existing draft", () => {
    mountCompose();
    setDraft(KEY, "bozza ");
    replyToMessage(msg({}), NET, CHAN);
    expect(getDraft(KEY)).toBe("bozza <vjt> ciao mondo<< ");
  });

  it("writes nothing for an unquotable row", () => {
    mountCompose();
    replyToMessage(msg({ kind: "part", body: null }), NET, CHAN);
    expect(getDraft(KEY)).toBe("");
  });
});
