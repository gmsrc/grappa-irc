// #1675 — `connection_state: "failing"`, the fourth state.
//
// The defect: `Networks.connect/1` writes `:connected` when the SPAWN
// succeeds, and nothing walked the row back when the upstream TCP/TLS/
// registration then failed. Three networks added on prod on 2026-08-22
// showed as connected in cicchetto while none of them ever registered.
// vjt's ruling made e2e coverage mandatory *because every part of it that
// failed on prod failed BETWEEN the layers* — an API-only assertion does
// not discharge the requirement, so the second half of test 1 asserts what
// the operator actually sees.
//
// SUBJECT: `admin-vjt`, the ONE seeded user with no network bind
// (compose.yaml: "admin-vjt has no bind"). Its HomePane therefore renders
// exactly the ephemeral network these tests provision and nothing else, so
// neither test can disturb — or be disturbed by — the seeded sessions every
// other spec depends on. The seeded networks are load-bearing and are never
// touched here (same discipline as admin-network-crud.spec.ts).
//
// DRIVER: a `network_servers` row pointed at a CLOSED port. `connect/2`
// returns `:econnrefused` immediately, `Session.Server`'s
// `{:irc_connect_failed, _}` arm reports `{:failing, "connection refused"}`
// through the injected `link_state_reporter`, and the row lands on
// `:failing` with the cause in `connection_state_reason`. Deterministic and
// instant — unlike the three real prod causes (a TLS hostname mismatch, an
// A-only host against a v6 source, a 30s connect timeout), which the
// harness cannot reproduce without a second ircd and a wall-clock wait.
//
// WHY TWO TESTS. The two halves of the ruling want opposite topologies:
//
//   1. `:failing` + the cic display want a PERMANENT failing row — one
//      dead server, so every attempt on the backoff ladder fails and the
//      state is stable for as long as the assertions take.
//   2. The recovery edge wants the row to LEAVE `:failing` on its own.
//      `SessionPlan`'s `refresh_plan` closure re-resolves the endpoint at
//      `Backoff.failure_count` on every `:transient` respawn, and
//      `Servers.pick_server!/2` indexes the enabled ring by that ordinal
//      (`rem(attempt, length(ring))`) — so a ring of [dead, dead, live]
//      walks itself onto the live leaf at attempt 2 and registers. That is
//      the REAL `mark_failing → mark_registered` pair on one credential,
//      not a park→connect cycle (which would re-write `:connected` from
//      `Networks.connect/1` before any registration and assert nothing).
//
// The two dead leaves in test 2 are not padding — see the ladder below.
//
// 🔴 THE LADDER, AND WHY THE BUDGETS ARE WHAT THEY ARE. These numbers are
// measured, not padding, and the first run of this spec was red for exactly
// this reason (polled 20s, needed ~35s).
//
// The FIRST connect failure never marks the row. Every operator-initiated
// connect spawns BEFORE it writes `:connected` (`resolve → spawn →
// Networks.connect/1`, which is #642's cure), so the row still reads
// `:parked` when an instantly-refusing upstream reports back, and
// `mark_failing/2` rejects `:parked` by design. Measured on the integration
// stack 2026-08-22 — `credential_bound` at 21:49:35.464, `report_link_state:
// {:failing, "connection refused"} declined (user_parked)` at .466, two
// milliseconds later. See `Networks.mark_failing/2`'s "KNOWN HOLE" section
// and DESIGN_NOTES 2026-08-22 #1675; it is a real bounded window, not a test
// artefact, and it is deliberately NOT cured in this slice.
//
// So the row can only reach `:failing` on attempt 2, which lands at
// `@connect_failure_sleep_ms` (30_000, `config/config.exs`; the e2e stack
// boots MIX_ENV=dev) + one backoff rung (5_000 ±25% jitter,
// `:session_backoff`) ≈ 35s. Test 2's ring then needs one more full rung
// before the live leaf: 2×30s + a 5s rung + a 10s rung + registration ≈ 95s.
//
// Shrinking the throttle in `config/dev.exs` was considered FIRST (the house
// rule is deterministic setup over a raised timeout, and #671 already does
// exactly that for the auto-away debounce) and declined on two grounds: it
// changes the retry cadence of every session in a 760-test suite to save 30s
// in one spec, and it would not buy determinism anyway — the wait exists
// because of the `:parked` window, not because of the throttle. There is no
// operator verb that provokes a connect failure on a row that is ALREADY
// `:connected`, so the wait cannot be removed from the test side.
//
// The polls below are therefore condition-based (poll until the state, never
// sleep-then-assert) with ceilings taken from that ladder.
//
// NOT COVERED HERE, deliberately: the reboot arm of the ruling (a
// `:failing` row is resumed by Bootstrap, not skipped). Restarting the
// container mid-suite is heavy and flaky; that arm runs the real
// `Bootstrap.run/0` against a real socket in
// `test/grappa/bootstrap_test.exs` ("#1675 — resumes a :failing
// credential").

import { adminLogin } from "../fixtures/cicchettoPage";
import { fetchAllMessagesAsc, GRAPPA_BASE_URL } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// Loopback + a port nothing can be listening on: connect(2) from inside the
// grappa container returns ECONNREFUSED with no DNS lookup, no route, and no
// wait. Ports 1 and 2 are unbindable without privileges, which is exactly
// why they are safe to dial.
const DEAD_HOST = "127.0.0.1";
const DEAD_PORT_A = 1;
const DEAD_PORT_B = 2;

// The recovery leaf. `solanum-test2` (aliased `bahamut-test2`) rather than
// the main `bahamut-test`: the latter serves every seeded session from the
// same container IP and has a per-IP clone posture the suite already trips
// over. This ircd carries only the azzurra2 seed, so one more registration
// costs nothing anybody else is waiting on.
const LIVE_HOST = "bahamut-test2";
const LIVE_PORT = 6667;

type NetworkRow = {
  slug: string;
  connection_state: string;
  connection_state_reason: string | null;
  connection: { registered: boolean } | null;
};

function userIdFromSubject(subjectJson: string): string {
  const subj = JSON.parse(subjectJson) as { kind: string; id: string };
  return subj.id;
}

async function createNetwork(token: string, slug: string): Promise<number> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/networks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ slug }),
  });
  if (!res.ok) throw new Error(`createNetwork: ${slug} → ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { id: number };
  return body.id;
}

async function addServer(
  token: string,
  networkId: number,
  host: string,
  port: number,
  priority: number,
): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/networks/${networkId}/servers`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ host, port, tls: false, priority }),
  });
  if (!res.ok) {
    throw new Error(`addServer: ${host}:${port} → ${res.status} ${await res.text()}`);
  }
}

// The bind is also the SPAWN (#1163 wired the admin bind dial through
// `Operator.connect_credential/1`), so this call is what starts the doomed
// connect attempt — there is no separate PATCH to make.
async function bindCredential(
  token: string,
  userId: string,
  networkId: number,
  nick: string,
): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/credentials`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ user_id: userId, network_id: networkId, nick, auth_method: "none" }),
  });
  if (!res.ok) throw new Error(`bindCredential: ${nick} → ${res.status} ${await res.text()}`);
}

async function unbindCredentialBestEffort(
  token: string,
  userId: string,
  networkId: number,
): Promise<void> {
  try {
    await fetch(`${GRAPPA_BASE_URL}/admin/credentials/${userId}/${networkId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // best-effort
  }
}

async function deleteNetworkBestEffort(token: string, networkId: number): Promise<void> {
  try {
    await fetch(`${GRAPPA_BASE_URL}/admin/networks/${networkId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // best-effort
  }
}

// `GET /networks` is the row cic itself reads (`Networks.Wire
// .network_with_nick_to_json/4`): `connection_state`,
// `connection_state_reason` and the LIVE `connection` projection in one
// shape. Polling it rather than the admin listing keeps the oracle on the
// same door the UI uses.
async function fetchNetworkRow(token: string, slug: string): Promise<NetworkRow | undefined> {
  const res = await fetch(`${GRAPPA_BASE_URL}/networks`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return undefined;
  const rows = (await res.json()) as NetworkRow[];
  return rows.find((r) => r.slug === slug);
}

async function waitForNetworkRow(
  token: string,
  slug: string,
  predicate: (row: NetworkRow) => boolean,
  timeoutMs: number,
  label: string,
): Promise<NetworkRow> {
  const deadline = Date.now() + timeoutMs;
  let last: NetworkRow | undefined;
  while (Date.now() < deadline) {
    last = await fetchNetworkRow(token, slug).catch(() => undefined);
    if (last !== undefined && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `waitForNetworkRow: ${slug} never reached "${label}" in ${timeoutMs}ms — last row ${JSON.stringify(last)}`,
  );
}

// Unique per invocation so the spec survives `--repeat-each` and so a
// leftover row from a crashed run can never be mistaken for this one's.
function ephemeralNames(tag: string): { slug: string; nick: string } {
  const stamp = Date.now();
  return { slug: `e2e1675-${tag}-${stamp}`, nick: `f${stamp % 1_000_000}` };
}

test("#1675 — a network whose upstream refuses every connect reads `failing`, and cic names the cause", async ({
  page,
}) => {
  // ~35s to attempt 2 (the first one is eaten — see the ladder above), then
  // the shell boot, with margin for a loaded testnet.
  test.setTimeout(180_000);

  const admin = getSeededAdmin();
  const adminUserId = userIdFromSubject(admin.subjectJson);
  const { slug, nick } = ephemeralNames("dead");
  let networkId: number | null = null;

  try {
    networkId = await createNetwork(admin.token, slug);
    await addServer(admin.token, networkId, DEAD_HOST, DEAD_PORT_A, 0);
    await bindCredential(admin.token, adminUserId, networkId, nick);

    // The row of record. One dead leaf means every rung of the ladder
    // refuses, so once it arrives this state is stable, not a flash — but
    // it arrives on attempt 2, at 30s throttle + a ~5s rung. 75s is that
    // ladder with the jitter, not a safety margin.
    const failing = await waitForNetworkRow(
      admin.token,
      slug,
      (r) => r.connection_state === "failing",
      75_000,
      "failing",
    );

    // The reason is the half the operator had no way to see: it must be
    // written AND it must name the actual cause, not a category label.
    const reason = failing.connection_state_reason ?? "";
    expect(reason).not.toBe("");
    expect(reason).toMatch(/connection refused/i);

    // Pre-state for the sibling test's recovery oracle: nothing registered.
    expect(failing.connection?.registered ?? false).toBe(false);

    // …and now the half an API assertion cannot discharge. Log in and read
    // the row the way the operator does.
    await adminLogin(page, admin);

    const row = page.locator(".home-pane-network-row-failing", {
      has: page.locator(".home-pane-network-slug", { hasText: slug }),
    });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await expect(row.locator(".home-pane-network-state")).toHaveText("failing");
    // The SAME string the API returned — the display is not a paraphrase.
    await expect(row.locator(".home-pane-network-reason")).toHaveText(reason);
  } finally {
    if (networkId !== null) {
      await unbindCredentialBestEffort(admin.token, adminUserId, networkId);
      await deleteNetworkBestEffort(admin.token, networkId);
    }
  }
});

test("#1675 — a failing row returns to `connected` with the reason cleared once a leaf registers", async () => {
  // Attempt 1 marks `:failing` at ~35s, attempt 2 reaches the live leaf at
  // ~80s (2×30s throttle + a 5s and a 10s rung), then registration. ~95s of
  // ladder; the ceiling carries the jitter and a loaded ircd.
  test.setTimeout(300_000);

  const admin = getSeededAdmin();
  const adminUserId = userIdFromSubject(admin.subjectJson);
  const { slug, nick } = ephemeralNames("heal");
  let networkId: number | null = null;

  try {
    networkId = await createNetwork(admin.token, slug);
    await addServer(admin.token, networkId, DEAD_HOST, DEAD_PORT_A, 0);
    await addServer(admin.token, networkId, DEAD_HOST, DEAD_PORT_B, 1);
    await addServer(admin.token, networkId, LIVE_HOST, LIVE_PORT, 2);
    await bindCredential(admin.token, adminUserId, networkId, nick);

    // Attempt 1 (attempt 0's failure is eaten by the `:parked` window) hits
    // the SECOND dead leaf while the row already reads `:connected`, so this
    // is where `:failing` is finally written. ~35s of ladder.
    const failing = await waitForNetworkRow(
      admin.token,
      slug,
      (r) => r.connection_state === "failing",
      75_000,
      "failing",
    );
    expect(failing.connection_state_reason ?? "").toMatch(/connection refused/i);

    // `registered === true` is the load-bearing conjunct. `:connected`
    // alone would be a vacuous oracle — `Networks.connect/1` writes it on
    // spawn success — whereas the live `connection` projection only reports
    // registered once 001 RPL_WELCOME landed, which is the event
    // `mark_registered/1` hangs off.
    const recovered = await waitForNetworkRow(
      admin.token,
      slug,
      (r) => r.connection_state === "connected" && r.connection?.registered === true,
      180_000,
      "connected + registered",
    );
    expect(recovered.connection_state_reason).toBeNull();

    // The failure also had to reach the `$server` window — the issue's last
    // line, and the durable half: a row survives the recovery that cleared
    // `connection_state_reason`, so the operator can still see WHY the
    // network was down after it came back.
    const serverRows = await fetchAllMessagesAsc(admin.token, slug, "$server");
    const causes = serverRows.filter((m) =>
      /upstream connect failed: connection refused/.test(m.body ?? ""),
    );
    expect(causes.length).toBeGreaterThan(0);
  } finally {
    if (networkId !== null) {
      await unbindCredentialBestEffort(admin.token, adminUserId, networkId);
      await deleteNetworkBestEffort(admin.token, networkId);
    }
  }
});
