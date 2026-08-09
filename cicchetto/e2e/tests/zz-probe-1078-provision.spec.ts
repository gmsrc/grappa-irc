// THROWAWAY measurement probe for #1078 — not for merge.
//
// Question it answers: what does option (A) — a fresh subject per spec —
// COST per test, compared with the truncate+re-seed reset it replaces?
//
// It provisions and tears down N complete subjects using ONLY endpoints
// that already exist (POST /admin/users, POST /admin/credentials,
// POST /auth/login, POST /admin/test/reset-subject as the seed+spawn+
// autojoin tail, DELETE /admin/credentials, DELETE /admin/users), timing
// each leg. So it measures the cost AND proves the claim that (A) needs
// no new server surface to provision a subject.
//
// Emits one `__PROVISIONCOST__` tab-separated line per iteration.

import { expect, test } from "@playwright/test";
import { GRAPPA_BASE_URL, login } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";

const NETWORK_ID = 1; // bahamut-test in the e2e seeder
const NETWORK_SLUG = "bahamut-test";
const PASSWORD = "test-password-not-secret";
const SEED_COUNT = 200;
const ITERATIONS = 6;

async function timed<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const t0 = performance.now();
  const out = await fn();
  return [Math.round(performance.now() - t0), out];
}

test("PROBE: cost of provisioning + tearing down a fresh subject", async () => {
  test.setTimeout(300_000);
  const admin = getSeededAdmin();
  const authed = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${admin.token}`,
  };

  for (let i = 0; i < ITERATIONS; i++) {
    const name = `p1078x${i}`;
    const nick = `p78x${i}`;
    const channel = `#p1078x${i}`;

    const [createMs, userId] = await timed(async () => {
      const res = await fetch(`${GRAPPA_BASE_URL}/admin/users`, {
        method: "POST",
        headers: authed,
        body: JSON.stringify({ name, password: PASSWORD }),
      });
      expect(res.status, `create ${name}`).toBe(201);
      return ((await res.json()) as { id: string }).id;
    });

    const [bindMs] = await timed(async () => {
      const res = await fetch(`${GRAPPA_BASE_URL}/admin/credentials`, {
        method: "POST",
        headers: authed,
        body: JSON.stringify({
          user_id: userId,
          network_id: NETWORK_ID,
          nick,
          auth_method: "none",
          autojoin_channels: [channel],
        }),
      });
      expect(res.status, `bind ${nick}`).toBe(201);
    });

    // The seed + spawn + WELCOME + autojoin tail. This is exactly the work
    // the existing per-test reset already does; reusing the endpoint keeps
    // the two numbers comparable leg-for-leg.
    const [seedSpawnMs, phases] = await timed(async () => {
      const res = await fetch(`${GRAPPA_BASE_URL}/admin/test/reset-subject`, {
        method: "POST",
        headers: authed,
        body: JSON.stringify({
          user_name: name,
          baseline_autojoin: { [NETWORK_SLUG]: [channel] },
          baseline_seed: {
            [NETWORK_SLUG]: [{ name: channel, seed_count: SEED_COUNT, seed_sender: "seed-bot" }],
          },
        }),
      });
      expect(res.status, `seed+spawn ${name}: ${await res.text()}`).toBe(204);
      return res.headers.get("x-grappa-reset-phases") ?? "";
    });

    const [loginMs] = await timed(async () => {
      await login(`${name}@grappa.test`, PASSWORD);
    });

    const [unbindMs] = await timed(async () => {
      const res = await fetch(`${GRAPPA_BASE_URL}/admin/credentials/${userId}/${NETWORK_ID}`, {
        method: "DELETE",
        headers: authed,
      });
      expect(res.status, `unbind ${nick}`).toBe(204);
    });

    const [deleteMs] = await timed(async () => {
      const res = await fetch(`${GRAPPA_BASE_URL}/admin/users/${userId}`, {
        method: "DELETE",
        headers: authed,
      });
      expect(res.status, `delete ${name}`).toBe(204);
    });

    const total = createMs + bindMs + seedSpawnMs + loginMs + unbindMs + deleteMs;
    process.stderr.write(
      `__PROVISIONCOST__\t${i}\tcreate=${createMs}\tbind=${bindMs}\tseedspawn=${seedSpawnMs}\t` +
        `login=${loginMs}\tunbind=${unbindMs}\tdelete=${deleteMs}\ttotal=${total}\t${phases}\n`,
    );
  }
});
