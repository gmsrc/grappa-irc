// #349 — NickServ registration wizard, FAST-LANE FAKED e2e.
//
// This is the CLIENT-BEHAVIOUR companion to the orchestrator-owned
// REAL-SERVICES full-registration e2e (Atheme / bahamut / azzurra +
// mailcatcher — that suite proves an actual nick registers end-to-end).
// This spec proves the cic wiring WITHOUT any real IRC / services: it
// stubs the REST surface via `page.route` and mocks the Phoenix socket
// via `page.routeWebSocket`, so it runs in the FAST e2e lane (no testnet).
//
// It asserts the parts a faked harness can prove deterministically:
//   1. The "📝 Register nick" button shows on a connected row whose
//      network has a registerable `services_flavor` and NO +r umode.
//   2. Walking the 6 steps sends the SOURCE-VERIFIED command bodies —
//      step-4 `REGISTER <password> <email>` and step-6 azzurra
//      `AUTH <code>` (single-arg) — spied on the outbound POST.
//   3. Faking the +r umode over the user topic HIDES the launch button
//      (reactive) and AUTO-COMPLETES step 6 (the no-parse terminator).
//
// ── AUTHORING NOTE (orchestrator) ─────────────────────────────────────
// Authored following issue204-foolproof-login (page.route REST stubs +
// addInitScript localStorage boot) and issue221-whois-badges
// (routeWebSocket + the Phoenix v2 `[join_ref, ref, topic, event,
// payload]` frame format). It was NOT executed here (the wizard-builder
// session is instructed not to run Playwright — the harness is yours).
// Please RUN + tune it in the fast lane: the REST stub set (§stubRest)
// covers only the endpoints the Home pane boot needs — add any this
// deployment also fires — and the WS mock (§mockSocket) implements the
// minimal Phoenix handshake + a fabricated `umode_changed` push; adjust
// the topic / join-ref handling if phoenix.js routing differs here.

import { expect, test } from "@playwright/test";

const NETWORK_SLUG = "azzurra";
const NETWORK_ID = 7;
const OWN_NICK = "grappa";
const USER_NAME = "vjt";
const USER_TOPIC = `grappa:user:${USER_NAME}`;

const EMAIL = "wizard349@example.com";
const PASSWORD = "hunter2pw";
const CODE = "1070187402";

const NOW = "2026-01-01T00:00:00Z";

type SentMessage = { channel: string; body: string };

// A user /me whose home_data carries one connected network — enough for
// the HomePane ConnectedRow (with the register button) to render off /me.
function meJson() {
  return {
    kind: "user",
    id: "u1",
    name: USER_NAME,
    is_admin: false,
    inserted_at: NOW,
    read_cursors: {},
    unread_counts: {},
    badge_count: 0,
    home_data: {
      networks: [
        {
          slug: NETWORK_SLUG,
          nick: OWN_NICK,
          connection_state: "connected",
          connection_state_reason: null,
          connection_state_changed_at: null,
        },
      ],
      available_networks: [],
    },
  };
}

// GET /networks — carries services_flavor so flavorForSlug resolves a
// registerable template and networkIdBySlug resolves the +r lookup key.
function networksJson() {
  return [
    {
      kind: "user",
      id: NETWORK_ID,
      slug: NETWORK_SLUG,
      nick: OWN_NICK,
      ident: null,
      realname: null,
      connection_state: "connected",
      connection_state_reason: null,
      connection_state_changed_at: null,
      services_flavor: "azzurra",
      inserted_at: NOW,
      updated_at: NOW,
    },
  ];
}

// Stub the REST surface. Static assets (the app bundle, fonts, CSS) fall
// through to the real nginx-test via route.continue(); every API path is
// answered locally so no request reaches a real grappa/IRC backend. The
// NickServ `messages` POST is captured into `sent` for the body-spy.
async function stubRest(page: import("@playwright/test").Page, sent: SentMessage[]): Promise<void> {
  await page.route("**/*", async (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());

    // Outbound services command — the body-spy. `/networks/<slug>/channels/
    // <chan>/messages` (POST). Capture body, ACK 200 (services target
    // persists nothing server-side; the wizard only needs res.ok).
    const msgMatch = pathname.match(/^\/networks\/[^/]+\/channels\/([^/]+)\/messages$/);
    if (msgMatch && req.method() === "POST") {
      const parsed = JSON.parse(req.postData() ?? "{}") as { body?: string };
      sent.push({ channel: decodeURIComponent(msgMatch[1]), body: parsed.body ?? "" });
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }

    if (pathname === "/me" && req.method() === "GET") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(meJson()) });
      return;
    }
    if (pathname === "/networks" && req.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(networksJson()),
      });
      return;
    }
    // Per-network channel list — none needed for the home pane assertions.
    if (/^\/networks\/[^/]+\/channels$/.test(pathname) && req.method() === "GET") {
      await route.fulfill({ contentType: "application/json", body: "[]" });
      return;
    }
    // Featured channels (fetched on home display) — empty; a failure here
    // is caught in-app anyway.
    if (/^\/networks\/[^/]+\/featured$/.test(pathname)) {
      await route.fulfill({ contentType: "application/json", body: "[]" });
      return;
    }

    // Any other same-origin API GET the boot fires (theme, settings,
    // uploads config, …): benign empty object so nothing 404s / 500s.
    // Static assets (have a file extension, /assets/, or the doc root)
    // pass through to the real bundle.
    const isStatic =
      pathname === "/" ||
      pathname.startsWith("/assets/") ||
      /\.[a-z0-9]+$/i.test(pathname) ||
      pathname.startsWith("/login");
    if (isStatic) {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

// Mock the Phoenix socket. Implements the minimal v2 protocol: reply "ok"
// to every phx_join + heartbeat + push, and capture the user-topic join
// so the test can fabricate a server→client `umode_changed` event. Never
// calls connectToServer() — fully offline.
type Injector = { pushUmode: (modes: string[]) => void };

async function mockSocket(page: import("@playwright/test").Page): Promise<Injector> {
  const state: { send: ((m: string) => void) | null; userJoinRef: string | null } = {
    send: null,
    userJoinRef: null,
  };

  await page.routeWebSocket(/\/socket\/websocket/, (ws) => {
    state.send = (m: string) => ws.send(m);
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let frame: unknown;
      try {
        frame = JSON.parse(message);
      } catch {
        return;
      }
      // Phoenix v2 serializer: [join_ref, ref, topic, event, payload].
      if (!Array.isArray(frame) || frame.length !== 5) return;
      const [joinRef, ref, topic, event] = frame as [
        string | null,
        string | null,
        string,
        string,
        unknown,
      ];
      if (event === "phx_join") {
        if (topic === USER_TOPIC) state.userJoinRef = joinRef;
        // Join reply — response carries read_cursor:null for per-channel
        // joins; {} is fine for the user topic.
        ws.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]));
        return;
      }
      // Heartbeat + any client push (visibility, etc.) — ACK so phoenix
      // stays happy and pushes resolve.
      ws.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]));
    });
  });

  return {
    pushUmode: (modes: string[]) => {
      if (!state.send) throw new Error("socket not connected — no frame to inject");
      // Fabricated server→client broadcast on the user topic (the shape
      // Grappa emits from its self-MODE +r echo → umode_changed).
      state.send(
        JSON.stringify([
          state.userJoinRef,
          null,
          USER_TOPIC,
          "event",
          { kind: "umode_changed", network_id: NETWORK_ID, modes },
        ]),
      );
    },
  };
}

async function boot(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(
    ([name]) => {
      localStorage.setItem("grappa-token", "faked-token");
      localStorage.setItem("grappa-subject", JSON.stringify({ kind: "user", id: "u1", name }));
      localStorage.setItem("cic.installChoice", "browser");
    },
    [USER_NAME] as const,
  );
  await page.goto("/");
}

// Navigate to the Home pane and return its register-button locator.
async function gotoHome(page: import("@playwright/test").Page) {
  await page.locator(".sidebar-home-btn").click();
  await expect(page.locator(".home-pane-registered").first()).toBeVisible({ timeout: 10_000 });
  return page.getByTestId(`home-register-nick-${NETWORK_SLUG}`);
}

test.describe("#349 registration wizard (faked, fast lane)", () => {
  test("walks the 6 steps and sends the source-verified REGISTER + AUTH bodies", async ({
    page,
  }) => {
    const sent: SentMessage[] = [];
    await stubRest(page, sent);
    await mockSocket(page);
    await boot(page);

    // 1. Button visible on the connected azzurra row (registerable flavor, no +r).
    const registerBtn = await gotoHome(page);
    await expect(registerBtn).toBeVisible({ timeout: 10_000 });

    // Open the wizard → step 1 (intro).
    await registerBtn.click();
    const dialog = page.getByTestId("registration-wizard");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("data-step", "1");

    // 1 → 2 (email).
    await page.getByTestId("registration-wizard-next").click();
    await expect(dialog).toHaveAttribute("data-step", "2");
    await page.getByTestId("registration-wizard-email").fill(EMAIL);

    // 2 → 3 (password).
    await page.getByTestId("registration-wizard-next").click();
    await expect(dialog).toHaveAttribute("data-step", "3");
    await page.getByTestId("registration-wizard-password").fill(PASSWORD);

    // 3 → 4 (REGISTER auto-sends on entry).
    await page.getByTestId("registration-wizard-next").click();
    await expect(dialog).toHaveAttribute("data-step", "4");
    await expect
      .poll(() => sent.find((m) => m.channel === "NickServ")?.body)
      .toBe(`REGISTER ${PASSWORD} ${EMAIL}`);

    // 4 → 5 (user-advanced Next; code entry).
    await page.getByTestId("registration-wizard-next").click();
    await expect(dialog).toHaveAttribute("data-step", "5");
    await page.getByTestId("registration-wizard-code").fill(CODE);

    // 5 → 6 (verify auto-sends azzurra single-arg `AUTH <code>`).
    await page.getByTestId("registration-wizard-next").click();
    await expect(dialog).toHaveAttribute("data-step", "6");
    await expect
      .poll(() => sent.filter((m) => m.channel === "NickServ").map((m) => m.body))
      .toContain(`AUTH ${CODE}`);
    // Azzurra's AUTH is single-arg — the nick must NOT be in the verb.
    expect(sent.some((m) => m.body === `AUTH ${OWN_NICK} ${CODE}`)).toBe(false);
  });

  test("hides the launch button and auto-completes step 6 when +r is faked over the user topic", async ({
    page,
  }) => {
    const sent: SentMessage[] = [];
    await stubRest(page, sent);
    const socket = await mockSocket(page);
    await boot(page);

    const registerBtn = await gotoHome(page);
    await expect(registerBtn).toBeVisible({ timeout: 10_000 });
    // Gate on the user-topic subscribe so the fabricated push is delivered
    // to a joined channel (Phoenix.PubSub doesn't replay to late joiners).
    await page.waitForFunction(
      (u) =>
        (window as unknown as { __cic_userTopicReady?: Set<string> }).__cic_userTopicReady?.has(
          u,
        ) ?? false,
      USER_NAME,
    );

    // Drive to step 6 (verify) so we can prove the +r auto-complete.
    await registerBtn.click();
    const dialog = page.getByTestId("registration-wizard");
    await page.getByTestId("registration-wizard-next").click(); // 1→2
    await page.getByTestId("registration-wizard-email").fill(EMAIL);
    await page.getByTestId("registration-wizard-next").click(); // 2→3
    await page.getByTestId("registration-wizard-password").fill(PASSWORD);
    await page.getByTestId("registration-wizard-next").click(); // 3→4
    await page.getByTestId("registration-wizard-next").click(); // 4→5
    await page.getByTestId("registration-wizard-code").fill(CODE);
    await page.getByTestId("registration-wizard-next").click(); // 5→6
    await expect(dialog).toHaveAttribute("data-step", "6");

    // Fake the server-pushed +r umode flip — the no-parse success terminator.
    socket.pushUmode(["r"]);

    // Step 6 celebrates, then auto-closes.
    await expect(page.getByTestId("registration-wizard-success")).toBeVisible({ timeout: 5_000 });
    await expect(dialog).toHaveCount(0, { timeout: 5_000 });

    // The launch button is reactively gone (same +r signal).
    await expect(registerBtn).toHaveCount(0);
  });
});
