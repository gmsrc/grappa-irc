// #348 — the away oracle is the instrument three negative assertions are
// judged by, so it has to be evidence rather than a shrug. These run under
// the cic vitest project (see vitest.config.ts) because the wait is
// deliberately free of the e2e-only `irc-framework` dependency — same
// reason, same shape as `privmsgWait.test.ts`.
//
// The cases that matter are the ones where the OLD stream-watching oracle
// answered "not away" for the wrong reason: nobody answered at all, the
// nick is not on the network, or the 301 belonged to somebody else.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitWhoisAway, type RawLineEvent, type WhoisSource } from "./whoisWait";

type FakeSource = WhoisSource & {
  server: (line: string) => void;
  own: (line: string) => void;
  attached: () => number;
  sent: () => string[][];
};

function fakeSource(): FakeSource {
  const handlers = new Set<(event: RawLineEvent) => void>();
  const sent: string[][] = [];
  return {
    on: (_event, handler) => {
      handlers.add(handler);
    },
    removeListener: (_event, handler) => {
      handlers.delete(handler);
    },
    raw: (parts) => {
      sent.push(parts);
    },
    server: (line) => {
      for (const handler of [...handlers]) handler({ line, from_server: true });
    },
    own: (line) => {
      for (const handler of [...handlers]) handler({ line, from_server: false });
    },
    attached: () => handlers.size,
    sent: () => sent,
  };
}

async function failureOf(wait: Promise<boolean>): Promise<string> {
  try {
    await wait;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the round-trip to reject, but it resolved");
}

const NICK = "s1a2b3c4";
const END = `:leaf4.azzurra.chat 318 i348-away-watcher ${NICK} :End of /WHOIS list.`;
const AWAY = `:leaf4.azzurra.chat 301 i348-away-watcher ${NICK} :auto-away`;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("awaitWhoisAway", () => {
  it("asks: it puts the WHOIS on the wire, or nothing would ever answer", () => {
    const source = fakeSource();
    void awaitWhoisAway(source, { nick: NICK, timeoutMs: 1_000 }).catch(() => {});
    expect(source.sent()).toEqual([["WHOIS", NICK]]);
  });

  it("is away when a 301 precedes the 318", async () => {
    const source = fakeSource();
    const wait = awaitWhoisAway(source, { nick: NICK, timeoutMs: 1_000 });
    source.server(AWAY);
    source.server(END);
    await expect(wait).resolves.toBe(true);
  });

  it("is present when the round-trip completes with no 301 — an answer, not a silence", async () => {
    const source = fakeSource();
    const wait = awaitWhoisAway(source, { nick: NICK, timeoutMs: 1_000 });
    source.server(`:leaf4.azzurra.chat 311 i348-away-watcher ${NICK} u h * :real name`);
    source.server(END);
    await expect(wait).resolves.toBe(false);
  });

  it("rejects when nobody answers: silence is not a verdict of present", async () => {
    const source = fakeSource();
    // The rejection handler is attached BEFORE the clock is advanced: a
    // rejection that lands with nothing listening is an unhandled rejection,
    // which vitest fails the RUN over while every test still reports green.
    const failure = failureOf(awaitWhoisAway(source, { nick: NICK, timeoutMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await failure).toContain("no 318 RPL_ENDOFWHOIS");
  });

  it("rejects on 401: a nick that is not on the network says nothing about the session", async () => {
    const source = fakeSource();
    const wait = awaitWhoisAway(source, { nick: NICK, timeoutMs: 1_000 });
    source.server(`:leaf4.azzurra.chat 401 i348-away-watcher ${NICK} :No such nick/channel`);
    expect(await failureOf(wait)).toContain("401 ERR_NOSUCHNICK");
  });

  it("ignores a 301 about somebody else", async () => {
    const source = fakeSource();
    const wait = awaitWhoisAway(source, { nick: NICK, timeoutMs: 1_000 });
    source.server(":leaf4.azzurra.chat 301 i348-away-watcher someone-else :away");
    source.server(END);
    await expect(wait).resolves.toBe(false);
  });

  it("ignores a numeric that only appears in the away message's free text", async () => {
    const source = fakeSource();
    const wait = awaitWhoisAway(source, { nick: NICK, timeoutMs: 1_000 });
    source.server(
      `:leaf4.azzurra.chat 311 i348-away-watcher ${NICK} u h * :gone, ask 301 about ${NICK}`,
    );
    source.server(END);
    await expect(wait).resolves.toBe(false);
  });

  it("ignores our own outbound frames", async () => {
    const source = fakeSource();
    const wait = awaitWhoisAway(source, { nick: NICK, timeoutMs: 1_000 });
    // `raw` fires for both directions; a 301-shaped line we SENT is not the
    // network telling us anything.
    source.own(AWAY);
    source.server(END);
    await expect(wait).resolves.toBe(false);
  });

  it("detaches its listener on every branch, so a peer does not accumulate handlers", async () => {
    const answered = fakeSource();
    const wait = awaitWhoisAway(answered, { nick: NICK, timeoutMs: 1_000 });
    expect(answered.attached()).toBe(1);
    answered.server(END);
    await wait;
    expect(answered.attached()).toBe(0);

    const silent = fakeSource();
    const timedOut = failureOf(awaitWhoisAway(silent, { nick: NICK, timeoutMs: 1_000 }));
    expect(silent.attached()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_001);
    await timedOut;
    expect(silent.attached()).toBe(0);
  });
});
