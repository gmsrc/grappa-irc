import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PULL_COMMIT_PX } from "../lib/pullGesture";
import { REPLY_QUOTE_BODY_LIMIT, REPLY_QUOTE_TAIL } from "../lib/replyQuote";
import { UNREAD_RETENTION_CAP } from "../lib/scrollback";
import { LIST_WINDOW_NAME, SERVER_WINDOW_NAME } from "../lib/windowKinds";

// #1646 — the e2e tree hand-copies production constants, and until this file
// nothing compared a copy with its original.
//
// The copies are deliberate: `e2e/` is its own package (`e2e/package.json`,
// playwright-only) and `fixtures/grappaApi.ts` spells out why the ONE import it
// allows itself is type-only — a value import would reach the solid-js
// dependency graph that keeps the runner image a pure REST/IRC client. The
// mirroring is not the defect. The defect is that "kept in lockstep by hand"
// had no witness: every one of the declarations below could be edited, or its
// original could move, and every gate in the repo stayed green.
//
// So the pin reads the e2e declaration as TEXT and compares it with the
// production constant IMPORTED here. The two sides come from genuinely
// different places — a module import and a file the test never imports — which
// is what makes the comparison able to fail. It fails in both directions:
// change production and the import moves while the text does not; change the
// copy and the text moves while the import does not.
//
// This lives in `src/__tests__/` rather than in `e2e/fixtures/` (which the
// vitest lane also collects) precisely BECAUSE of the rule it is guarding: a
// pin in `e2e/` would have to import src values, which is the edge the e2e
// package refuses. Reading the spec files as text creates no import edge at
// all. Sibling of `biomePin.test.ts` / `moduleRootGuard.test.ts` /
// `versionSource.test.ts` — vitest runs from the cicchetto dir, so both `src`
// and `e2e` are at cwd.
//
// ⚠️ SCOPE, and it is narrow. #1646 measured 13 production constants copied
// into 53 e2e declarations. Pinned here: the 6 whose production side is
// TypeScript and ALREADY exported — 11 declarations. The other 7 are not
// pinnable without a decision that is not this file's to take:
//   - 5 are module-private in production (`SCROLL_BOTTOM_THRESHOLD_PX`,
//     `LOAD_MORE_THRESHOLD_PX`, `PUSH_OPTIN_DECLINED_KEY`, `SHORT_HASH_LEN`,
//     `AWAY_SET_LINE`) — 25 declarations, the two largest clusters among them.
//     Exporting a constant to be testable, or moving it into `lib/`, is a
//     product call.
//   - 2 are Elixir module attributes (`MessagesController.@default_limit` and
//     `@max_http_limit`) — 17 declarations. There is precedent for shipping a
//     server number to the client mechanically (`mix grappa.gen_wire_types`
//     with the drift gate in `scripts/check.sh`), and picking it is likewise a
//     product call.
// Neither is worked around here. A pin over an exported constant is the part
// that needed no permission.
//
// ⚠️ What this CANNOT do: it cannot find a mirror that has ALREADY drifted.
// Every declaration below was found because the two sides carry the same
// literal today. A copy that already disagrees with production is invisible to
// the census that produced this table, and adding it here is the only way it
// enters. `KNOWN_UNPINNED` names the one set where that question is open.

/** A hand-copied e2e declaration and the production constant it mirrors. */
type Mirror = {
  /** e2e file, relative to the cicchetto dir. */
  readonly file: string;
  /** The name the e2e side gives it — often NOT the production spelling. */
  readonly name: string;
  /** The production value, imported. Derived values arrive already computed. */
  readonly production: string | number;
  /** Where production defines it, for the failure message. */
  readonly origin: string;
};

const MIRRORS: readonly Mirror[] = [
  // `$list` — the channel-directory pseudo-window (#84).
  ...[
    "e2e/tests/channel-directory.spec.ts",
    "e2e/tests/issue1445-directory-pull-refresh.spec.ts",
    "e2e/tests/issue220-link-double-fire.spec.ts",
    "e2e/tests/issue244-directory-tap-foreground.spec.ts",
    "e2e/tests/issue677-directory-pagination.spec.ts",
  ].map(
    (file): Mirror => ({
      file,
      name: "LIST_WINDOW_NAME",
      production: LIST_WINDOW_NAME,
      origin: "LIST_WINDOW_NAME (src/lib/windowKinds.ts)",
    }),
  ),

  // `$server` — the synthetic per-network server window. Two spellings on the
  // e2e side for one production constant, which is itself part of why the
  // lockstep needs a machine: a grep for the production NAME finds neither.
  {
    file: "e2e/tests/issue276-away-emoji-badge.spec.ts",
    name: "SERVER_WINDOW",
    production: SERVER_WINDOW_NAME,
    origin: "SERVER_WINDOW_NAME (src/lib/windowKinds.ts)",
  },
  {
    file: "e2e/tests/m12-motd-server-window-routes-notice.spec.ts",
    name: "SERVER_CHANNEL",
    production: SERVER_WINDOW_NAME,
    origin: "SERVER_WINDOW_NAME (src/lib/windowKinds.ts)",
  },

  {
    file: "e2e/tests/issue1105-reply-quote-caret-visible.spec.ts",
    name: "REPLY_QUOTE_TAIL",
    production: REPLY_QUOTE_TAIL,
    origin: "REPLY_QUOTE_TAIL (src/lib/replyQuote.ts)",
  },
  {
    file: "e2e/tests/issue1105-reply-quote-caret-visible.spec.ts",
    name: "QUOTED_BODY_LIMIT",
    production: REPLY_QUOTE_BODY_LIMIT,
    origin: "REPLY_QUOTE_BODY_LIMIT (src/lib/replyQuote.ts)",
  },

  // The two DERIVED ones, and the reason a value pin beats a name pin. Neither
  // production side is a literal — `UNREAD_RETENTION_CAP = PAGE_LIMIT` and
  // `PULL_COMMIT_PX = SWIPE_MIN_PX * 2` — so the number the e2e copy froze can
  // be moved from a module the copy does not even name. Importing the constant
  // pins the computed value, which is the one the product uses.
  {
    file: "e2e/tests/issue1229-unread-retention-bound.spec.ts",
    name: "UNREAD_BOUND",
    production: UNREAD_RETENTION_CAP,
    origin: "UNREAD_RETENTION_CAP = PAGE_LIMIT (src/lib/scrollback.ts)",
  },
  {
    file: "e2e/tests/issue1445-directory-pull-refresh.spec.ts",
    name: "PULL_COMMIT_PX",
    production: PULL_COMMIT_PX,
    origin: "PULL_COMMIT_PX = SWIPE_MIN_PX * 2 (src/lib/pullGesture.ts)",
  },
];

// Declarations that carry a PINNED NAME but no pin, each with the reason.
//
// `SERVER_WINDOW = "Server"` — six specs use the literal `"Server"` as a
// window/channel name under the same identifier two specs give `"$server"`.
// #1646 could not establish whether those six mirror a live production string,
// a retired one, or nothing at all: the src side records the `"Server"` LABEL
// as gone (`BottomBar.tsx`, `__tests__/Sidebar.test.tsx`) while
// `__tests__/subscribe.test.ts` still passes it as a `channelName`. Pinning
// them to `SERVER_WINDOW_NAME` would assert a fact nobody has measured, and
// deleting them from the sweep silently would hide the question. They are
// listed, so a SEVENTH one cannot appear without someone reading this.
const KNOWN_UNPINNED: readonly { readonly file: string; readonly name: string }[] = [
  { file: "e2e/tests/issue239-hidden-msg-unread.spec.ts", name: "SERVER_WINDOW" },
  { file: "e2e/tests/issue267-mention-server-authoritative.spec.ts", name: "SERVER_WINDOW" },
  { file: "e2e/tests/issue498-badge-follows-live-nick.spec.ts", name: "SERVER_WINDOW" },
  { file: "e2e/tests/issue973-query-unread-badge-clears.spec.ts", name: "SERVER_WINDOW" },
  { file: "e2e/tests/issue981-no-badge-at-tail.spec.ts", name: "SERVER_WINDOW" },
  { file: "e2e/tests/m2-irssi-to-chan-defocused.spec.ts", name: "SERVER_WINDOW" },
];

/** A single-line `const`/`let NAME = <literal>` declaration, as written. */
type Declaration = { readonly line: number; readonly literal: string };

// Prose carries the history, and several comments quote the very declarations
// this file reads. Same guard as `moduleRootGuard.test.ts`.
const isProse = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
};

/**
 * Every single-line declaration of `name` in `src`, literal text unparsed.
 *
 * @spec declarationsOf(string, string) :: Declaration[] — empty when absent,
 * which every caller treats as a failure rather than a pass.
 */
function declarationsOf(src: string, name: string): Declaration[] {
  const pattern = new RegExp(`^\\s*(?:const|let)\\s+${name}\\s*(?::[^=]+)?=\\s*(.+?);?\\s*$`);
  const found: Declaration[] = [];
  src.split("\n").forEach((line, i) => {
    if (isProse(line)) return;
    const m = pattern.exec(line);
    if (m?.[1] !== undefined) found.push({ line: i + 1, literal: m[1] });
  });
  return found;
}

/**
 * The value of a mirror's literal.
 *
 * @spec parseLiteral(string) :: string | number | null — null for anything
 * that is not a plain double-quoted string or a plain number. A mirror written
 * as a template literal, an expression or a concatenation is NOT silently
 * accepted: the caller fails and names the line, because a pin that shrugs at
 * a shape it cannot read is a pin that stops covering a declaration the day
 * someone reformats it.
 */
function parseLiteral(literal: string): string | number | null {
  if (/^"(?:[^"\\]|\\.)*"$/.test(literal)) return JSON.parse(literal) as string;
  if (/^-?\d+(?:\.\d+)?$/.test(literal)) return Number(literal);
  return null;
}

function e2eSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    // `e2e/node_modules` is the runner's own install; `test-results` and
    // `playwright-report` are run output. None of them is a hand-written
    // mirror, and walking them costs seconds.
    if (entry === "node_modules" || entry === "test-results" || entry === "playwright-report") {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...e2eSourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("the extractor (#1646 — the predicate)", () => {
  // A guard that only ever runs over a tree it already agrees with proves
  // nothing about what it would catch, so the predicate is pinned on its own.
  it("reads a plain declaration", () => {
    expect(declarationsOf(`const FOO = "$list";`, "FOO")).toEqual([
      { line: 1, literal: `"$list"` },
    ]);
  });

  it("reads a typed declaration and a `let`", () => {
    expect(declarationsOf(`const FOO: string = "x";`, "FOO")).toEqual([
      { line: 1, literal: `"x"` },
    ]);
    expect(declarationsOf(`let FOO = 50;`, "FOO")).toEqual([{ line: 1, literal: "50" }]);
  });

  it("does not read a comment that quotes the declaration", () => {
    expect(declarationsOf(`// const FOO = "$list";`, "FOO")).toEqual([]);
  });

  it("does not read a DIFFERENT name that ends with the one asked for", () => {
    expect(declarationsOf(`const NOT_FOO = 1;`, "FOO")).toEqual([]);
  });

  it("finds every occurrence, with its line", () => {
    expect(declarationsOf(`const FOO = 1;\nconst BAR = 2;\nconst FOO = 3;`, "FOO")).toEqual([
      { line: 1, literal: "1" },
      { line: 3, literal: "3" },
    ]);
  });

  it("parses the two shapes a mirror may take, and refuses the rest", () => {
    expect(parseLiteral(`" << "`)).toBe(" << ");
    expect(parseLiteral("200")).toBe(200);
    expect(parseLiteral("-1")).toBe(-1);
    expect(parseLiteral("`$list`")).toBeNull();
    expect(parseLiteral(`"$" + "list"`)).toBeNull();
    expect(parseLiteral("SWIPE_MIN_PX * 2")).toBeNull();
  });
});

describe("e2e mirrors of production constants (#1646)", () => {
  for (const mirror of MIRRORS) {
    it(`${mirror.file} — ${mirror.name} still equals ${mirror.origin}`, () => {
      const declarations = declarationsOf(readFileSync(mirror.file, "utf8"), mirror.name);

      // Zero is the failure this assertion exists for as much as a wrong value
      // is: a renamed or deleted mirror must not make the pin pass by having
      // nothing left to compare. More than one means the table stopped
      // describing the file.
      expect(declarations, `no \`${mirror.name}\` declaration in ${mirror.file}`).toHaveLength(1);

      const declaration = declarations[0] as Declaration;
      const value = parseLiteral(declaration.literal);
      expect(
        value,
        `${mirror.file}:${declaration.line} — \`${declaration.literal}\` is not a plain literal, so this pin no longer reads it`,
      ).not.toBeNull();
      expect(
        value,
        `${mirror.file}:${declaration.line} — the copy of ${mirror.origin} has drifted`,
      ).toBe(mirror.production);
    });
  }

  it("has no mirror outside the table", () => {
    const pinned = new Set(MIRRORS.map((m) => `${m.file} ${m.name}`));
    for (const known of KNOWN_UNPINNED) pinned.add(`${known.file} ${known.name}`);
    const names = [...new Set(MIRRORS.map((m) => m.name))];

    const unlisted: string[] = [];
    for (const file of e2eSourceFiles("e2e")) {
      const src = readFileSync(file, "utf8");
      for (const name of names) {
        if (declarationsOf(src, name).length === 0) continue;
        if (!pinned.has(`${file} ${name}`)) unlisted.push(`${file} — ${name}`);
      }
    }

    // A new copy of an already-copied constant is the cheapest way back to the
    // state #1646 measured, and it is the one case a table-driven pin can see
    // coming. Landing one means adding it to MIRRORS (or, if its value is a
    // question rather than a copy, to KNOWN_UNPINNED with the reason).
    expect(unlisted).toEqual([]);
  });
});
