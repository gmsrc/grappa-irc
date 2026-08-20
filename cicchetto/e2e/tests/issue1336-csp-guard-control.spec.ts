// #1336 (M2, from #1117) — the positive control for the suite-wide CSP guard.
//
// `fixtures/test.ts`'s `_cspGuard` asserts, at the teardown of EVERY spec that
// imports the wrapped `test`, that zero `securitypolicyviolation` events were
// collected. That zero is the normal outcome, which is exactly what makes it
// dangerous: a collector that never receives produces the same empty array as
// a CSP nobody violated. Rename the exposed binding, land the init script
// after the document has already listened, or meet an engine that spells the
// event differently, and ~750 assertions go quiet together with nothing to
// show for it — the #1117 shape at its largest blast radius.
//
// So this spec provokes a REAL enforced block against the REAL header
// (`GrappaWeb.Plugs.SecurityHeaders`) and asserts the guard's own collector
// caught it, through the same binding, the same init script and the same
// array the teardown reads. It then drains what it provoked, so the guard's
// own assertion still sees the empty array it is entitled to.
//
// Placement, deliberate: ONE control per APPARATUS, not one per test. The
// wiring is a single fixture shared by every spec, so proving it live once
// per run is what a positive control on it can mean. It does NOT establish
// that the listener re-armed inside some other spec's context — a per-test
// control would cost a provoked violation in all ~750 of them, and any page
// with no enforced CSP (a bare `about:blank`, a document served by something
// other than the BEAM) would then fail for the harness's reasons rather than
// the product's.
//
// The stimulus is a `connect-src` violation: the CSP allowlist is `'self'`
// plus three named https hosts, so a fetch to a reserved-TLD host
// (RFC 2606 `.invalid`, which by construction never resolves) is refused by
// the policy before any network I/O — deterministic, side-effect free, and
// nothing in the app observes it. `.catch()` swallows the resulting
// TypeError: the rejected promise is the block working, not a failure.

import { expect, test } from "../fixtures/test";

// Reserved TLD (RFC 2606) — cannot resolve, so a violation here can only be
// the policy refusing it, never a network round trip that happened to fail.
const BLOCKED_URL = "https://csp-control.invalid/probe";

test("#1336 the suite-wide CSP guard's collector actually collects", async ({
  page,
  cspViolations,
}) => {
  // Any same-origin document carries the header — the plug registers the
  // response headers for every response, static included. The login screen
  // needs no subject state and is the cheapest one to reach.
  await page.goto("/login");
  await expect(page.getByLabel(/nick or email/i)).toBeVisible({ timeout: 10_000 });

  // Pre-state: the guard has collected nothing yet, so the assertion below
  // cannot be satisfied by something that arrived before the stimulus.
  expect(
    cspViolations,
    "the guard must start empty — a violation before the stimulus would make the control meaningless",
  ).toEqual([]);

  await page.evaluate(async (url) => {
    await fetch(url).catch(() => undefined);
  }, BLOCKED_URL);

  await expect
    .poll(() => cspViolations.filter((v) => v.blockedURI.includes("csp-control.invalid")).length, {
      timeout: 10_000,
      message:
        "the CSP guard collected nothing for a request its own policy blocks — " +
        "the binding, the init script or the event plumbing in fixtures/test.ts is dead, " +
        "and every `toEqual([])` that guard makes is vacuous",
    })
    .toBeGreaterThan(0);

  // The payload the guard forwards must be the violation's, not a husk: the
  // teardown message points an operator at a DIRECTIVE, so the directive has
  // to survive the hop through `exposeBinding`.
  const provoked = cspViolations.find((v) => v.blockedURI.includes("csp-control.invalid"));
  expect(provoked?.violatedDirective, "the forwarded payload must name the directive").toContain(
    "connect-src",
  );

  // Drain what this test provoked — the guard's teardown asserts the array is
  // empty, and it is right to. Only the provoked entries go; anything else the
  // page produced is a real finding and must still red the teardown.
  const kept = cspViolations.filter((v) => !v.blockedURI.includes("csp-control.invalid"));
  cspViolations.length = 0;
  cspViolations.push(...kept);
});
