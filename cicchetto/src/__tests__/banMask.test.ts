import { describe, expect, it } from "vitest";
import { type BanMaskForm, buildBanMask } from "../lib/banMask";

// #386 — pure ban-mask builder. Fail-closed on unknown components (vjt
// decision #1: never guess a wider mask). Host is used VERBATIM — hostname,
// cloak, IPv4 or IPv6 literal alike — no domain/octet wildcarding.
describe("buildBanMask", () => {
  it("nick form → nick!*@* (always buildable, host/user irrelevant)", () => {
    expect(buildBanMask("nick", { nick: "alice", user: null, host: null })).toBe("alice!*@*");
  });

  it("host form → *!*@host when host known", () => {
    expect(buildBanMask("host", { nick: "alice", user: "ident", host: "some.host.net" })).toBe(
      "*!*@some.host.net",
    );
  });

  it("host form → null when host unknown (fail-closed, no guess)", () => {
    expect(buildBanMask("host", { nick: "alice", user: "ident", host: null })).toBeNull();
  });

  it("user_host form → *!user@host when both known", () => {
    expect(buildBanMask("user_host", { nick: "alice", user: "ident", host: "some.host.net" })).toBe(
      "*!ident@some.host.net",
    );
  });

  it("user_host form → null when user unknown (fail-closed)", () => {
    expect(
      buildBanMask("user_host", { nick: "alice", user: null, host: "some.host.net" }),
    ).toBeNull();
  });

  it("user_host form → null when host unknown (fail-closed)", () => {
    expect(buildBanMask("user_host", { nick: "alice", user: "ident", host: null })).toBeNull();
  });

  it("host form masks a cloak/vhost verbatim (no transformation)", () => {
    expect(
      buildBanMask("host", { nick: "alice", user: "ident", host: "Azzurra-1a2b3c.cloak" }),
    ).toBe("*!*@Azzurra-1a2b3c.cloak");
  });

  it("host form masks an IPv4 literal verbatim (no octet wildcard)", () => {
    expect(buildBanMask("host", { nick: "bob", user: "ident", host: "1.2.3.4" })).toBe(
      "*!*@1.2.3.4",
    );
  });

  it("host form masks an IPv6 literal verbatim", () => {
    expect(buildBanMask("host", { nick: "bob", user: "ident", host: "2001:db8::1" })).toBe(
      "*!*@2001:db8::1",
    );
  });

  it("every form is a member of the BanMaskForm union", () => {
    const forms: BanMaskForm[] = ["nick", "host", "user_host"];
    for (const form of forms) {
      // nick-only parts: only "nick" builds; host/user_host fail-closed.
      const mask = buildBanMask(form, { nick: "z", user: null, host: null });
      expect(mask === null || typeof mask === "string").toBe(true);
    }
  });
});
