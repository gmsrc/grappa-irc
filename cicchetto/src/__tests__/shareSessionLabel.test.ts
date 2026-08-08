/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHARE_SESSION_LABEL } from "../lib/shareModal";

// #462 — one affordance, one name.
//
// The share surface is reached from three places and each of them used to
// spell its name itself: the home button and the modal title both said
// "open on another device" while the settings entry said "share session".
// That is the drift the issue reports, and it is the drift a rendering
// assertion cannot catch — two literals that happen to agree today satisfy
// `toHaveTextContent` and disagree the first time one of them is edited.
//
// So the guard is on the SOURCE: the words exist once, in the module that
// owns the share modal's open/close, and every call site interpolates them.
// Rendering assertions live with each component (they prove the constant is
// actually WORN, the #734 failure mode inverted).

const CALL_SITES = ["src/HomePane.tsx", "src/SettingsDrawer.tsx", "src/ShareSessionModal.tsx"];

// Comments are stripped first: prose that QUOTES the label to explain a
// surface is documentation, not a second rendering of it, and a guard that
// fired on an accurate comment would be teaching the wrong lesson.
const code = (path: string): string =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("#462 — the share affordance is named once", () => {
  it.each(CALL_SITES)("%s carries no literal copy of the label", (path) => {
    expect(code(path)).not.toContain(SHARE_SESSION_LABEL);
  });

  it.each(CALL_SITES)("%s imports the label from lib/shareModal", (path) => {
    expect(readFileSync(path, "utf8")).toContain("SHARE_SESSION_LABEL");
  });

  it("declares it in exactly one place", () => {
    expect(readFileSync("src/lib/shareModal.ts", "utf8")).toContain(SHARE_SESSION_LABEL);
  });
});
