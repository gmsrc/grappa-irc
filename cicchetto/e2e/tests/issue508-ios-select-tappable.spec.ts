// #508 (2026-07-28) — <select> tap-to-open on iOS. Inbound bug: on a real
// iPhone the native picker opened ONLY when the operator tapped the
// `<label for=…>`, never the `<select>` control itself — the control's box
// (with its arrow) looked dead to touch. Root cause:
// `html.is-ios { -webkit-user-select: none }` (themes/default.css) INHERITS
// onto every `<select>`, and WebKit refuses to open the native picker on a
// DIRECT tap of a user-select:none form control — the same quirk the #79
// input/textarea re-enable already works around. A tap on a linked `<label>`
// still forwards activation programmatically, which is exactly why only the
// label opened the picker. Fix: re-enable `user-select: text` on
// `html.is-ios select` (an EXPLICIT value — `user-select: auto` on a control
// re-inherits the parent's `none`, so it would NOT fix it).
//
// This is a WIRING/CONTRACT guard, NOT a "picker visibly opens" test: iOS's
// native picker invocation is not reproducible on Playwright webkit-iphone-15
// (feedback_playwright_webkit_not_ios_scroll) — the real tap→picker FEEL is a
// device test (vjt post-ship, per the issue DoD). What IS deterministic here
// is the CSS cascade the fix lives in: under `html.is-ios` a generic element
// inherits `user-select: none` (the bug's precondition) while a `<select>`
// must NOT. The two assertions only go green TOGETHER — reverting the fix
// (select falls back to the inherited `none`) reds the select half, and
// removing the base `html.is-ios` none would red the control half — so
// neither a stale rule nor a dropped fix can pass silently.

import { loginAs } from "../fixtures/cicchettoPage";
import { expect, specUser, test } from "../fixtures/test";

test("@webkit iOS — <select> is exempt from the inherited user-select:none so the native picker opens on a direct tap of the control, not only via its label", async ({
  page,
}) => {
  const vjt = specUser();
  // loginAs waits for the shell-ready signal, which guarantees boot ran and
  // lib/platform.ts applied the `is-ios` class before we probe the cascade.
  await loginAs(page, vjt);

  const probe = await page.evaluate(() => {
    // Precondition: the blanket -webkit-user-select:none only lives on the
    // is-ios surface. If false the assertions below are meaningless.
    const isIos = document.documentElement.classList.contains("is-ios");

    const readUserSelect = (el: Element): string => {
      const cs = getComputedStyle(el);
      // WebKit exposes the prefixed property; read it first, fall back to
      // the unprefixed alias.
      return cs.webkitUserSelect || cs.userSelect;
    };

    // Control — a generic element under html.is-ios inherits the blanket
    // `none`. Proves the bug's precondition is live in the SHIPPED cascade,
    // not a rule that was already removed.
    const div = document.createElement("div");
    document.body.appendChild(div);
    const divUserSelect = readUserSelect(div);

    // Subject — a real <select> in the same cascade. It is subject to the
    // exact inheritance a rendered app <select> sees, so the element-level
    // rule the fix adds is what this measures.
    const sel = document.createElement("select");
    const opt = document.createElement("option");
    opt.textContent = "x";
    sel.appendChild(opt);
    document.body.appendChild(sel);
    const selUserSelect = readUserSelect(sel);

    div.remove();
    sel.remove();
    return { isIos, divUserSelect, selUserSelect };
  });

  // No hollow green: without is-ios there is no `none` to override.
  expect(probe.isIos).toBe(true);

  // The blanket none is live — the bug's precondition.
  expect(probe.divUserSelect).toBe("none");

  // The fix exempts <select>: anything but `none` restores tap-to-open. The
  // rule sets `text` (the only value that overrides the inherited none — see
  // the moduledoc: `auto` would re-inherit it).
  expect(probe.selUserSelect).not.toBe("none");
  expect(probe.selUserSelect).toBe("text");
});
