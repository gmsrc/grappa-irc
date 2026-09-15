// Issue 2199 — a REST shape mismatch must name the FIELD, in the place the
// person who hit it is looking.
//
// The reported failure is `GET /me`: 1.5.8 is the first release that validates
// it (`narrowMeResponse`), `me_json.ex` is byte-identical between v1.5.7 and
// v1.5.8, so nothing on the server moved — a payload that was already out of
// schema simply stopped being swallowed. A self-hoster got "the server sent a
// subject profile this version of the app cannot read", four words of advice
// and two buttons, and rolled the package back to 1.5.7 because there was no
// third option. The rollback restores a working client by NOT checking, which
// is why the diagnosability is the bug and not the payload.
//
// ## Why this spec is real and not a mirror
//
// The stimulus is the production path end to end: the browser really fetches
// `/me`, the real server really answers, and the ONE thing this spec does is
// delete a single nested required key from that answer on the wire. Nothing is
// stubbed, no narrower is called directly, no fixture stands in for the
// payload — so the assertion measures what a self-hoster sees.
//
// The key is chosen to exercise the whole path machinery in one shot:
// `home_data.networks[0].recoverable` crosses the root UNION (`S_MeJSONMeJson`
// is `{u: [user, visitor]}`, the case that used to be able to answer only
// "one of 2 variants"), two object hops, an ARRAY index, and ends on an
// ABSENT required key.
//
// Both channels the issue names are asserted, because they fail
// independently: the modal's detail area is what a non-developer reads back
// to us, and `console.error` is the only channel present when the throw is
// caught somewhere that renders its own copy.
//
// The second test is the NEGATIVE CONTROL and the reason the first one is a
// measurement: with the interception armed but the payload left intact, cic
// boots normally and no failure screen appears. Without it, a spec asserting
// "boot-failure says X" could be green because the harness breaks every boot.

import type { Page } from "@playwright/test";
import { expectShellReady } from "../fixtures/cicchettoPage";
import { expect, specUser, test } from "../fixtures/test";

// A cold boot plus a `/me` round trip; no IRC traffic is involved.
test.setTimeout(60_000);

// The path the mutation below must produce, spelled once. `wireValidate.ts`
// renders array steps as `[n]` and object steps dotted.
const BROKEN_PATH = "home_data.networks[0].recoverable";
const BROKEN_KEY = "recoverable";

type MeBody = {
  home_data?: { networks?: Array<Record<string, unknown>> };
};

// Seed the bearer before first paint — `addInitScript` runs ahead of any page
// script, so auth.ts reads it on its first pass. Inlined rather than reusing
// `loginAs`, which gates on a populated sidebar: the whole point here is a
// boot that never gets one.
async function seedAuth(page: Page): Promise<void> {
  const user = specUser();
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [user.token, user.subjectJson] as const,
  );
}

// Every `console.error` the page emits, from before the first navigation.
function recordConsoleErrors(page: Page): string[] {
  const lines: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") lines.push(msg.text());
  });
  return lines;
}

// Intercept the REAL `GET /me` and hand back the REAL body, optionally minus
// one nested required key. A URL predicate rather than a glob: `**/me` stops
// matching the moment a query string or a path prefix appears, and it would
// do so by silently not intercepting, which reads as a passing negative
// control.
async function routeMe(page: Page, mutate: (body: MeBody) => void): Promise<void> {
  await page.route(
    (url) => url.pathname === "/me" || url.pathname.endsWith("/me"),
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      if (response.status() !== 200) {
        return route.fulfill({ response });
      }
      const body = (await response.json()) as MeBody;
      mutate(body);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    },
  );
}

test("an unreadable /me names the exact field, on screen and in the console", async ({ page }) => {
  const consoleErrors = recordConsoleErrors(page);
  await seedAuth(page);

  // Asserted, not assumed: if the provisioned subject ever stops carrying a
  // home network row there is nothing to break, and this spec would otherwise
  // report a green having mutated nothing.
  let mutated = false;
  await routeMe(page, (body) => {
    const row = body.home_data?.networks?.[0];
    if (row !== undefined && BROKEN_KEY in row) {
      delete row[BROKEN_KEY];
      mutated = true;
    }
  });

  await page.goto("/");

  const detail = page.getByTestId("boot-failure-detail");
  await expect(detail).toBeVisible({ timeout: 30_000 });

  expect(
    mutated,
    `the real GET /me carried no home_data.networks[0].${BROKEN_KEY} to drop — ` +
      "the stimulus never fired, so the assertions below would measure nothing",
  ).toBe(true);

  // THE POINT OF THE ISSUE. Before this change the same screen read "the
  // server sent a subject profile this version of the app cannot read" and
  // stopped; the field was discarded inside `validate` one frame earlier.
  await expect(detail).toContainText(BROKEN_PATH);
  await expect(detail).toContainText("absent");
  // The pre-existing copy is kept, not replaced: it is the part that tells a
  // non-developer the app and the server disagree.
  await expect(detail).toContainText("this version of the app cannot read");

  // Second channel, and it has to be pinned INDEPENDENTLY of the first.
  //
  // Measured, not reasoned: with the deliberate `console.error` deleted and
  // everything else in place, "some console error mentions the path" is still
  // TRUE — the uncaught throw is echoed to the console by the runtime, and
  // that echo is the error's own message, which now carries the path. So the
  // obvious assertion passes while the channel it claims to test is gone.
  //
  // The discriminator is that the modal's copy travels with the message and
  // not with the deliberate line. A console error that names the field WITHOUT
  // that copy can only be the one `narrowRest` writes. Expressed as a property
  // rather than as a hand-copied log prefix: the e2e runner mounts `e2e/`
  // alone, so it cannot import the real string from `src/`, and a literal
  // copied here would drift silently the day production reworded it.
  const OWN_LINE = (line: string) =>
    line.includes(BROKEN_PATH) && !line.includes("this version of the app cannot read");
  await expect
    .poll(() => consoleErrors.filter(OWN_LINE).length, {
      message:
        "no console error named the field on its own — " +
        `collected: ${JSON.stringify(consoleErrors)}`,
    })
    .toBeGreaterThan(0);
  expect(consoleErrors.filter(OWN_LINE).some((line) => line.includes("absent"))).toBe(true);
});

test("negative control: the same interception, payload intact, boots clean", async ({ page }) => {
  await seedAuth(page);
  // Armed and passing the body through untouched — so a boot-failure here
  // would mean the harness breaks the boot on its own, and the assertion
  // above would prove nothing about the change.
  await routeMe(page, () => {});

  await page.goto("/");
  await expectShellReady(page);
  await expect(page.getByTestId("boot-failure-detail")).toBeHidden();
});
