import { describe, expect, it } from "vitest";
import {
  type AdminSubjectRow,
  buildSubjectRows,
  channelCount,
  DEFAULT_SESSION_SORT,
  endedSessions,
  liveSessions,
  rowActions,
  rowKey,
  sortSubjectRows,
} from "../lib/adminSubjectRows";
import type {
  AdminCredential,
  AdminNetwork,
  AdminSession,
  AdminSessionLogEntry,
  AdminVisitor,
} from "../lib/api";

// #1157 — the merge behind the unified admin sessions view.
//
// The property under test throughout is the one the whole design turns
// on: a row with NO live pid must still appear. `/admin/sessions` is
// registry-driven, so anything built on it alone loses parked, failed
// and expired-but-unreaped subjects — the exact population the operator
// opens the pane to inspect.

const live = (over: Partial<NonNullable<AdminVisitor["networks"][0]["live_state"]>> = {}) => ({
  nick: "vjt",
  alive: true,
  pid_inspect: "#PID<0.123.0>",
  mailbox_len: 0,
  memory_bytes: 12_345,
  joined_channels: ["#sbiffo", "#bofh"],
  introspection_degraded: [],
  ...over,
});

const VISITOR_ID = "0f2a7c1e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const USER_ID = "11111111-1111-1111-1111-111111111111";

const visitor = (over: Partial<AdminVisitor> = {}): AdminVisitor =>
  ({
    id: VISITOR_ID,
    expires_at: "2026-08-20T00:00:00Z",
    identified: false,
    ip: "10.0.0.5",
    // #1308 — deliberately NOT `ip`: the identity-wide address and the
    // newest session's are different facts, and a fixture that made them
    // equal could not tell which one the row carried.
    session_ip: "203.0.113.9",
    inserted_at: "2026-08-01T00:00:00Z",
    last_seen_at: "2026-08-10T00:00:00Z",
    networks: [
      {
        network_slug: "azzurra",
        network_id: 42,
        nick: "guest1",
        connection_state: "connected",
        live_state: live(),
      },
    ],
    ...over,
  }) as AdminVisitor;

const credential = (over: Partial<AdminCredential> = {}): AdminCredential =>
  ({
    user_id: USER_ID,
    network_id: 42,
    network_slug: "azzurra",
    nick: "vjt",
    ident: "grp",
    realname: null,
    sasl_user: null,
    auth_method: "sasl",
    auth_command_template: null,
    autojoin_channels: [],
    last_joined_channels: [],
    connection_state: "connected",
    connection_state_reason: null,
    connection_state_changed_at: null,
    inserted_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    last_seen_at: "2026-08-09T00:00:00Z",
    session_ip: "198.51.100.7",
    live_state: null,
    ...over,
  }) as AdminCredential;

const session = (over: Partial<AdminSession> = {}): AdminSession =>
  ({
    subject_kind: "visitor",
    subject_id: VISITOR_ID,
    subject_label: "guest1",
    last_seen_at: "2026-08-10T00:00:00Z",
    network_id: 42,
    live_state: {
      ...live(),
      peer_address: "203.0.113.5",
      peer_port: 6697,
      peer_name: "irc.azzurra.org",
    },
    ...over,
  }) as AdminSession;

const network = (over: Partial<AdminNetwork> = {}): AdminNetwork =>
  ({ id: 42, slug: "azzurra", ...over }) as AdminNetwork;

const logEntry = (over: Partial<AdminSessionLogEntry> = {}): AdminSessionLogEntry =>
  ({
    id: 1,
    session_id: `visitor:${VISITOR_ID}:42`,
    event: "disconnected",
    subject_kind: "visitor",
    network_id: 42,
    network_slug: "azzurra",
    nick: "guest1",
    old_nick: null,
    reason: ":quit",
    clean: true,
    duration_ms: 900,
    delay_ms: null,
    attempt: null,
    at: "2026-08-10T12:00:00Z",
    ...over,
  }) as AdminSessionLogEntry;

const build = (over: Partial<Parameters<typeof buildSubjectRows>[0]> = {}): AdminSubjectRow[] =>
  buildSubjectRows({
    visitors: [],
    credentials: [],
    sessions: [],
    networks: [network()],
    logSessions: [],
    ...over,
  });

describe("buildSubjectRows — the row set is row-backed, not registry-backed", () => {
  // THE test. A parked visitor has no registry entry, so it is absent
  // from /admin/sessions; if the merge lost it, the admin console would
  // stop showing the population it exists to show.
  it("keeps a parked visitor that has no live session at all", () => {
    const parked = visitor({
      networks: [
        {
          network_slug: "azzurra",
          network_id: 42,
          nick: "guest1",
          connection_state: "parked",
          live_state: null,
        },
      ],
    });

    const rows = build({ visitors: [parked], sessions: [] });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.live).toBeNull();
    expect(rows[0]?.connection_state).toBe("parked");
  });

  it("keeps a failed credential that has no live session at all", () => {
    const rows = build({
      credentials: [credential({ connection_state: "failed", live_state: null })],
      sessions: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.connection_state).toBe("failed");
    expect(rows[0]?.live).toBeNull();
  });

  it("keeps an expired-but-unreaped visitor", () => {
    const rows = build({ visitors: [visitor({ expires_at: "2020-01-01T00:00:00Z" })] });

    expect(rows[0]?.visitor?.expires_at).toBe("2020-01-01T00:00:00Z");
  });

  it("flattens a multi-network visitor into one row per network", () => {
    const multi = visitor({
      networks: [
        {
          network_slug: "azzurra",
          network_id: 42,
          nick: "guest1",
          connection_state: "connected",
          live_state: live(),
        },
        {
          network_slug: "libera",
          network_id: 43,
          nick: "guest1_",
          connection_state: "parked",
          live_state: null,
        },
      ],
    });

    const rows = build({ visitors: [multi] });

    expect(rows.map((r) => r.network_slug)).toEqual(["azzurra", "libera"]);
    // Identity facts repeat: they belong to the visitor, not the network.
    expect(rows.every((r) => r.visitor?.visitor_id === VISITOR_ID)).toBe(true);
  });
});

describe("buildSubjectRows — the /admin/sessions left join", () => {
  it("joins the upstream peer onto the matching row", () => {
    const rows = build({ visitors: [visitor()], sessions: [session()] });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.upstream?.peer_address).toBe("203.0.113.5");
  });

  it("leaves upstream null on a row with no registry entry", () => {
    const rows = build({ credentials: [credential()], sessions: [] });

    expect(rows[0]?.upstream).toBeNull();
  });

  it("does NOT duplicate a row that the join matched", () => {
    const rows = build({ visitors: [visitor()], sessions: [session()] });

    expect(rows).toHaveLength(1);
  });

  it("appends an orphan pid whose DB row is gone, rather than dropping it", () => {
    const orphan = session({
      subject_id: "deadbeef-0000-0000-0000-000000000000",
      subject_label: null,
    });

    const rows = build({ visitors: [visitor()], sessions: [session(), orphan] });

    expect(rows).toHaveLength(2);
    const last = rows[rows.length - 1];
    expect(last?.label).toBeNull();
    // No credential behind it, so there is no DB intent to report. `null`
    // here is the honest answer, NOT a defaulted "connected".
    expect(last?.connection_state).toBeNull();
  });

  it("resolves an orphan row's network slug from the networks list", () => {
    const orphan = session({ subject_id: "deadbeef-0000-0000-0000-000000000000" });

    const rows = build({ sessions: [orphan], networks: [network()] });

    expect(rows[0]?.network_slug).toBe("azzurra");
  });

  it("reports a null slug when the network FK resolves to nothing", () => {
    const orphan = session({ subject_id: "deadbeef-0000-0000-0000-000000000000", network_id: 999 });

    const rows = build({ sessions: [orphan], networks: [network()] });

    expect(rows[0]?.network_slug).toBeNull();
  });

  it("keys every row with the composite the admin verbs parse", () => {
    const rows = build({ visitors: [visitor()], credentials: [credential()] });

    expect(rows.map((r) => r.key)).toEqual([`visitor:${VISITOR_ID}:42`, `user:${USER_ID}:42`]);
  });

  it("does not confuse a user and a visitor sharing a network", () => {
    const rows = build({ visitors: [visitor()], credentials: [credential()] });

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });
});

// #1308 — the source address. The user half is the new fact: before this
// the row type had no field for it at all, so a user row could show no
// address anywhere, and the only one the console had was the visitor
// identity's.
describe("buildSubjectRows — the per-session source address", () => {
  it("carries the newest session's address onto a USER row", () => {
    const rows = build({ credentials: [credential()] });

    expect(rows[0]?.session_ip).toBe("198.51.100.7");
  });

  it("carries it onto a VISITOR row without collapsing it into the identity ip", () => {
    const rows = build({ visitors: [visitor()] });

    // Both, and different: `ip` says where the identity was born,
    // `session_ip` where this session comes from. One value standing in
    // for the other is the mistake the pair exists to prevent.
    expect(rows[0]?.session_ip).toBe("203.0.113.9");
    expect(rows[0]?.visitor?.ip).toBe("10.0.0.5");
  });

  it("reports null on an orphan pid rather than the upstream peer address", () => {
    const orphan = session({ subject_id: "deadbeef-0000-0000-0000-000000000000" });

    const rows = build({ sessions: [orphan] });

    // `203.0.113.5` IS on this row — as `upstream.peer_address`, the IRC
    // server the bouncer dialled. Reporting it as the client's address
    // would be a lie, so the honest answer is that we do not have one.
    expect(rows[0]?.upstream?.peer_address).toBe("203.0.113.5");
    expect(rows[0]?.session_ip).toBeNull();
  });

  it("reports null on a log-only row, whose subject is gone", () => {
    const rows = build({ logSessions: [logEntry()] });

    expect(rows[0]?.origin).toBe("session_log");
    expect(rows[0]?.session_ip).toBeNull();
  });

  it("passes a missing address through as null instead of inventing one", () => {
    const rows = build({ credentials: [credential({ session_ip: null })] });

    expect(rows[0]?.session_ip).toBeNull();
  });
});

// #1158 item 4 — a session whose subject row was destroyed. vjt's ruling
// (2026-08-11) is "keep only the event": visitor retention is unchanged,
// so an anon visitor is still purged at logout and reaped at TTL, and the
// ONLY trace left is `session_log_events` — which has no FK to the
// subject and therefore survives the CASCADE. The log is keyed on the
// same `<kind>:<id>:<network>` composite the rows are, so it both joins
// onto live rows and supplies rows nothing else can.
describe("buildSubjectRows — the session-log join", () => {
  it("joins the newest logged event onto a row that still exists", () => {
    const rows = build({ visitors: [visitor()], logSessions: [logEntry()] });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.last_event?.event).toBe("disconnected");
    expect(rows[0]?.last_event?.duration_ms).toBe(900);
    // The row is still credential-backed: the log adds history, it does
    // not reclassify a subject that is very much on record.
    expect(rows[0]?.origin).toBe("credential");
  });

  it("leaves last_event null when the log remembers nothing — absence is not an error", () => {
    const rows = build({ credentials: [credential()], logSessions: [] });

    expect(rows[0]?.last_event).toBeNull();
  });

  // THE test for item 4. Without this row the operator has no way to see
  // that a purged visitor ever held a session.
  it("appends a session the log remembers but no subject row does", () => {
    const rows = build({ credentials: [credential()], logSessions: [logEntry()] });

    expect(rows).toHaveLength(2);
    const ghost = rows[rows.length - 1];
    expect(ghost?.origin).toBe("session_log");
    expect(ghost?.key).toBe(`visitor:${VISITOR_ID}:42`);
    expect(ghost?.subject_kind).toBe("visitor");
    expect(ghost?.label).toBe("guest1");
    expect(ghost?.network_slug).toBe("azzurra");
    // Neither source of truth has anything to say: no credential to hold
    // an intent, no pid to be alive. Both null, neither defaulted.
    expect(ghost?.connection_state).toBeNull();
    expect(ghost?.live).toBeNull();
  });

  it("does not duplicate a row the log matched", () => {
    const rows = build({ visitors: [visitor()], logSessions: [logEntry()] });

    expect(rows).toHaveLength(1);
  });

  it("does not swallow an orphan pid that the log also remembers", () => {
    const orphan = session({ subject_id: "deadbeef-0000-0000-0000-000000000000" });
    const rows = build({
      sessions: [orphan],
      logSessions: [logEntry({ session_id: "visitor:deadbeef-0000-0000-0000-000000000000:42" })],
    });

    // One row, and it keeps the live pid — the log enriches it rather
    // than shadowing it with a historical duplicate.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.origin).toBe("orphan_pid");
    expect(rows[0]?.live).not.toBeNull();
    expect(rows[0]?.last_event?.event).toBe("disconnected");
  });

  it("ignores a log entry whose session_id is not the row composite", () => {
    const rows = build({ logSessions: [logEntry({ session_id: "nonsense" })] });

    expect(rows).toHaveLength(0);
  });

  it("carries a log-only row for a deleted USER too, not just visitors", () => {
    const rows = build({
      logSessions: [
        logEntry({ session_id: `user:${USER_ID}:42`, subject_kind: "user", nick: "vjt" }),
      ],
    });

    expect(rows[0]?.subject_kind).toBe("user");
    expect(rows[0]?.origin).toBe("session_log");
  });
});

// #1224 — the merge stays one row set; the VIEW is what splits. vjt
// ruled that ended sessions move to a sub-page of Sessions and the list
// that stays is strictly live, so these two functions are what each
// screen renders.
describe("liveSessions / endedSessions — the partition", () => {
  const both = (): AdminSubjectRow[] =>
    build({ visitors: [visitor()], logSessions: [logEntry({ session_id: "visitor:gone:42" })] });

  it("sends the log-only row to the ended list and nothing else", () => {
    const rows = both();

    expect(rows).toHaveLength(2);
    expect(endedSessions(rows).map((r) => r.key)).toEqual(["visitor:gone:42"]);
  });

  it("leaves every row with a subject or a pid in the live list", () => {
    const rows = both();

    expect(liveSessions(rows).map((r) => r.origin)).toEqual(["credential"]);
  });

  // A partition, not two filters: every row lands in exactly one list, so
  // a class nobody thought about cannot fall off both screens.
  it("puts each row in exactly one of the two", () => {
    const rows = build({
      visitors: [visitor()],
      credentials: [credential()],
      sessions: [session({ subject_id: "deadbeef-0000-0000-0000-000000000000" })],
      logSessions: [logEntry({ session_id: "visitor:gone:42" })],
    });

    const keys = [...liveSessions(rows), ...endedSessions(rows)].map((r) => r.key);
    expect(new Set(keys).size).toBe(rows.length);
    expect(keys).toHaveLength(rows.length);
  });

  // The narrowing is the reason the sub-page needs no null guard: the
  // pass that builds a log-only row builds it FROM the entry.
  it("hands the ended list rows whose event is not nullable", () => {
    const [ended] = endedSessions(both());

    expect(ended?.last_event.event).toBe("disconnected");
  });
});

describe("channelCount — an unknown count is not zero", () => {
  const rowWith = (l: AdminSubjectRow["live"]): AdminSubjectRow =>
    ({ ...build({ credentials: [credential()] })[0], live: l }) as AdminSubjectRow;

  it("counts the joined channels", () => {
    expect(channelCount(rowWith(live()))).toBe(2);
  });

  it("is null when introspection timed out, not 0", () => {
    expect(channelCount(rowWith(live({ joined_channels: null })))).toBeNull();
  });

  it("is null when there is no live session, not 0", () => {
    expect(channelCount(rowWith(null))).toBeNull();
  });

  it("is 0 for a live session that has joined nothing", () => {
    expect(channelCount(rowWith(live({ joined_channels: [] })))).toBe(0);
  });
});

describe("rowActions — reconnect is visitor-only, and chosen on LIVE truth", () => {
  const visitorRow = (l: AdminSubjectRow["live"]): AdminSubjectRow =>
    ({ ...build({ visitors: [visitor()] })[0], live: l }) as AdminSubjectRow;

  it("offers Disconnect for a live visitor", () => {
    expect(rowActions(visitorRow(live()))).toEqual(["disconnect"]);
  });

  it("offers Reconnect for a downed visitor", () => {
    expect(rowActions(visitorRow(null))).toEqual(["reconnect"]);
  });

  // The divergence case: DB intent still says connected, the pid is
  // gone. Keying off connection_state would offer Disconnect on a
  // session that no longer exists.
  it("offers Reconnect on a :connected visitor whose pid died", () => {
    const row = { ...visitorRow(null), connection_state: "connected" } as AdminSubjectRow;

    expect(rowActions(row)).toEqual(["reconnect"]);
  });

  it("never offers Reconnect on a user row — the server answers 400", () => {
    const row = { ...build({ credentials: [credential()] })[0] } as AdminSubjectRow;

    expect(rowActions(row)).not.toContain("reconnect");
    expect(rowActions(row)).toEqual(["disconnect", "terminate"]);
  });

  // A log-only row has no credential and no pid, so every verb would
  // resolve to nothing. Offering one would guarantee a failed request.
  it("offers no verb at all on a log-only row", () => {
    const ghost = build({ logSessions: [logEntry()] })[0] as AdminSubjectRow;

    expect(rowActions(ghost)).toEqual([]);
  });

  it("offers the same user verbs whether or not the pid is live", () => {
    const parked = { ...build({ credentials: [credential()] })[0], live: null } as AdminSubjectRow;
    const alive = {
      ...build({ credentials: [credential({ live_state: live() })] })[0],
    } as AdminSubjectRow;

    expect(rowActions(parked)).toEqual(rowActions(alive));
  });
});

describe("rowKey", () => {
  it("builds the composite the server parses", () => {
    expect(rowKey("visitor", VISITOR_ID, 42)).toBe(`visitor:${VISITOR_ID}:42`);
  });
});

// #1308 — `last joined` is the DEFAULT sort, so it has to exist on both
// kinds before the sort does. It did not: the visitor row carried
// `visitor.inserted_at` and the user row carried nothing at all, which
// would have made the default order half-null on day one.
describe("last_joined_at — the default sort key, populated for BOTH kinds", () => {
  it("takes a visitor row's from the visitor identity", () => {
    const rows = build({ visitors: [visitor({ inserted_at: "2026-07-01T00:00:00Z" })] });

    expect(rows[0]?.last_joined_at).toBe("2026-07-01T00:00:00Z");
  });

  // THE gap. The credential's `inserted_at` was on the wire all along and
  // simply never reached the row.
  it("takes a user row's from the credential", () => {
    const rows = build({ credentials: [credential({ inserted_at: "2026-07-02T00:00:00Z" })] });

    expect(rows[0]?.last_joined_at).toBe("2026-07-02T00:00:00Z");
  });

  it("is null on an orphan pid — there is no DB row to have been created", () => {
    const rows = build({
      sessions: [session({ subject_id: "deadbeef-0000-0000-0000-000000000000" })],
    });

    expect(rows[0]?.origin).toBe("orphan_pid");
    expect(rows[0]?.last_joined_at).toBeNull();
  });

  it("is null on a log-only row — the subject it would date is gone", () => {
    const rows = build({ logSessions: [logEntry()] });

    expect(rows[0]?.origin).toBe("session_log");
    expect(rows[0]?.last_joined_at).toBeNull();
  });
});

// #1308 — asc/desc on the three time columns, default `last joined` desc.
//
// The load-bearing rule is the null placement. A missing `last_event.at`
// is the bounded ring having forgotten, NOT a session that never ran, so
// treating it as epoch 0 would float exactly the rows we know least about
// to the top of an ascending sort and state a fact we do not have.
describe("sortSubjectRows", () => {
  const base = (): AdminSubjectRow => build({ credentials: [credential()] })[0] as AdminSubjectRow;

  const at = (key: string, over: Partial<AdminSubjectRow>): AdminSubjectRow => ({
    ...base(),
    key,
    ...over,
  });

  const keysOf = (rows: AdminSubjectRow[]): string[] => rows.map((r) => r.key);

  it("defaults to last joined, descending", () => {
    expect(DEFAULT_SESSION_SORT).toEqual({ key: "last_joined", direction: "desc" });
  });

  it("orders by last joined, newest first", () => {
    const rows = [
      at("old", { last_joined_at: "2026-08-01T00:00:00Z" }),
      at("new", { last_joined_at: "2026-08-09T00:00:00Z" }),
      at("mid", { last_joined_at: "2026-08-05T00:00:00Z" }),
    ];

    expect(keysOf(sortSubjectRows(rows, { key: "last_joined", direction: "desc" }))).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  it("reverses on ascending", () => {
    const rows = [
      at("old", { last_joined_at: "2026-08-01T00:00:00Z" }),
      at("new", { last_joined_at: "2026-08-09T00:00:00Z" }),
      at("mid", { last_joined_at: "2026-08-05T00:00:00Z" }),
    ];

    expect(keysOf(sortSubjectRows(rows, { key: "last_joined", direction: "asc" }))).toEqual([
      "old",
      "mid",
      "new",
    ]);
  });

  it("puts a null last when descending", () => {
    const rows = [
      at("unknown", { last_joined_at: null }),
      at("known", { last_joined_at: "2026-08-01T00:00:00Z" }),
    ];

    expect(keysOf(sortSubjectRows(rows, { key: "last_joined", direction: "desc" }))).toEqual([
      "known",
      "unknown",
    ]);
  });

  // The one a "just negate the comparator" implementation fails: flipping
  // the direction must NOT float the unknowns to the top.
  it("puts a null last when ASCENDING too", () => {
    const rows = [
      at("unknown", { last_joined_at: null }),
      at("known", { last_joined_at: "2026-08-01T00:00:00Z" }),
    ];

    expect(keysOf(sortSubjectRows(rows, { key: "last_joined", direction: "asc" }))).toEqual([
      "known",
      "unknown",
    ]);
  });

  it("sorts last active off the session log's newest event", () => {
    const rows = [
      at("quiet", { last_event: logEntry({ at: "2026-08-01T00:00:00Z" }) }),
      at("busy", { last_event: logEntry({ at: "2026-08-12T00:00:00Z" }) }),
    ];

    expect(keysOf(sortSubjectRows(rows, { key: "last_active", direction: "desc" }))).toEqual([
      "busy",
      "quiet",
    ]);
  });

  // Same rule, on the key where the null is most common: the ring forgets.
  it("puts a row the log remembers nothing about last, in both directions", () => {
    const rows = [
      at("forgotten", { last_event: null }),
      at("logged", { last_event: logEntry({ at: "2026-08-01T00:00:00Z" }) }),
    ];

    expect(keysOf(sortSubjectRows(rows, { key: "last_active", direction: "desc" }))).toEqual([
      "logged",
      "forgotten",
    ]);
    expect(keysOf(sortSubjectRows(rows, { key: "last_active", direction: "asc" }))).toEqual([
      "logged",
      "forgotten",
    ]);
  });

  it("sorts last seen off the browser-touch column", () => {
    const rows = [
      at("stale", { last_seen_at: "2026-08-01T00:00:00Z" }),
      at("fresh", { last_seen_at: "2026-08-12T00:00:00Z" }),
      at("never", { last_seen_at: null }),
    ];

    expect(keysOf(sortSubjectRows(rows, { key: "last_seen", direction: "asc" }))).toEqual([
      "stale",
      "fresh",
      "never",
    ]);
  });

  // #1308 — the row-origin grouping survives as a TIEBREAK. Both fixtures
  // are created at the same instant, so the only thing left to order them
  // is the assembly order, and it must still be visitors-before-users in
  // BOTH directions — a comparator that reverses the whole array rather
  // than negating the key comparison flips this.
  it("keeps the assembly order between rows the key cannot separate", () => {
    const rows = build({
      visitors: [visitor({ inserted_at: "2026-08-01T00:00:00Z" })],
      credentials: [credential({ inserted_at: "2026-08-01T00:00:00Z" })],
    });
    expect(keysOf(rows), "pre-state: assembly puts the visitor first").toEqual([
      `visitor:${VISITOR_ID}:42`,
      `user:${USER_ID}:42`,
    ]);

    for (const direction of ["asc", "desc"] as const) {
      expect(keysOf(sortSubjectRows(rows, { key: "last_joined", direction }))).toEqual([
        `visitor:${VISITOR_ID}:42`,
        `user:${USER_ID}:42`,
      ]);
    }
  });

  // A timestamp we cannot read is a timestamp we do not have. Silently
  // ordering it as epoch 0 would be the same lie the null rule refuses.
  it("treats an unreadable timestamp as unknown rather than as the epoch", () => {
    const rows = [
      at("garbage", { last_joined_at: "not-a-date" }),
      at("known", { last_joined_at: "2026-08-01T00:00:00Z" }),
    ];

    expect(keysOf(sortSubjectRows(rows, { key: "last_joined", direction: "asc" }))).toEqual([
      "known",
      "garbage",
    ]);
  });

  it("does not mutate the row set it was handed", () => {
    const rows = [
      at("old", { last_joined_at: "2026-08-01T00:00:00Z" }),
      at("new", { last_joined_at: "2026-08-09T00:00:00Z" }),
    ];

    sortSubjectRows(rows, { key: "last_joined", direction: "desc" });

    expect(keysOf(rows)).toEqual(["old", "new"]);
  });
});
