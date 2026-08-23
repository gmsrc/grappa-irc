// #1695 — the CSP perimeter around the SomaFM catalogue host.
//
// TWO DIFFERENT QUESTIONS, AND ONLY ONE OF THEM IS AN EXUNIT QUESTION.
// `security_headers_test.exs` proves the policy STRING carries the token.
// It cannot prove a browser honours it, and it cannot prove what the policy
// still REFUSES. This spec answers both against the real header the BEAM
// serves, which is the only place the two can be checked together.
//
// THE REFUSALS ARE THE POINT. `connect-src` ships the measured host and
// nothing wider — measured against the live catalogue on 2026-08-23, all 184
// `.pls` playlist URLs (the only kind a client fetches, so the only kind
// `connect-src` governs) are on `api.somafm.com`, with the 138 logos on
// `img-src https:` and the 103 prerolls on `media-src https:`. So two
// neighbours of the allowed host must stay blocked, and they are blocked for
// DIFFERENT reasons:
//
//   * the BARE `somafm.com` — the trap #1695 names in its own verification.
//     The catalogue answers byte-identically from either host (measured:
//     52,852 bytes for `channels.json`, 2,576 for `songs/groovesalad.json`,
//     both hosts), so a client author reaching for the shorter spelling gets
//     a working `curl` and a blocked `fetch`. This pins the refusal so that
//     mistake reds here instead of in a browser console.
//
//   * `ice.somafm.com` — a somafm SUBDOMAIN that is not the API. THIS is the
//     one that catches a distracted widening to `https://*.somafm.com`, and
//     the bare domain does NOT: a CSP host-source spelled `*.` requires at
//     least one label, so `*.somafm.com` refuses the bare domain too and a
//     bare-domain pin would sail straight through the widening it was added
//     to catch. A non-api subdomain is the only stimulus that separates the
//     shipped policy from the wildcard.
//
// INTERCEPTION, NOT THE NETWORK. All three hosts are routed, so no assertion
// here depends on somafm being up (#682 made that rule for the station table
// and it holds harder for a gate). The renderer enforces CSP BEFORE the
// request reaches the network layer, so a route handler firing is itself the
// verdict "the policy let this out", and a handler that never fires is the
// verdict "the policy refused it". The `securitypolicyviolation` events
// collected by `fixtures/test.ts` are the second, independent witness. Hosts
// are routed one literal at a time rather than through a `*.somafm.com`
// glob — the glob is the very shape under test, and spelling it in the
// harness would make the harness agree with a widened policy by definition.
//
// The fulfilled response carries `Access-Control-Allow-Origin: *` because the
// real endpoint does (measured, and recorded in `radioStations.ts`). Without
// it the browser would refuse the RESPONSE for CORS and the fetch would
// reject exactly as a CSP block does — two different failures wearing the
// same TypeError. `hits` is what keeps them apart: it records the request
// leaving the renderer, which is the CSP verdict on its own.

import { expect, test } from "../fixtures/test";

const ALLOWED = "https://api.somafm.com/channels.json";
const BLOCKED_BARE = "https://somafm.com/channels.json";
const BLOCKED_SUBDOMAIN = "https://ice.somafm.com/groovesalad-128-mp3";

// A violation reports `blockedURI` as the full URL or as the bare origin
// depending on the engine, so compare on the HOST and never on the string —
// `https://somafm.com` and `https://ice.somafm.com` both contain "somafm.com"
// and this spec's whole job is telling those two apart.
function blockedSomafmHosts(violations: readonly { blockedURI: string }[]): Set<string> {
  const hosts = new Set<string>();
  for (const v of violations) {
    let host = "";
    try {
      host = new URL(v.blockedURI).host;
    } catch {
      // "inline" / "eval" and friends are not URLs. Not ours; the suite-wide
      // guard still sees them and will red the teardown.
      host = "";
    }
    if (host.endsWith("somafm.com")) hosts.add(host);
  }
  return hosts;
}

test("#1695 connect-src admits api.somafm.com and still refuses the bare domain and its siblings", async ({
  page,
  cspViolations,
}) => {
  const hits: string[] = [];

  // The two that must never get here are routed too. Recording a hit rather
  // than only fulfilling turns "blocked" into a positive assertion (`hits`
  // stayed empty for that host) instead of the mere absence of an error.
  for (const origin of ["https://api.somafm.com", "https://somafm.com", "https://ice.somafm.com"]) {
    await page.route(`${origin}/**`, async (route) => {
      hits.push(new URL(route.request().url()).host);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ channels: [] }),
      });
    });
  }

  // Any same-origin document carries the header — the plug registers them on
  // every response. The login screen needs no subject state and is cheapest.
  await page.goto("/login");
  await expect(page.getByLabel(/nick or email/i)).toBeVisible({ timeout: 10_000 });

  expect(
    cspViolations,
    "the guard must start empty, or the refusals asserted below prove nothing",
  ).toEqual([]);

  // ── the host the measurement admits ──────────────────────────────────────
  const allowed = await page.evaluate(async (url) => {
    try {
      const res = await fetch(url);
      return { ok: res.ok, status: res.status, error: "" };
    } catch (e) {
      return { ok: false, status: 0, error: String(e) };
    }
  }, ALLOWED);

  expect(
    hits,
    "the fetch to api.somafm.com must leave the renderer — if connect-src lost the token the " +
      "request dies at the policy and the route handler never runs",
  ).toContain("api.somafm.com");
  expect(allowed, "and the response must come back clean").toMatchObject({ ok: true, status: 200 });

  // ── the two that must not ────────────────────────────────────────────────
  await page.evaluate(
    async (urls) => {
      for (const url of urls) await fetch(url).catch(() => undefined);
    },
    [BLOCKED_BARE, BLOCKED_SUBDOMAIN],
  );

  await expect
    .poll(() => [...blockedSomafmHosts(cspViolations)].sort(), {
      timeout: 10_000,
      message:
        "connect-src must refuse the bare somafm.com (the wrong-spelling trap) AND a non-api " +
        "subdomain (the wildcard tripwire). A missing ice.somafm.com here means the policy was " +
        "widened to https://*.somafm.com, past everything #1695 measured.",
    })
    .toEqual(["ice.somafm.com", "somafm.com"]);

  expect(
    hits.filter((h) => h !== "api.somafm.com"),
    "a refused host must never reach the network layer",
  ).toEqual([]);

  const provoked = cspViolations.find((v) => blockedSomafmHosts([v]).size > 0);
  expect(provoked?.violatedDirective, "the refusal must come from connect-src").toContain(
    "connect-src",
  );

  // Drain only what this spec provoked — the suite-wide teardown asserts an
  // empty array and is right to. Anything else the page produced is a real
  // finding and must still red it.
  const kept = cspViolations.filter((v) => blockedSomafmHosts([v]).size === 0);
  cspViolations.length = 0;
  cspViolations.push(...kept);
});
