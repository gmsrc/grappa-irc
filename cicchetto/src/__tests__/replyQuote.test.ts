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

  it("quotes a notice and an action — both have an author and a body", () => {
    expect(replyQuote(msg({ kind: "notice" }))).toBe("<vjt> ciao mondo<< ");
    expect(replyQuote(msg({ kind: "action" }))).toBe("<vjt> ciao mondo<< ");
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
