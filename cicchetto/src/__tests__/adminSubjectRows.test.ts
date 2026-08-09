import { describe, expect, it } from "vitest";
import {
  type AdminSubjectRow,
  buildSubjectRows,
  channelCount,
  rowActions,
  rowKey,
} from "../lib/adminSubjectRows";
import type { AdminCredential, AdminNetwork, AdminSession, AdminVisitor } from "../lib/api";

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

const build = (over: Partial<Parameters<typeof buildSubjectRows>[0]> = {}): AdminSubjectRow[] =>
  buildSubjectRows({
    visitors: [],
    credentials: [],
    sessions: [],
    networks: [network()],
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
