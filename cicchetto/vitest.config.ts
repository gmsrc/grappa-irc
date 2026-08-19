import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// SolidJS components compile to fine-grained reactive primitives — vitest
// needs the same `vite-plugin-solid` transform the dev server uses, or
// JSX in tests is parsed as plain React and signal updates don't fire.
//
// `environment: "jsdom"` gives DOM globals (document, localStorage,
// fetch shim via undici) so component tests + the auth signal store
// (which side-effects to localStorage) run unmodified. `setupTests.ts`
// installs jest-dom matchers.
export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/setupTests.ts"],
    // `e2e/fixtures/**/*.test.ts` — the e2e peer/page fixtures are their
    // own package (e2e/package.json, playwright-only), but the pieces of
    // them that carry LOGIC rather than driver calls are unit-testable and
    // worth testing here (#806). Matched on `.test.ts` alone, never
    // `.spec.ts`: `e2e/tests/*.spec.ts` are playwright specs and must not
    // be picked up by vitest.
    //
    // `e2e/reporters/**/*.test.ts` — same argument one directory over
    // (#1584): a playwright REPORTER is the only place that sees every
    // test's true worker and true order, so the cure for the
    // first-in-project class lives there, and the part of it that is a
    // decision rather than a driver call is proven here.
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "e2e/fixtures/**/*.test.ts",
      "e2e/reporters/**/*.test.ts",
    ],
  },
  resolve: {
    conditions: ["development", "browser"],
  },
});
