import { describe, expect, it } from "vitest";
import { registerableFlavor, templateForFlavor } from "../lib/registrationTemplates";

// #349 — the per-flavor NickServ verb table is a SECURITY-SENSITIVE
// single source of truth (a wrong arg order / arg count sends the wrong
// command with the user's password). These tests pin the source-verified
// Azzurra verbs and the button gate:
//   * REGISTER: password FIRST, email second.
//   * azzurra confirm: SINGLE-arg `AUTH <code>` (nick NOT in the verb).
//   * registerableFlavor gates the wizard button — true ONLY for
//     "azzurra" in #349 (atheme/oftc lack an observable +r success
//     signal — see registrationTemplates.ts "Why Azzurra ONLY");
//     "unknown"/"atheme"/"oftc"/null all hide the button.

describe("registrationTemplates — azzurra REGISTER (password FIRST, email second)", () => {
  it("builds `REGISTER <password> <email>` (password before email)", () => {
    const t = templateForFlavor("azzurra");
    expect(t?.buildRegister("hunter2", "me@example.com")).toBe("REGISTER hunter2 me@example.com");
  });

  it("keeps the password in the FIRST arg slot (ordering is load-bearing)", () => {
    // A regression that flipped to `REGISTER <email> <password>` would
    // leak the email as the password and vice-versa. Assert the position
    // explicitly, not just the whole string.
    const parts = templateForFlavor("azzurra")?.buildRegister("PW", "E@E.COM").split(" ");
    expect(parts?.[0]).toBe("REGISTER");
    expect(parts?.[1]).toBe("PW");
    expect(parts?.[2]).toBe("E@E.COM");
  });
});

describe("registrationTemplates — azzurra confirmation/verify verb", () => {
  it("is a SINGLE-arg `AUTH <code>` — the nick is NOT in the verb", () => {
    // The #349 trap: azzurra's AUTH takes ONLY the emailed code. buildVerify
    // still takes (nick, code) for a uniform signature (the future atheme
    // entry needs the nick), but azzurra must DROP the nick.
    expect(templateForFlavor("azzurra")?.buildVerify("alice", "1070187402")).toBe(
      "AUTH 1070187402",
    );
  });

  it("messages NickServ", () => {
    expect(templateForFlavor("azzurra")?.servicesNick).toBe("NickServ");
  });
});

describe("registrationTemplates — registerableFlavor gating", () => {
  it("is true ONLY for azzurra (the sole +r-observable flavor in #349)", () => {
    expect(registerableFlavor("azzurra")).toBe(true);
  });

  it("is false for atheme + oftc — no observable +r success signal yet (follow-up)", () => {
    // Both are declared enum values server-side, but the wizard hides the
    // button until the flavor-agnostic identity signal lands: atheme
    // (solanum) has no registered umode; oftc uses uppercase +R.
    expect(registerableFlavor("atheme")).toBe(false);
    expect(registerableFlavor("oftc")).toBe(false);
  });

  it("is false for `unknown` (no template to register against)", () => {
    expect(registerableFlavor("unknown")).toBe(false);
  });

  it("is false for `null` (unset / legacy credential)", () => {
    expect(registerableFlavor(null)).toBe(false);
  });
});

describe("registrationTemplates — templateForFlavor", () => {
  it("returns a template for azzurra", () => {
    expect(templateForFlavor("azzurra")).not.toBeNull();
  });

  it("returns null for atheme, oftc, unknown, and null", () => {
    expect(templateForFlavor("atheme")).toBeNull();
    expect(templateForFlavor("oftc")).toBeNull();
    expect(templateForFlavor("unknown")).toBeNull();
    expect(templateForFlavor(null)).toBeNull();
  });
});
