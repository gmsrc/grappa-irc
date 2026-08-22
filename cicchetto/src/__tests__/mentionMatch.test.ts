import { describe, expect, it } from "vitest";
import { isMentionableSender, matchesWatchlist } from "../lib/mentionMatch";

// #370 — `matchesWatchlist` is the SINGLE client-side match predicate for
// the in-message visual highlight (ScrollbackPane `.scrollback-mention` /
// `.scrollback-highlight`, MentionsWindow) AND the notify mirror
// (pushTriggers `mentioned`). It mirrors the server SSOT
// `Grappa.Mentions.mentioned?/3` = own nick ∪ custom highlight patterns,
// word-boundary, case-insensitive.
//
// The #370 bug was that the visual path only ever received the own nick —
// so a message matching a custom /hilight word fired the (server-side)
// notification but rendered as a plain line. These cases pin the extended
// contract: a custom pattern matches exactly like the own nick does.

describe("matchesWatchlist — own nick ∪ custom highlight patterns (#370)", () => {
  it("matches the own nick at a word boundary (own-nick path unchanged)", () => {
    expect(matchesWatchlist("hey vjt around?", "vjt", [])).toBe(true);
    expect(matchesWatchlist("VJT ping", "vjt", [])).toBe(true);
  });

  it("respects word boundaries for the own nick (no substring match)", () => {
    expect(matchesWatchlist("vjtfoo bar", "vjt", [])).toBe(false);
  });

  it("matches a CUSTOM highlight pattern even when the own nick is absent", () => {
    // The #370 gap: this returned false before patterns were threaded in.
    expect(matchesWatchlist("the deploy is done", "vjt", ["deploy"])).toBe(true);
  });

  it("is case-insensitive on a custom pattern", () => {
    expect(matchesWatchlist("DEPLOY finished", "vjt", ["deploy"])).toBe(true);
  });

  it("respects word boundaries for a custom pattern (no substring match)", () => {
    // "deployment" contains "deploy" but is a different word.
    expect(matchesWatchlist("deployment scheduled", "vjt", ["deploy"])).toBe(false);
  });

  it("matches any one of several patterns", () => {
    expect(matchesWatchlist("ship it", "vjt", ["deploy", "ship", "release"])).toBe(true);
  });

  it("does not match when neither the nick nor any pattern is present", () => {
    expect(matchesWatchlist("just chatting here", "vjt", ["deploy"])).toBe(false);
  });

  it("is false for an empty body regardless of patterns", () => {
    expect(matchesWatchlist("", "vjt", ["deploy"])).toBe(false);
    expect(matchesWatchlist(null, "vjt", ["deploy"])).toBe(false);
  });

  it("tolerates a null own nick and matches on patterns alone", () => {
    // A not-yet-resolved own nick must not blank out custom-word highlights.
    expect(matchesWatchlist("the deploy is done", null, ["deploy"])).toBe(true);
  });

  it("is false when both the nick is null and there are no patterns", () => {
    expect(matchesWatchlist("anything at all", null, [])).toBe(false);
  });
});

// #1674 — the SENDER half of the mention rule. Mirror of
// `Grappa.Mentions.mentionable_sender?/1`. Keyed on the sender because
// neither of the alternatives survives: excluding `:notice` silences a
// human `/notice`, and excluding `$server` misses the service's own query
// window, which over-counted identically (measured server-side).
describe("isMentionableSender — a robot cannot mention you (#1674)", () => {
  it("excludes services and the server", () => {
    expect(isMentionableSender("NickServ")).toBe(false);
    expect(isMentionableSender("chanserv")).toBe(false);
    expect(isMentionableSender("nightwish.azzurra.chat")).toBe(false);
  });

  it("keeps every other sender", () => {
    expect(isMentionableSender("bob")).toBe(true);
    // Closed allowlist: real ops nicks merely ending in "serv" stay
    // mentionable (bucket H/S4 regression guard).
    expect(isMentionableSender("Conserv")).toBe(true);
  });

  it("only ever subtracts — an unclassifiable sender stays mentionable", () => {
    expect(isMentionableSender("")).toBe(true);
  });
});
