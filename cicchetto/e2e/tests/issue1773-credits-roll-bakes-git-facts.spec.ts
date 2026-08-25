// #1773 — the credit roll paints the git facts the WRAPPER derived, not a
// plausible shape.
//
// THIS IS THE ONLY GATE THAT CAN SEE THE BAKE. The three facts (commit sha,
// its date, the contributor counts) are derived outside the build container by
// `infra/packaging/credits.sh` and carried in as vite's
// `__GRAPPA_CREDITS_JSON__` define. `vitest.config.ts` is a SEPARATE config
// with no `define`, so every unit test in the repo — buildCredits.test.ts
// included — exercises the DEGRADED path by construction. If the define, the
// env plumbing or the wrapper broke, the whole unit suite would stay green and
// the modal would roll an empty list in production.
//
// So the oracle here is not a shape. `scripts/integration.sh` derives the
// payload and exports it; `e2e/compose.yaml` hands the SAME string to
// `cicchetto-build-test` (which bakes it) and to `playwright-runner` (which is
// this process). Comparing what the modal PAINTS against `GRAPPA_CREDITS`
// compares the two ends of the channel. A shape assertion — "there is a sha",
// "the list is an array" — cannot tell a correct roll from an EMPTY one, and
// an empty roll is the exact defect the channel exists to prevent.
//
// The payload is read with a bare `JSON.parse`, NOT with `coerceBuildCredits`:
// `e2e/` is its own package and allows only TYPE imports from `src/` (see
// `fixtures/grappaApi.ts`, and `src/__tests__/e2eConstantMirrors.test.ts` for
// the discipline). That is a feature of the oracle rather than a compromise —
// parsing the payload independently is what lets this spec disagree with the
// production coercer instead of inheriting its bugs.
//
// SCOPE. chromium only, and deliberately: the defect's platform is the BUILD
// CHANNEL, which is engine-independent. What is NOT proven here is anything
// about the surface on a device — the notch clearance is source-level asserted
// in `src/__tests__/safeAreaInsetToken.test.ts`, the reduced-motion arm is a
// media query no engine here has the preference set for, and the soundtrack is
// not observable from Playwright at all.
//
// Parity matrix: the roll is subject-shape-agnostic (it names the BUILD, not
// the reader) — registered vjt suffices.

import { loginAs, openSettingsDrawer } from "../fixtures/cicchettoPage";
import { expect, specUser, test } from "../fixtures/test";

type BakedContributor = { readonly name: string; readonly commits: number };
type BakedCredits = {
  readonly sha: string | null;
  readonly date: string | null;
  readonly contributors: readonly BakedContributor[];
};

/**
 * The payload the wrapper derived, or a thrown explanation.
 *
 * Both refusals below are ANTI-HOLLOW-GREEN guards, and each names a different
 * broken thing:
 *
 *  - UNSET means the compose plumbing did not reach this container. Defaulting
 *    to `{}` here would turn the spec into a shape check silently, which is the
 *    failure mode the whole file exists to avoid.
 *  - DEGRADED (`sha: null`) is a legitimate payload in production — the AUR
 *    tarball and the release image both build with no `.git` — but it is NOT
 *    legitimate HERE: `scripts/integration.sh` runs inside the repository, so a
 *    null sha means the deriver failed rather than that the build has no
 *    history. Accepting it would let this spec pass against a wrapper that
 *    silently stopped deriving anything.
 */
function bakedCredits(): BakedCredits {
  const raw = process.env.GRAPPA_CREDITS;
  if (raw === undefined || raw === "") {
    throw new Error(
      "GRAPPA_CREDITS is unset in the playwright-runner. The spec cannot " +
        "compare the roll against the payload it was built from. Check the " +
        "export in scripts/integration.sh and the service env in e2e/compose.yaml.",
    );
  }

  const parsed = JSON.parse(raw) as BakedCredits;
  if (parsed.sha === null || parsed.contributors.length === 0) {
    throw new Error(
      `GRAPPA_CREDITS is the DEGRADED payload (${raw.slice(0, 120)}). ` +
        "integration.sh runs inside the repository, so the deriver should have " +
        "found git. A degraded payload here would make every assertion below " +
        "vacuous.",
    );
  }
  return parsed;
}

test("#1773 — the credits roll paints the sha, date and contributors the build baked in", async ({
  page,
}) => {
  const baked = bakedCredits();

  const vjt = specUser();
  await loginAs(page, vjt);
  await openSettingsDrawer(page);

  await page.getByTestId("credits-entry").click();
  const modal = page.getByTestId("credits-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });

  // Read text, never geometry: the roll is a CSS animation, so every box in it
  // is moving. Text content is animation-independent and therefore not a
  // flake source.
  await expect(page.getByTestId("credits-title")).toHaveText("GRAPPA IRC");

  // ── the sha, exactly as derived ─────────────────────────────────────────
  await expect(page.getByTestId("credits-sha")).toHaveText(baked.sha ?? "");

  // ── the date, as the calendar day of the derived instant ────────────────
  // `split("T")[0]` reads the ISO-8601 format itself rather than copying
  // `creditsDateLabel`'s slice length: same answer, no mirrored constant.
  if (baked.date !== null) {
    await expect(page.getByTestId("credits-date")).toHaveText(baked.date.split("T")[0] ?? "");
  }

  // ── the version comes from the #292 meta, and agrees with the bundle ─────
  // Not from the credits payload, on purpose (a second carrier is the drift
  // #538 closed). Asserted against the meta tag so the roll cannot quietly
  // start rendering something else.
  const metaVersion = await page.locator('meta[name="cicchetto-version"]').getAttribute("content");
  expect(metaVersion, "the #292 version meta must be present in the built bundle").toBeTruthy();
  await expect(page.getByTestId("credits-version")).toHaveText(metaVersion ?? "");

  // ── every contributor, with their count, in the derived order ───────────
  // The whole list and its ORDER, not a spot check: `git shortlog -sn` ranks
  // by commit count, and a roll that renamed, reordered or truncated the list
  // is exactly as wrong as an empty one.
  const painted = await page.getByTestId("credits-person").evaluateAll((rows) =>
    rows.map((row) => ({
      name: row.querySelector(".credits-person-name")?.textContent ?? "",
      commits: Number(row.querySelector(".credits-person-count")?.textContent ?? "NaN"),
    })),
  );
  expect(painted).toEqual(baked.contributors.map((c) => ({ name: c.name, commits: c.commits })));

  // And the empty-state line is ABSENT — it is the fallback the degraded
  // build shows, and seeing it here would mean the list rendered from nothing.
  await expect(page.getByTestId("credits-empty")).toHaveCount(0);
});

test("#1773 — the roll can be muted and closed, and closing returns the drawer", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await openSettingsDrawer(page);

  await page.getByTestId("credits-entry").click();
  await expect(page.getByTestId("credits-modal")).toBeVisible({ timeout: 5_000 });

  // The soundtrack itself is not observable from Playwright — no engine here
  // exposes the output of an AudioContext. What IS observable, and what the
  // reader actually needs, is that the control exists, is reachable over the
  // full-bleed rain, and reports its state to assistive tech.
  const mute = page.getByTestId("credits-mute");
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("credits-close").click();
  await expect(page.getByTestId("credits-modal")).toHaveCount(0);

  // The drawer that opened it is still there: the modal is a sibling in Shell,
  // not a page the drawer pushed, so dismissing it must not have unwound the
  // drawer as well.
  await expect(page.locator(".settings-drawer.open")).toBeVisible();
});
