// #1223 — what an admin row card does on a phone, once #1157 turned rows
// into cards.
//
// vjt, dogfooding staging on an iPhone: *"abbiamo tap target solo sul testo
// quando invece dovrebbe esser tutta l'area, parlo ad es dei nomi visitor"*
// and *"poi abbiamo quest'idiozia di mostrare colonne già mostrate"*.
// Separate defects behind those readings, all of them layout, all therefore
// invisible to jsdom (`feedback_cicchetto_browser_smoke`) and to every
// vitest suite that mounts these components:
//
//   2. `.adm-row-expand` puts the 44px `--tap-min` floor on HEIGHT only and
//      sizes its box with `inline-flex`, so the door to the row's detail is
//      the caret + badge + nick run and the rest of the card's heading is
//      dead space that looks tappable. Asserted by TAPPING that dead space
//      and requiring the panel to open — the visible outcome, not the
//      declarations that produce it.
//
//   3. `.adm-facts` sizes its label track from the LONGEST label, so on a
//      393px screen the value track keeps well under half the width and
//      wraps timestamps over several lines. Asserted as the value track
//      taking the panel's full width, with the label above it.
//
//   1. the detail panel repeats fields the card already shows. vjt ruled the
//      fork on 2026-08-11 — *"1223 punto 1: direi drop no?"* — so the columns
//      really leave the card and the panel stays the only place they live.
//
//      Two defects share that symptom, and only ONE of them is in this file.
//      The `.adm-col-detail` specificity failure (Users, Credentials) is a
//      question about what is PAINTED, invisible to jsdom, so it is asserted
//      here. The Sessions repeat is JSX — `detailFacts` carried a `network`
//      fact while the identity cell printed the slug at every width, desktop
//      included — which vitest sees perfectly well and
//      `AdminSessionsTab.test.tsx` pins. Bringing it here too would buy a
//      slower copy of a test that already exists.
//
//      Also asserted here: the 769-899 BAND. The console's card regime starts
//      at 900px and `isMobile()` is 768px, so a fix that only raised the CSS
//      selector would have made that band strictly worse — columns gone,
//      `AdminRowName` still a plain span, no door to the panel they went
//      into. That is a real-browser claim as much as the drop is.
//
// The desktop test is the counter-claim, and it is why item 3's fix is a
// `@container` rule rather than a blanket single column: at a width where two
// columns fit, two columns are what the operator gets. Without it, collapsing
// unconditionally would pass.
//
// Sessions is the tab under test because its disclosure is `alwaysOpenable`
// (#1157), so the SAME control can be measured at both widths. The button is
// `AdminRowName`, which every tab routes identity through.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated, the EXEMPT shape.

import type { Locator, Page } from "@playwright/test";
import { adminLogin, adminSessionRowKey, openAdminConsole } from "../fixtures/cicchettoPage";
import { mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// admin-vjt has no network bind, so `loginAs`'s network-section shell-ready
// selector would time out. Same shape as #1073 / m7-admin-gate / m11-events.
async function openSessionsTab(page: Page): Promise<void> {
  await openAdminConsole(page);
  await page.getByTestId("admin-tab-sessions").click();
  await expect(page.getByTestId("admin-sessions-table")).toBeVisible({ timeout: 10_000 });
}

async function openUsersTab(page: Page): Promise<void> {
  await openAdminConsole(page);
  await page.getByTestId("admin-tab-users").click();
  await expect(page.getByTestId("admin-users-table")).toBeVisible({ timeout: 10_000 });
}

// The card's cells that are actually PAINTED. `getClientRects()` rather than
// a computed-style read: a `display: none` cell has no boxes, which is the
// property under test, and it costs nothing on WebKit (where reading computed
// style has bitten this suite before).
async function paintedCellTexts(row: Locator): Promise<string[]> {
  return row.locator("td").evaluateAll((tds) =>
    tds
      .filter((td) => td.getClientRects().length > 0)
      .map((td) => (td.textContent ?? "").trim())
      .filter((text) => text !== ""),
  );
}

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator, what: string): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null)
    throw new Error(`${what} has no layout box — the markup or the classes drifted`);
  return box;
}

// 🔴 NO `@touch`, and UNLIKE its three siblings in this file — this is the one
// entry issue 1878 could not port and could not explain. MEASURED on
// `chromium-pixel-touch`: `touchscreen.tap(383, 413.66)` on the 412x839
// viewport, aimed at the heading's dead space exactly as below, comes back
// with the `confirmDetach` modal ("Switch account") open and NO
// `admin-session-detail-*` in the DOM at all. Green on `webkit-iphone-15`,
// where the same coordinates open the row.
//
// The mechanism is NOT established and is deliberately not guessed at here.
// It has the SHAPE of the #1831 class — chromium's tap synthesises the compat
// mouse events and hit-tests the click against the layout as it stands at
// RELEASE, which webkit never produces at all — but that was not measured for
// this spec. If it is that, the red is a product defect on Android and not a
// harness one, so the tag is withheld rather than the spec weakened.
test("#1223 @webkit on a phone the whole card heading opens the row, not just the nick", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const visitor = await mintVisitor(`tap1223-${Date.now()}`);

  try {
    await adminLogin(page, getSeededAdmin());
    await openSessionsTab(page);

    const key = await adminSessionRowKey(page, "visitor", visitor.id);
    const row = page.getByTestId(`admin-session-row-${key}`);
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible();

    // Pre-state, asserted rather than assumed: the panel is CLOSED, so the
    // tap below is what opens it and not a coincidence of a panel already on
    // screen from a previous step.
    const panel = page.getByTestId(`admin-session-detail-${key}`);
    await expect(panel).toHaveCount(0);

    const heading = row.locator("td.adm-cell-title");
    const glyphs = row.locator(".admin-session-lines");
    const headingBox = await boxOf(heading, "the card heading cell");
    const glyphBox = await boxOf(glyphs, "the identity's glyph run");

    // The probe point: the heading's right end, past everything that is
    // drawn. If the glyph run happens to fill the heading there is no dead
    // space to aim at and the tap would prove nothing — fail loudly rather
    // than pass vacuously.
    const tapX = headingBox.x + headingBox.width - 6;
    const tapY = headingBox.y + headingBox.height / 2;
    const deadSpace = tapX - (glyphBox.x + glyphBox.width);
    expect(
      deadSpace,
      "the probe must land beyond the drawn identity — otherwise it is not testing the dead space",
    ).toBeGreaterThan(8);

    await page.touchscreen.tap(tapX, tapY);

    await expect(
      panel,
      "tapping the card heading beside the nick must open the row's detail",
    ).toBeVisible({ timeout: 5_000 });
  } finally {
    await reapVisitors(admin.token, visitor.id);
  }
});

// 🔴 `on a phone a detail fact gives its value the panel's full width`
// LIVED HERE and is now the long branch of `#1244 a panel fact is one row
// while its value is short` (`issue1244-admin-density.spec.ts`).
//
// It asserted TWO things of the FIRST fact: that its value sits under its
// label, and that the value's box is at least 85% of the TABLE's width —
// the reference box being the table rather than the facts list is the
// correction this file made and it is carried over verbatim.
//
// What did not survive is "the first fact", and the reason is a ruling
// rather than a convenience. vjt, on #1244 (2026-08-12): *"'the four
// asserts from #1223 stay green' was shorthand for do not regress the
// horizontal budget, not keep those literal thresholds"*, and *"do not
// keep the label above the value as the default — that is exactly the
// vertical waste this issue is about"*. The panel's first fact is
// `connection`, whose value is `connected`: nine characters that now
// print on their label's line, so an assertion pinned to `.first()`
// demands the stacking the next issue removed.
//
// The successor keeps the claim and drops the pin — every fact that DOES
// take its own line must take 85% of the table with it, and at least one
// must, or the long branch goes unmeasured. Moved rather than weakened:
// squeeze the panel and `last event` fails there exactly as it would have
// failed here.

test("#1223 on a wide panel the facts stay two columns", async ({ page }) => {
  const admin = getSeededAdmin();
  const visitor = await mintVisitor(`wide1223-${Date.now()}`);

  try {
    await adminLogin(page, getSeededAdmin());
    await openSessionsTab(page);

    const key = await adminSessionRowKey(page, "visitor", visitor.id);
    await page.getByTestId(`admin-session-details-${key}`).click();
    const panel = page.getByTestId(`admin-session-detail-${key}`);
    await expect(panel).toBeVisible({ timeout: 5_000 });

    const facts = panel.locator(".adm-facts");
    const dtBox = await boxOf(facts.locator("dt").first(), "the first fact's label");
    const ddBox = await boxOf(facts.locator("dd").first(), "the first fact's value");

    // Beside, not under: the phone fix is a container query, so a panel with
    // room keeps the label column that makes a list of facts scannable.
    expect(
      ddBox.x,
      "with room for two columns the value must sit beside its label",
    ).toBeGreaterThanOrEqual(dtBox.x + dtBox.width);
  } finally {
    await reapVisitors(admin.token, visitor.id);
  }
});

// Item 1, the half only a browser can see. The panel's subtitle promises
// "the columns the table drops on a phone", and until #1223 it was the one
// thing on screen that was false: `.adm-col-detail { display: none }` is
// (0,1,0) and lost to the `.adm-table td` stacking rule (0,1,1), so every
// dropped column came back as a labelled line of the card and the panel
// underneath said it a second time.
//
// The oracle is the report itself — no value may be on the card AND in the
// panel — rather than a check that a particular selector is hidden: that is
// the property vjt read off the screen, and it survives the next tab growing
// a column.
test("#1223 @webkit @touch on a phone no field is on the card and in the panel at once", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const adminId = (JSON.parse(admin.subjectJson) as { id: string }).id;

  await adminLogin(page, getSeededAdmin());
  await openUsersTab(page);

  const row = page.getByTestId(`admin-user-row-${adminId}`);
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();

  const panel = page.getByTestId(`admin-user-detail-${adminId}`);
  await expect(panel).toHaveCount(0);
  await page.getByTestId(`admin-user-details-${adminId}`).tap();
  await expect(panel).toBeVisible({ timeout: 5_000 });

  const cardValues = await paintedCellTexts(row);
  const factValues = (await panel.locator("dd").allTextContents())
    .map((t) => t.trim())
    .filter((t) => t !== "");

  // Non-vacuity, both sides: an empty card or an empty panel would make the
  // intersection trivially empty and the test a mirror.
  expect(cardValues.length, "the row card must still show something").toBeGreaterThan(0);
  expect(factValues.length, "the panel must carry the dropped columns").toBeGreaterThan(0);

  expect(
    factValues.filter((value) => cardValues.includes(value)),
    `values printed twice — card ${JSON.stringify(cardValues)}, panel ${JSON.stringify(factValues)}`,
  ).toEqual([]);
});

// #1223 RETEST (vjt, v0.16.0-8412fb40, portrait phone). The card/detail
// split landed and the horizontal budget did not: *"the layout still spends
// width on gutters and label columns rather than on the values."*
//
// Symptom 1, as the two numbers that name it. The panel's host row was
// being charged the card regime three times — an empty `td::before` label
// track (80px + a 12px gap, `attr(data-label)` on a cell that has no
// `data-label`), `.adm-table tr`'s own border and padding (18px), and a
// `.adm-expand-row td` padding (32px) whose mobile override was dead on
// specificity. That is the "inset container with a wide empty gutter on
// both sides", measured rather than described.
//
// Asserted as GUTTERS rather than as a width ratio on purpose: a ratio
// answers "is it big enough", which invites a threshold argument, while vjt
// reported empty space at the edges and the honest claim is that there is
// none of it.
test("#1223 @webkit @touch on a phone the detail panel spans its table, with no gutters", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const visitor = await mintVisitor(`gutter1223-${Date.now()}`);

  try {
    await adminLogin(page, getSeededAdmin());
    await openSessionsTab(page);

    const key = await adminSessionRowKey(page, "visitor", visitor.id);
    await page.getByTestId(`admin-session-details-${key}`).tap();
    const panel = page.getByTestId(`admin-session-detail-${key}`);
    await expect(panel).toBeVisible({ timeout: 5_000 });

    const tableBox = await boxOf(page.getByTestId("admin-sessions-table"), "the sessions table");
    const panelBox = await boxOf(panel, "the detail panel");

    // Non-vacuity: a table collapsed to nothing would make both gutters
    // zero and the assertion a mirror.
    expect(tableBox.width, "the table must have a width to fill").toBeGreaterThan(200);

    // `top` is measured against the panel's own CELL, not the table: the
    // row above is a legitimate thing to sit below, an empty strip inside
    // the cell is not. It is here because a mutation run found the rule
    // that suppresses that strip — `.adm-expand-row td::before { content:
    // none }` — killed no assertion at all. The cell's `::before` still
    // resolves `attr(data-label)` to the empty string on a cell that has
    // no such attribute, and an empty inline box is still a box. Without
    // this number the rule was unfalsifiable, which is the same defect as
    // an exemption: code no guard can convict.
    const cellBox = await boxOf(
      panel.locator("xpath=ancestor::td[1]"),
      "the cell hosting the detail panel",
    );

    expect(
      {
        left: Math.round(panelBox.x - tableBox.x),
        right: Math.round(tableBox.x + tableBox.width - (panelBox.x + panelBox.width)),
        top: Math.round(panelBox.y - cellBox.y),
      },
      "the detail panel must fill the cell it is given, on all three sides",
    ).toEqual({ left: 0, right: 0, top: 0 });
  } finally {
    await reapVisitors(admin.token, visitor.id);
  }
});

// Symptom 2. vjt: *"a long value such as the `last event` timestamp wraps
// mid-token instead of using the space the gutters are holding."*
//
// The oracle is the TOKEN, not the line count. A line count would encode a
// font metric and fail on the day someone changes the mono stack; and
// `last event` reads `<event> · <instant>`, so a break at the separator is
// legitimate and only a break INSIDE a run is the defect. Generalised over
// every value in the panel rather than the one vjt happened to name — the
// rule is that no value is broken mid-token, and the timestamp is one
// instance of it.
//
// `Range.getClientRects()` returns one rect per line box the range covers,
// so a token on two lines reports two distinct `top`s. Pseudo-elements are
// not in the DOM and cannot be ranged, which is exactly right here: the
// label track is not part of the value.
test("#1223 @webkit @touch on a phone no panel value is broken mid-token", async ({ page }) => {
  const admin = getSeededAdmin();
  const visitor = await mintVisitor(`token1223-${Date.now()}`);

  try {
    await adminLogin(page, getSeededAdmin());
    await openSessionsTab(page);

    const key = await adminSessionRowKey(page, "visitor", visitor.id);
    await page.getByTestId(`admin-session-details-${key}`).tap();
    const panel = page.getByTestId(`admin-session-detail-${key}`);
    await expect(panel).toBeVisible({ timeout: 5_000 });

    const measured = await panel.locator(".adm-facts").evaluate((facts) => {
      const out: { token: string; lines: number }[] = [];
      for (const dd of facts.querySelectorAll("dd")) {
        for (const node of dd.childNodes) {
          if (node.nodeType !== Node.TEXT_NODE) continue;
          const text = node.textContent ?? "";
          // Whitespace-delimited runs: every one of them is a place the
          // renderer is entitled to break BETWEEN and not WITHIN.
          for (const m of text.matchAll(/\S+/g)) {
            const start = m.index;
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + m[0].length);
            const tops = new Set(
              [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
            );
            out.push({ token: m[0], lines: tops.size });
          }
        }
      }
      return out;
    });

    // Non-vacuity, and the reason it is worth stating: if the seeded row
    // renders only short words, nothing here CAN wrap and a green proves
    // nothing. 16 characters is past what a broken panel could hold.
    const longest = measured.reduce((best, t) => (t.token.length > best.token.length ? t : best), {
      token: "",
      lines: 0,
    });
    expect(
      longest.token.length,
      `no value long enough to test wrapping — measured ${JSON.stringify(measured.map((t) => t.token))}`,
    ).toBeGreaterThanOrEqual(16);

    expect(
      measured.filter((t) => t.lines > 1),
      "a value may wrap between its tokens, never inside one",
    ).toEqual([]);
  } finally {
    await reapVisitors(admin.token, visitor.id);
  }
});

// 🔴 Symptom 3's assertion — `on a phone a card value starts at the card's
// edge, not past a label track` — LIVED HERE and is now the long branch of
// `#1244 a card field is one row while its value is short`
// (`issue1244-admin-density.spec.ts`).
//
// vjt: *"the label column (last seen, channels, actions) keeps a fixed
// wide gutter of its own, pushing the values into the right half"*. The
// fix was `flex: 0 0 100%` on `.adm-table td::before` — a caption above
// its value — and the oracle was `indent <= 2` on every labelled cell,
// measured by a range over the cell's contents (which excludes the
// `::before` label by construction, the technique the successor keeps).
//
// `indent <= 2` on EVERY cell says the value always begins at the card's
// left edge, which is only true of the stacked layout, which is what
// #1244 reverses: the same three cells vjt named here are the three he
// counted as six rows there. Ruled on 2026-08-12, on #1244.
//
// The successor asserts the same defect and one more. A value on its own
// line still has to start at the card's edge — that is this assertion,
// unchanged, applied to the branch where it is the right question. A
// value beside its label has to end at the card's RIGHT edge, which the
// fixed 5rem track never did: it left every short value stranded in the
// middle with slack on both sides.
//
// One thing it deliberately does NOT convict, so nobody reads more into
// it than it says: a fixed label track that is WIDER than its text is now
// invisible to it. With the value right-aligned, the label's box no
// longer decides where the value starts, so `flex: 0 0 5rem` would cost
// nothing until a label outgrew it. The defect was never the track's
// existence — it was the value being pushed by it, and that is the thing
// under guard.

// The band the console's two breakpoints leave between them. 820px is a
// portrait iPad: the CSS has already turned the table into cards and taken
// the secondary columns away, and `isMobile()` — 768px — says desktop.
test.describe("#1223 the 769-899 band", () => {
  test.use({ viewport: { width: 820, height: 1180 } });

  test("#1223 the columns leave and the door to their panel is there", async ({ page }) => {
    const admin = getSeededAdmin();
    const adminId = (JSON.parse(admin.subjectJson) as { id: string }).id;

    await adminLogin(page, getSeededAdmin());
    await openUsersTab(page);

    const row = page.getByTestId(`admin-user-row-${adminId}`);
    await expect(row).toBeVisible();

    // Gone from the card: this is the width at which the drop applies.
    const dropped = row.locator("td.adm-col-detail");
    expect(await dropped.count(), "the secondary cells must still be in the DOM").toBeGreaterThan(
      0,
    );
    for (let i = 0; i < (await dropped.count()); i++) {
      await expect(dropped.nth(i)).toBeHidden();
    }

    // And reachable: the disclosure has to exist wherever the columns leave,
    // or this band is where the record becomes unreadable.
    await page.getByTestId(`admin-user-details-${adminId}`).click();
    const panel = page.getByTestId(`admin-user-detail-${adminId}`);
    await expect(panel).toBeVisible({ timeout: 5_000 });
    await expect(panel).toContainText("live sessions");
    await expect(panel).toContainText("inserted");
  });
});
