import { describe, expect, it } from "vitest";

// #1251 / issue 2116 — display names for the type-A (list) channel modes.
//
// `listModes.ts` holds LABELS ONLY: WHICH letters are queryable is server
// data (`isupport.listModesQueryable`, from the network's 005 filtered
// through `Grappa.Session.ListModes`), so the only thing cic can get wrong
// here is naming a letter — or failing to name one the server now offers.

import { listModeLabel, listModeTitle } from "../lib/listModes";

describe("listModeLabel", () => {
  // The five letters that predate issue 2116, as the positive control: if
  // the label table were empty every one of these would fall through to the
  // `+x` branch below and the R case would prove nothing.
  it("names every list mode the server can offer", () => {
    expect(listModeLabel("b")).toBe("Bans");
    expect(listModeLabel("e")).toBe("Exempts");
    expect(listModeLabel("I")).toBe("Invites");
    expect(listModeLabel("z")).toBe("Restricted");
    expect(listModeLabel("q")).toBe("Quiets");
  });

  // issue 2116 — IRCnet advertises `CHANMODES=beIR`; `R` is the channel
  // reop list (344/345 RPL_REOPLIST). Unlabelled it rendered as `+R`.
  it("names IRCnet's reop list (+R)", () => {
    expect(listModeLabel("R")).toBe("Reops");
  });

  // The negative control, and the reason a cic release is never required
  // for a server that learns a new list mode: an unknown letter still
  // renders, as `+x`.
  it("falls back to +letter for a mode it has no name for", () => {
    expect(listModeLabel("X")).toBe("+X");
  });

  // `I` (invex) and `i` (invite-only, a type-D flag) are different modes —
  // the same case-significance the server's `ListModes.known?/1` pins.
  it("is case-sensitive — i is not I", () => {
    expect(listModeLabel("i")).toBe("+i");
    expect(listModeLabel("r")).toBe("+r");
  });
});

describe("listModeTitle", () => {
  it("is the label plus the channel", () => {
    expect(listModeTitle("R", "#bofh")).toBe("Reops: #bofh");
    expect(listModeTitle("X", "#bofh")).toBe("+X: #bofh");
  });
});
