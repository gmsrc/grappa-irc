// Forward the page's own error output into the Playwright run log.
//
// #484 — this existed as four hand-copied `page.on("console", …)` blocks, and
// all four carried the same defect: they filtered on `msg.type() === "warn"`.
// Playwright's `ConsoleMessage.type()` returns `"warning"`, never `"warn"`, so
// the branch was statically dead and every cic `console.warn` was dropped from
// the log of the specs that had gone out of their way to capture it. The
// duplication is what let one wrong literal be wrong four times, so the fix is
// one helper rather than four corrected copies.
//
// Diagnostics only: this attaches listeners and prints. It asserts nothing and
// fails nothing — a spec that wants to FAIL on console noise must assert on it.

import type { ConsoleMessage, Page } from "@playwright/test";

type ConsoleType = ReturnType<ConsoleMessage["type"]>;

// Severities worth surfacing. Typed against Playwright's own union, so the
// `"warn"` typo that started this is now a compile error rather than a branch
// that quietly never runs.
const FORWARDED_TYPES = new Set<ConsoleType>(["error", "warning"]);

export function forwardPageDiagnostics(page: Page): void {
  page.on("console", (msg) => {
    if (!FORWARDED_TYPES.has(msg.type())) return;
    // eslint-disable-next-line no-console
    console.log(`[cic:${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    // eslint-disable-next-line no-console
    console.log(`[cic:pageerror] ${err.message}`);
  });
}
