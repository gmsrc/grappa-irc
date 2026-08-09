import { describe, expect, it } from "vitest";
import {
  narrowAdminEvent,
  narrowAdminOverview,
  narrowAdminSnapshot,
  narrowSessionLogEntry,
} from "../lib/wireNarrow";
import { S_AdminEventsWireEvent, S_AdminOverviewWireT, S_SessionLogWireT } from "../lib/wireSchema";
import { ADMISSION_FLOW } from "../lib/wireTypes";
import type { WireNode } from "../lib/wireValidate";

// #429 — a MEASUREMENT of what the admin-events boundary does to a malformed
// payload, not a hand-picked set of cases.
//
// A narrower is the defence at the boundary, so replacing hand-written
// narrowers with generated ones is only safe if you can say what changed for
// every malformed shape — not just for the shapes someone remembered to write
// a test for. This walks the GENERATED schema, synthesises one valid payload
// per arm, then mutates it field by field (drop / null / wrong type / an
// unknown extra key) and records the verdict.
//
// The snapshot below is that measurement. Its diff, in the commit that swaps
// the implementation, IS the before/after evidence — a permissiveness
// regression cannot land quietly, because it shows up as a field moving into
// a `survives…` list.
//
// `survives…` lists the fields whose mutation was ACCEPTED. Everything else
// was rejected, so an empty list ("-") means the boundary caught every
// mutation of every field on that arm.

const ARMS = S_AdminEventsWireEvent.u as readonly WireNode[];

function sample(node: WireNode): unknown {
  if (typeof node === "string") {
    switch (node) {
      case "s":
        return "sample";
      case "i":
        return 1;
      case "b":
        return true;
      case "z":
        return null;
      case "x":
        return { opaque: true };
    }
  }
  if ("l" in node) return node.l;
  if ("e" in node) return node.e[0];
  if ("a" in node) return [sample(node.a)];
  if ("r" in node) return { key: sample(node.r) };
  if ("p" in node) return node.p.map(sample);
  if ("u" in node) return sample(node.u[0] as WireNode);
  return Object.fromEntries(Object.entries(node.o).map(([k, v]) => [k, sample(v)]));
}

// A value of a DIFFERENT JSON type than the sampled one, derived from the
// sample so a schema change can never leave the mutation vacuous (mutating a
// string field to another string would test nothing).
function wrongType(value: unknown): unknown {
  if (typeof value === "string") return 12345;
  if (typeof value === "number") return "12345";
  if (typeof value === "boolean") return "true";
  return "not-an-object";
}

type Narrower = (raw: unknown) => unknown;

function verdictOf(narrow: Narrower, payload: unknown): "accept" | "reject" {
  return narrow(payload) === null ? "reject" : "accept";
}

function verdict(payload: unknown): "accept" | "reject" {
  return verdictOf(narrowAdminEvent, payload);
}

function survivors(
  narrow: Narrower,
  fields: readonly string[],
  mutate: (field: string) => unknown,
): string {
  const survived = fields.filter((f) => verdictOf(narrow, mutate(f)) === "accept");
  return survived.length === 0 ? "-" : survived.join(", ");
}

function without(obj: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...obj };
  delete copy[field];
  return copy;
}

function armKind(node: WireNode): string {
  if (typeof node === "string" || !("o" in node)) throw new Error("arm is not an object node");
  const kindNode = node.o.kind;
  if (kindNode === undefined || typeof kindNode === "string" || !("l" in kindNode)) {
    throw new Error("arm has no literal `kind` discriminant");
  }
  return String(kindNode.l);
}

function measure(narrow: Narrower, node: WireNode): Record<string, string> {
  const valid = sample(node) as Record<string, unknown>;
  const fields = Object.keys(valid).sort();
  return {
    fields: fields.join(", "),
    baseline: verdictOf(narrow, valid),
    unknownKey: verdictOf(narrow, { ...valid, a_field_from_the_future: 1 }),
    survivesMissing: survivors(narrow, fields, (f) => without(valid, f)),
    survivesNull: survivors(narrow, fields, (f) => ({ ...valid, [f]: null })),
    survivesWrongType: survivors(narrow, fields, (f) => ({ ...valid, [f]: wrongType(valid[f]) })),
  };
}

function measureAllArms(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const arm of ARMS) out[armKind(arm)] = measure(narrowAdminEvent, arm);
  return out;
}

describe("admin-events boundary — malformed-payload measurement (#429)", () => {
  it("covers every arm the server declares", () => {
    // The schema is the server's own union; if an arm has no measurement the
    // corpus is lying about its coverage.
    expect(ARMS.length).toBeGreaterThan(0);
    expect(Object.keys(measureAllArms())).toHaveLength(ARMS.length);
  });

  it("rejects every malformed top-level shape", () => {
    expect(verdict(null)).toBe("reject");
    expect(verdict("circuit_open")).toBe("reject");
    expect(verdict([])).toBe("reject");
    expect(verdict({})).toBe("reject");
    expect(verdict({ kind: 1, at: "t" })).toBe("reject");
    expect(verdict({ kind: "a_kind_from_the_future", at: "t" })).toBe("reject");
  });

  // The regression this slice was chasing, stated as behaviour rather than as
  // a snapshot cell: every arm of the server's own `Admission.flow/0` must
  // get through. Against the pre-#429 hand narrower this fails on exactly one
  // member, `visitor_reconnect`, which the five-arm transcription never
  // learned about.
  it("admits every member of the server's declared admission-flow set", () => {
    for (const flow of ADMISSION_FLOW) {
      expect(
        narrowAdminEvent({
          kind: "capacity_reject",
          flow,
          error: "ip_cap_exceeded",
          network_id: 1,
          network_slug: "azzurra",
          source_ip: null,
          at: "2026-08-09T00:00:00Z",
        }),
      ).not.toBeNull();
    }
  });

  it("keeps the snapshot atomic — one malformed row drops the whole set", () => {
    const good = sample(ARMS[0] as WireNode);
    expect(narrowAdminSnapshot({ events: [] })).toEqual({ events: [] });
    expect(narrowAdminSnapshot({ events: [good] })).toEqual({ events: [good] });
    expect(narrowAdminSnapshot({ events: [good, { kind: "circuit_open" }] })).toBeNull();
    expect(narrowAdminSnapshot({ events: {} })).toBeNull();
    expect(narrowAdminSnapshot(null)).toBeNull();
  });

  it("records what each arm does to every field mutation", () => {
    expect(measureAllArms()).toMatchInlineSnapshot(`
      {
        "cap_counts_changed": {
          "baseline": "accept",
          "fields": "at, kind, max_concurrent_user_sessions, max_concurrent_visitor_sessions, network_id, network_slug, users, visitors",
          "survivesMissing": "-",
          "survivesNull": "max_concurrent_user_sessions, max_concurrent_visitor_sessions",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "capacity_reject": {
          "baseline": "accept",
          "fields": "at, error, flow, kind, network_id, network_slug, source_ip",
          "survivesMissing": "-",
          "survivesNull": "network_slug, source_ip",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "circuit_close": {
          "baseline": "accept",
          "fields": "at, kind, network_id, network_slug, reason",
          "survivesMissing": "-",
          "survivesNull": "network_slug",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "circuit_open": {
          "baseline": "accept",
          "fields": "at, cooldown_ms, kind, network_id, network_slug, threshold",
          "survivesMissing": "-",
          "survivesNull": "network_slug",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "circuit_reset": {
          "baseline": "accept",
          "fields": "actor_user_id, actor_user_name, at, kind, network_id, network_slug",
          "survivesMissing": "-",
          "survivesNull": "actor_user_id, actor_user_name, network_slug",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "credential_bound": {
          "baseline": "accept",
          "fields": "actor_user_id, actor_user_name, at, kind, network_id, network_slug, nick, user_id, user_name",
          "survivesMissing": "-",
          "survivesNull": "-",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "credential_unbound": {
          "baseline": "accept",
          "fields": "actor_user_id, actor_user_name, at, kind, network_id, network_slug, user_id, user_name",
          "survivesMissing": "-",
          "survivesNull": "-",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "credential_updated": {
          "baseline": "accept",
          "fields": "actor_user_id, actor_user_name, at, kind, network_id, network_slug, session_action, user_id, user_name",
          "survivesMissing": "-",
          "survivesNull": "-",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "login_throttled": {
          "baseline": "accept",
          "fields": "at, door, failures, kind, scope, source_ip, window_ms",
          "survivesMissing": "door, scope",
          "survivesNull": "door, scope, source_ip",
          "survivesWrongType": "door, scope",
          "unknownKey": "accept",
        },
        "network_caps_updated": {
          "baseline": "accept",
          "fields": "actor_user_id, actor_user_name, at, kind, max_concurrent_user_sessions, max_concurrent_visitor_sessions, max_per_ip, network_id, network_slug",
          "survivesMissing": "-",
          "survivesNull": "actor_user_id, actor_user_name, max_concurrent_user_sessions, max_concurrent_visitor_sessions, max_per_ip",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "network_created": {
          "baseline": "accept",
          "fields": "actor_user_id, actor_user_name, at, kind, network_id, network_slug",
          "survivesMissing": "-",
          "survivesNull": "-",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "network_deleted": {
          "baseline": "accept",
          "fields": "actor_user_id, actor_user_name, at, kind, network_id, network_slug",
          "survivesMissing": "-",
          "survivesNull": "-",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "reaper_swept": {
          "baseline": "accept",
          "fields": "at, count, kind",
          "survivesMissing": "-",
          "survivesNull": "-",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "server_added": {
          "baseline": "accept",
          "fields": "actor_user_id, actor_user_name, at, host, kind, network_id, network_slug, port, server_id, tls",
          "survivesMissing": "-",
          "survivesNull": "-",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "server_removed": {
          "baseline": "accept",
          "fields": "actor_user_id, actor_user_name, at, host, kind, network_id, network_slug, port, server_id",
          "survivesMissing": "-",
          "survivesNull": "-",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "server_updated": {
          "baseline": "accept",
          "fields": "actor_user_id, actor_user_name, at, host, kind, network_id, network_slug, port, server_id, tls",
          "survivesMissing": "-",
          "survivesNull": "-",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "session_disconnected": {
          "baseline": "accept",
          "fields": "actor_user_id, actor_user_name, at, kind, network_id, network_slug, subject_id, subject_kind",
          "survivesMissing": "-",
          "survivesNull": "actor_user_id, actor_user_name, network_slug",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "session_terminated": {
          "baseline": "accept",
          "fields": "actor_user_id, actor_user_name, at, kind, network_id, network_slug, subject_id, subject_kind",
          "survivesMissing": "-",
          "survivesNull": "actor_user_id, actor_user_name, network_slug",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "upload_reaped": {
          "baseline": "accept",
          "fields": "at, kind, slug, subject_id, subject_kind, upload_id",
          "survivesMissing": "-",
          "survivesNull": "-",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "uploads_swept": {
          "baseline": "accept",
          "fields": "at, count, kind",
          "survivesMissing": "-",
          "survivesNull": "-",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "user_created": {
          "baseline": "accept",
          "fields": "actor_user_id, actor_user_name, at, is_admin, kind, user_id, user_name",
          "survivesMissing": "-",
          "survivesNull": "-",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "user_deleted": {
          "baseline": "accept",
          "fields": "actor_user_id, actor_user_name, at, kind, user_id, user_name",
          "survivesMissing": "-",
          "survivesNull": "-",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "user_password_changed": {
          "baseline": "accept",
          "fields": "actor_user_id, actor_user_name, at, kind, user_id, user_name",
          "survivesMissing": "-",
          "survivesNull": "-",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "user_updated": {
          "baseline": "accept",
          "fields": "actor_user_id, actor_user_name, at, is_admin, kind, user_id, user_name",
          "survivesMissing": "-",
          "survivesNull": "-",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "visitor_deleted": {
          "baseline": "accept",
          "fields": "actor_user_id, actor_user_name, at, kind, visitor_id, visitor_nick",
          "survivesMissing": "-",
          "survivesNull": "actor_user_id, actor_user_name, visitor_nick",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "visitor_reaped": {
          "baseline": "accept",
          "fields": "at, kind, visitor_id, visitor_nick",
          "survivesMissing": "-",
          "survivesNull": "visitor_nick",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "visitor_share_token_minted": {
          "baseline": "accept",
          "fields": "actor_user_id, actor_user_name, at, kind, visitor_id, visitor_nick",
          "survivesMissing": "-",
          "survivesNull": "visitor_nick",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "web_session_severed": {
          "baseline": "accept",
          "fields": "at, failures, kind, subject_id, subject_kind, window_ms",
          "survivesMissing": "-",
          "survivesNull": "-",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
      }
    `);
  });

  // The same measurement for the two other narrowers this boundary owns.
  // They ride the same admin channel and were migrated in the same slice, so
  // they get the same evidence rather than a "the old tests still pass" claim.
  it("records the same for the session-log and overview narrowers", () => {
    expect({
      admin_overview: measure(narrowAdminOverview, S_AdminOverviewWireT),
      session_log_entry: measure(narrowSessionLogEntry, S_SessionLogWireT),
    }).toMatchInlineSnapshot(`
      {
        "admin_overview": {
          "baseline": "accept",
          "fields": "hostname, loadavg, sessions, version, visitors",
          "survivesMissing": "-",
          "survivesNull": "loadavg",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
        "session_log_entry": {
          "baseline": "accept",
          "fields": "at, attempt, clean, delay_ms, duration_ms, event, id, network_id, network_slug, nick, old_nick, reason, session_id, subject_kind",
          "survivesMissing": "old_nick",
          "survivesNull": "attempt, clean, delay_ms, duration_ms, network_slug, nick, old_nick, reason",
          "survivesWrongType": "-",
          "unknownKey": "accept",
        },
      }
    `);
  });
});
