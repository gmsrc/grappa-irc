// #1759c — does a CROSS-USER reconnect storm saturate the connection pool,
// and if so at what N?
//
// ## Why this exists, and why it could not be an Elixir test
//
// #1759's working premise was that one account with W windows produces W
// SIMULTANEOUS `join_reply` computations. That premise is dead: the transport
// blocks inside one join until the channel answers
// (`phoenix/lib/phoenix/socket.ex:739` → `channel/server.ex:40-52`, a bare
// `receive` with ZERO `after` → `:315-319`, which replies only after
// `join/3` returns). Per CONNECTION there is at most ONE join in flight.
//
// But every connection has its OWN transport process, and the pool is a NODE
// resource. So if the saturation is real it has to be CROSS-USER — N distinct
// subjects reconnecting together — and nobody has measured that.
//
// `Phoenix.Test.ChannelTest` cannot answer it: it pins `transport_pid: self()`
// and calls `Channel.Server.join/4` straight from the test process, so it
// reports "serial" by construction whatever the truth is. An instrument that
// cannot fail earns no green. This needs REAL, CONCURRENT WebSockets, which
// is why it lives here and drives raw sockets in a page (the same move
// `issue95-ws-token-subprotocol.spec.ts` makes) rather than booting N copies
// of cic — the server cannot tell the two apart, and N browser contexts would
// buy nothing but wall-clock.
//
// ## What is measured, and with what
//
// No new instrumentation. `Grappa.DbLatency` already accumulates Ecto's
// `queue_time` and counts `contention.queue_timeout` — a checkout the pool
// could not serve, which IS saturation rather than a proxy for it — and
// `GrappaWeb.Admin.DbLatencyController` already exposes both with a reset.
// The cycle is reset → drive the burst → snapshot.
//
// ## Displacement, not correlation
//
// Two levers move, and the reading must follow them or the hypothesis dies:
//
//   * **N** (concurrent subjects) — stepped over a ladder inside one run;
//   * **`pool_size`** — 5 and 10, supplied by the harness through
//     `POOL_SIZE` (see the `#1759c` lever in `config/dev.exs`). If the
//     saturation point tracks the pool, the mechanism is the pool. If it does
//     not move, the pool is not the bottleneck and that is a RESULT.
//
// A single reading at a single pool size cannot separate those two, which is
// the whole reason the lever was added.
//
// ## Declared limits — read these before quoting any number
//
//   * **The per-join cost here is a FLOOR.** The windows these sockets join
//     carry no seeded scrollback and no read cursor, so `join_reply/2` does
//     less arithmetic than a real window does (the same caveat
//     `GrappaWeb.JoinSeedCostTest`'s cheap arm carries). Saturation seen at
//     the floor is a strong positive; saturation NOT seen at the floor does
//     not clear a seeded storm.
//   * **The host is noisy** — this machine permanently carries unrelated
//     load. That is a limit on the numbers, and it is NOT offered as an
//     explanation of them.
//   * **N is bounded by what the testnet tolerates**, not by the question.
//     If the ladder runs out before saturation, the report says so; it does
//     not extrapolate.

import { GRAPPA_BASE_URL, login, mintVisitor } from "../fixtures/grappaApi";
import { ADMIN_IDENTIFIER, ADMIN_PASSWORD } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// Raw WebSocket construction needs a real socket engine; the iPhone project
// adds nothing to a server-side pool measurement.
test.describe.configure({ mode: "serial" });

// The ladder. Powers of two so a linear and a knee-shaped response are
// distinguishable with few points, and three points minimum because two can
// be joined by any line.
//
// It runs to 32 because the question is "at what N", and a ladder that stops
// before the answer produces "not at any N we tried" — true, but weaker than
// it needs to be. 24 is in there for resolution: the first reading knee'd
// between 8 and 16, so a doubling-only ladder would place any second knee
// only to within a factor of two.
const N_LADDER = [1, 2, 4, 8, 16, 24, 32] as const;

// Windows per subject. Held CONSTANT across the ladder on purpose: N is the
// lever under test here, and moving both at once would make the response
// unattributable.
const W = 8;

const BURST_TIMEOUT_MS = 60_000;

type Contention = {
  n: number;
  queue_timeout: number;
  busy_locked: number;
  interrupted?: number;
  dropped: number;
};

type QueryRow = { source: string | null; op: string; n: number; queue_ms: number };

type Snapshot = { queries: QueryRow[]; contention: Contention };

type BurstResult = {
  socketsOpened: number;
  socketsFailed: number;
  joinsOk: number;
  joinsFailed: number;
  // The concurrency the CLIENT observed: the high-water mark of sockets
  // simultaneously open. Without this the run could have been serial and the
  // whole measurement would be answering a different question.
  maxConcurrentOpen: number;
  elapsedMs: number;
};

async function adminToken(): Promise<string> {
  const { token } = await login(ADMIN_IDENTIFIER, ADMIN_PASSWORD);
  return token;
}

async function resetLatency(token: string): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/db_latency/reset`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status !== 204) {
    throw new Error(`db_latency reset → ${res.status} ${await res.text()}`);
  }
}

async function snapshot(token: string): Promise<Snapshot> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/db_latency`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`db_latency → ${res.status} ${await res.text()}`);
  return (await res.json()) as Snapshot;
}

function totalQueueMs(snap: Snapshot): number {
  return snap.queries.reduce((acc, q) => acc + (q.queue_ms ?? 0), 0);
}

function totalQueries(snap: Snapshot): number {
  return snap.queries.reduce((acc, q) => acc + (q.n ?? 0), 0);
}

// Opens `sockets.length` real WebSockets from the page, waits for every one
// to be OPEN, and only then fires every join — so the burst is a burst and
// not a staircase. Returns what the client itself observed, which is the only
// place the concurrency can be witnessed.
//
// The Phoenix v2 transport frame is `[join_ref, ref, topic, event, payload]`.
//
// The handshake is copied from the library rather than from the prose about
// it. `phoenix/priv/static/phoenix.mjs:1353` builds
//
//     ["phoenix", `base64url.bearer.phx.${btoa(token).replace(/=/g, "")}`]
//
// and all three details are load-bearing: TWO protocols with `"phoenix"`
// FIRST, and the token base64'd with its `=` padding stripped. A first
// attempt here passed one protocol carrying the RAW token — the shape the
// #95 comments describe in words — and every handshake was refused, which
// C3a below now names in one line instead of leaving it as "0 joins".
const BURST = ({
  sockets,
  timeoutMs,
}: {
  sockets: Array<{ token: string; topics: string[] }>;
  timeoutMs: number;
}) =>
  new Promise<BurstResult>((resolve) => {
    const started = performance.now();
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${scheme}//${location.host}/socket/websocket?vsn=2.0.0`;

    let opened = 0;
    let failed = 0;
    let concurrentOpen = 0;
    let maxConcurrentOpen = 0;
    let joinsOk = 0;
    let joinsFailed = 0;
    const expectedJoins = sockets.reduce((acc, s) => acc + s.topics.length, 0);
    const live: WebSocket[] = [];

    const finish = () => {
      for (const ws of live) {
        try {
          ws.close();
        } catch {
          /* the socket is already gone; nothing to report */
        }
      }
      resolve({
        socketsOpened: opened,
        socketsFailed: failed,
        joinsOk,
        joinsFailed,
        maxConcurrentOpen,
        elapsedMs: Math.round(performance.now() - started),
      });
    };

    const timer = setTimeout(finish, timeoutMs);

    const maybeDone = () => {
      const allAnswered = joinsOk + joinsFailed >= expectedJoins;
      const nothingOpened = opened === 0 && opened + failed >= sockets.length;
      if (allAnswered || nothingOpened) {
        clearTimeout(timer);
        finish();
      }
    };

    // Fire every join only once EVERY socket is open. A staircase would
    // measure N sequential single-socket bursts, which is the shape this
    // spec exists to distinguish itself from.
    const fireAll = () => {
      sockets.forEach((spec, i) => {
        const ws = live[i];
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        spec.topics.forEach((topic, j) => {
          const ref = String(i * 1000 + j);
          ws.send(JSON.stringify([ref, ref, topic, "phx_join", {}]));
        });
      });
    };

    sockets.forEach((spec, i) => {
      const ws = new WebSocket(url, [
        "phoenix",
        `base64url.bearer.phx.${btoa(spec.token).replace(/=/g, "")}`,
      ]);
      live[i] = ws;

      ws.onopen = () => {
        opened += 1;
        concurrentOpen += 1;
        maxConcurrentOpen = Math.max(maxConcurrentOpen, concurrentOpen);
        if (opened + failed === sockets.length) fireAll();
      };

      ws.onclose = () => {
        concurrentOpen = Math.max(0, concurrentOpen - 1);
      };

      ws.onerror = () => {
        failed += 1;
        if (opened + failed === sockets.length) {
          if (opened > 0) fireAll();
          else maybeDone();
        }
      };

      ws.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as [
          string | null,
          string | null,
          string,
          string,
          { status?: string },
        ];
        if (frame[3] !== "phx_reply") return;
        if (frame[4]?.status === "ok") joinsOk += 1;
        else joinsFailed += 1;
        maybeDone();
      };
    });
  });

test("#1759c — cross-user join storm vs the connection pool", async ({ page }) => {
  const token = await adminToken();
  const poolSize = Number(process.env.POOL_SIZE ?? "5");

  // Land on the origin so the page's WebSockets are same-origin and reach the
  // BEAM through the same edge a real client uses.
  await page.goto("/");

  // ---------------------------------------------------------------------
  // Known-answer controls. Every one of these must hold BEFORE any number
  // is believed; the run reports nothing if one fails.
  // ---------------------------------------------------------------------

  // C1 — the reset door actually zeroes. Without this a "saturation" reading
  // could be an aggregate accumulated since boot by unrelated specs.
  await resetLatency(token);
  const zeroed = await snapshot(token);
  expect(
    zeroed.contention.queue_timeout,
    "C1: POST /admin/db_latency/reset did not zero the contention counters — every number below would be an aggregate of somebody else's load",
  ).toBe(0);

  // Provision the whole cohort ONCE, SEQUENTIALLY, and slice it per rung.
  //
  // Both properties were bought with a failed run, and neither is tidiness.
  //
  // SEQUENTIALLY: minting in parallel is itself a write storm — each mint
  // logs a visitor in AND spawns a live IRC session — and at `pool_size=5`
  // the FOURTH concurrent mint came back `503 {"error":"db_unavailable"}`
  // before the join burst had started. That is a real observation about
  // cross-user concurrency, but it belongs to the PROVISIONING door, not the
  // join door this file is measuring, and leaving it in would have let a
  // setup confound masquerade as the result. It is reported as its own
  // finding rather than engineered out of sight.
  //
  // ONCE: the ladder would otherwise mint 1+2+4+8+16 = 31 visitors and open
  // 31 IRC sessions to bring 16 subjects to the bench. Reusing one cohort
  // also holds the SUBJECTS fixed across rungs, so N is the only thing that
  // moves — which is what makes the response attributable to N.
  const cohort = [];
  for (let i = 0; i < Math.max(...N_LADDER); i++) {
    cohort.push(await mintVisitor(`s1759-${poolSize}-${i}-${Date.now() % 100000}`));
  }

  const rows: string[] = [];

  for (const n of N_LADDER) {
    const visitors = cohort.slice(0, n);

    const sockets = visitors.map((v) => ({
      token: v.token,
      // A visitor's topic segment is `visitor:<id>` (`UserSocket`
      // `assign_subject/2`), NOT the nick — read from the server, not guessed.
      topics: Array.from(
        { length: W },
        (_, w) => `grappa:user:visitor:${v.id}/network:${v.network_slug}/channel:%23s1759-${w}`,
      ),
    }));

    await resetLatency(token);
    const burst: BurstResult = await page.evaluate(BURST, {
      sockets,
      timeoutMs: BURST_TIMEOUT_MS,
    });
    const snap = await snapshot(token);

    // C2 — the instrument SAW the door. A zero here is an instrument fault
    // (wrong topic, rejected join, counters not wired) and is indistinguishable
    // from "the door is free", which is the exact false green to avoid.
    expect(
      totalQueries(snap),
      `C2 at N=${n}: the burst produced ZERO queries — the joins never reached join_reply/2, so this is an instrument fault and not a free door`,
    ).toBeGreaterThan(0);

    // C3a — the sockets HANDSHOOK. Split out from C3 because the two fail
    // for completely different reasons and the combined form hid it: the
    // first run of this file reported "expected 8 acknowledged joins, saw 0"
    // when the truth was that not one socket had opened, because the bearer
    // subprotocol was built by hand instead of copied from phoenix.js. A
    // control that names the wrong layer costs a whole run.
    expect(
      burst.socketsOpened,
      `C3a at N=${n}: ${burst.socketsFailed} of ${n} WebSocket handshake(s) were refused — the bearer subprotocol or the origin is wrong, and nothing about the pool has been measured`,
    ).toBe(n);

    // C3 — every join was acknowledged. A burst whose joins were refused did
    // not happen, and its queue reading would describe nothing.
    expect(
      burst.joinsFailed,
      `C3 at N=${n}: ${burst.joinsFailed} join(s) were refused — the storm did not occur as described`,
    ).toBe(0);
    expect(
      burst.joinsOk,
      `C3 at N=${n}: expected ${n * W} acknowledged joins, saw ${burst.joinsOk}`,
    ).toBe(n * W);

    // C4 — the sockets were genuinely CONCURRENT. This is the control that
    // separates this measurement from the serial one already refuted: if the
    // high-water mark is 1, the run answered the wrong question.
    expect(
      burst.maxConcurrentOpen,
      `C4 at N=${n}: high-water concurrency was ${burst.maxConcurrentOpen}, so the sockets did not overlap and this is not a cross-user measurement`,
    ).toBe(n);

    rows.push(
      [
        `pool=${poolSize}`,
        `N=${n}`,
        `W=${W}`,
        `joins=${burst.joinsOk}`,
        `concurrent=${burst.maxConcurrentOpen}`,
        `elapsed_ms=${burst.elapsedMs}`,
        `queries=${totalQueries(snap)}`,
        `queue_ms=${totalQueueMs(snap).toFixed(1)}`,
        `queue_timeout=${snap.contention.queue_timeout}`,
        `busy_locked=${snap.contention.busy_locked}`,
        `dropped=${snap.contention.dropped}`,
      ].join("  "),
    );
  }

  // The reading. Printed only once every control above has held for every
  // rung, so a number that appears here is one the instrument earned.
  console.log(`\n#1759c MEASUREMENT (pool_size=${poolSize}, W=${W})\n${rows.join("\n")}\n`);
});
