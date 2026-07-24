// #349 — NickServ registration wizard, REAL-SERVICES full round-trip e2e.
//
// The NON-HOLLOW companion to registration-wizard.spec.ts (which fakes the
// REST + WS surface to prove cic wiring). This spec drives the wizard
// through cicchetto against the LIVE stack — grappa-test → bahamut-test
// (azzurra/bahamut) → azzurra-services (email-enabled) → the mailpit sink —
// and proves an ACTUAL nick reaches `+r`:
//
//   REGISTER (real NickServ) → services email the AUTH code → mailpit
//   catches it → the spec reads the code from mailpit's HTTP API → paste it
//   → AUTH (real NickServ) → services set `+r` → grappa broadcasts
//   `umode_changed` → cic → the wizard auto-completes (the no-parse +r
//   terminator). No stubs, no faked +r — the success banner appears ONLY
//   because the seeded nick genuinely registered.
//
// ── EMAIL DOMAIN (source-verified, load-bearing) ──────────────────────────
// azzurra/services `validate_email` (src/misc.c) is a HARDCODED ICANN-TLD
// allowlist (`validate_tld`) — it does NO DNS lookup. `.test` is NOT an
// ICANN TLD, so a `@…​.test` recipient is rejected ("The E-Mail address you
// entered … is not valid") and REGISTER never mails a code. The recipient
// MUST use a real TLD; we use `example.com` (RFC-2606 reserved). msmtp
// relays ALL mail to mailpit regardless of domain, so this stays fully
// hermetic (no real internet / DNS needed). (Confirmed by a manual
// register→AUTH→+r round-trip against this exact testnet, 2026-07-24.)
//
// ── RE-RUN NOTE ───────────────────────────────────────────────────────────
// The seeded nick `wiz-reg-nick` (azzurra-reg, --auth none) is registered
// exactly ONCE per fresh services container. In CI the testnet is fresh each
// run, so this is a clean register. For a LOCAL re-run against a persistent
// testnet the nick is already `+r` (button hidden) — bring the testnet down
// and back up (`scripts/testnet.sh down && scripts/integration.sh …`) first.

import { expect, test } from "@playwright/test";
import { loginAs } from "../fixtures/cicchettoPage";
import { awaitMail, extractFromMail, resetMailpit } from "../fixtures/mailpit";
import { getSeededWizUser, WIZ_NETWORK_SLUG } from "../fixtures/seedData";

// Valid-TLD recipient (see EMAIL DOMAIN note). This is the address the
// wizard's step-2 field carries into `REGISTER <pw> <email>`; mailpit is
// polled for mail addressed to it.
const REG_EMAIL = "wiz-test@example.com";
// 5–32 chars — the wizard's client-side password guard (matches Azzurra's
// NickServ floor). Value is irrelevant beyond length; it never leaves the
// wire-only services-target path.
const REG_PASSWORD = "wizregpw1";
// Azzurra confirmation mail carries the code as `/msg NickServ AUTH <digits>`
// (case-sensitive: the lowercase "authorization code" prose line does NOT
// match this uppercase pattern). Same regex documented in fixtures/mailpit.ts.
const AUTH_CODE_RE = /AUTH (\d+)/;

test.describe("#349 registration wizard (real services)", () => {
  test("registers the seeded nick end-to-end via the emailed AUTH code → +r", async ({ page }) => {
    // Real services + a sendmail hop + a +r S2S broadcast is slower than the
    // faked lane; give the whole round-trip generous headroom.
    test.setTimeout(90_000);

    // Wipe any prior run's confirmation mail so the To-filter is unambiguous.
    await resetMailpit();

    await loginAs(page, getSeededWizUser());

    // Home pane → the register launcher. It shows because azzurra-reg has a
    // registerable services_flavor AND the seeded nick has no `+r` yet.
    await page.locator(".sidebar-home-btn").click();
    await expect(page.locator(".home-pane-registered").first()).toBeVisible({ timeout: 15_000 });
    const registerBtn = page.getByTestId(`home-register-nick-${WIZ_NETWORK_SLUG}`);
    await expect(registerBtn).toBeVisible({ timeout: 15_000 });

    // Open the wizard → step 1 (intro).
    await registerBtn.click();
    const dialog = page.getByTestId("registration-wizard");
    await expect(dialog).toHaveAttribute("data-step", "1");

    // 1 → 2 (email).
    await page.getByTestId("registration-wizard-next").click();
    await expect(dialog).toHaveAttribute("data-step", "2");
    await page.getByTestId("registration-wizard-email").fill(REG_EMAIL);

    // 2 → 3 (password).
    await page.getByTestId("registration-wizard-next").click();
    await expect(dialog).toHaveAttribute("data-step", "3");
    await page.getByTestId("registration-wizard-password").fill(REG_PASSWORD);

    // 3 → 4 — REGISTER auto-sends to the REAL NickServ on step entry.
    await page.getByTestId("registration-wizard-next").click();
    await expect(dialog).toHaveAttribute("data-step", "4");

    // Read the AUTH code from the mail services actually sent. Mail arriving
    // is itself the proof the real NickServ accepted the REGISTER — a
    // stronger, subscription-independent signal than the DOM NOTICE mirror.
    const mail = await awaitMail(REG_EMAIL, { timeoutMs: 45_000 });
    const code = extractFromMail(mail, AUTH_CODE_RE);

    // 4 → 5 (user-advanced; the emailed code entry).
    await page.getByTestId("registration-wizard-next").click();
    await expect(dialog).toHaveAttribute("data-step", "5");
    await page.getByTestId("registration-wizard-code").fill(code);

    // 5 → 6 — AUTH <code> auto-sends to the REAL NickServ on step entry.
    await page.getByTestId("registration-wizard-next").click();
    await expect(dialog).toHaveAttribute("data-step", "6");

    // THE SHIP GATE: the nick genuinely reaches `+r` (services accepted the
    // emailed code) → grappa's umode_changed broadcast flips the wizard to
    // success, then it auto-closes; the launch button is reactively gone via
    // the SAME +r signal. Nothing here is faked.
    await expect(page.getByTestId("registration-wizard-success")).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toHaveCount(0, { timeout: 10_000 });
    await expect(registerBtn).toHaveCount(0);
  });
});
