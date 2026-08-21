import { describe, expect, it } from "vitest";
import { narrowUserEvent } from "../lib/userTopic";
import * as schemas from "../lib/wireSchema";
import type { WireNode } from "../lib/wireValidate";
import { validate } from "../lib/wireValidate";

// #1393 — the mutate-every-field MEASUREMENT `wireAdminBoundary` applies to
// the admin channel, pointed at the WHOLE user topic.
//
// `userTopic.ts` hand-narrows 42 arms and uses zero generated schemas, while
// a schema for every one of those arms is already emitted next to it. The
// review calls that an arrested migration; this file turns the claim into a
// list. For each arm it synthesises a valid payload from the GENERATED
// schema, mutates it field by field, and records what the hand narrower and
// the schema each do with it. Arms where the two agree are a proved dead end
// — nothing to gain by swapping them.
//
// A disagreement is measured in BOTH directions, because they cost opposite
// things and one alone cannot settle whether an arm is worth migrating:
//
//   * the hand narrower ACCEPTS what the schema rejects — a permissiveness
//     hole, the only place a migration buys safety rather than line count;
//   * the schema ACCEPTS what the hand narrower rejects — strictness the
//     migration would silently LOSE, since the typespec is the looser of the
//     two and swapping in the generated check drops the hand-written guard.
//
// Measuring one direction only would report an asymmetry as a parity.
//
// Arms are matched to schemas by their `kind` LITERAL, not by a camelised
// name: the name heuristic missed three arms whose schema lives under a
// differently-named Wire module.
//
// `kind` is excluded from the mutation matrix on purpose. Mutating the
// discriminator tests DISPATCH, not field validation: the hand narrower
// falls through its switch while the schema rejects a literal mismatch —
// same verdict, different mechanism, no information about the boundary.

type Narrower = (raw: unknown) => unknown;

const hand: Narrower = (raw) => narrowUserEvent(raw);

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

function wrongType(value: unknown): unknown {
  if (typeof value === "string") return 12345;
  if (typeof value === "number") return "12345";
  if (typeof value === "boolean") return "true";
  if (Array.isArray(value)) return "not-an-array";
  return "not-an-object";
}

// The fourth op, and the one the first three cannot express: a leaf of the
// RIGHT type carrying a value the schema does not declare.
//
// `drop`, `null` and `wrong-type` all move the TYPE, so they leave a closed
// set (`{e: [...]}`, `{l: "..."}`) and a free `"s"` indistinguishable — both
// take a string, both refuse a number. But a token a server adds additively
// IS a well-typed string, and that is precisely the case the wire contract
// legislates (unknown-is-never-fatal, GH #447): several hand arms accept any
// string ON PURPOSE where the typespec names a closed set, so that a newer
// BEAM cannot make an older cic drop a terminal event. A type-only matrix
// reports those arms at parity and would wave the migration through.
//
// Generated for STRING leaves only — on any other leaf it would be
// `wrong-type` under a second name — and on a free-string field both
// boundaries accept it, so the row costs a line and says nothing. It is the
// closed-set fields where it separates them.
const UNDECLARED_VALUE = "__undeclared_wire_value__";

// Every position in a sample at which a field can be mutated, as a path.
//
// The matrix that landed with #1471 mutated TOP-LEVEL fields only, and that
// cannot see a tolerance nested inside an object field. `connection_state_changed`
// is the measured instance: its hand arm defaults `network.recoverable` to
// `false` when the server omits it (#581, additive-field tolerance), while
// `S_NetworksWireHomeNetworkRow` declares that field REQUIRED. One level down
// the two boundaries disagree; at the top level they look identical, and the
// arm was therefore counted among the 34 at parity. So the matrix walks the
// whole sample instead of its first layer.
function paths(value: unknown, prefix: readonly string[] = []): string[][] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => [[...prefix, String(i)], ...paths(v, [...prefix, String(i)])]);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
      [...prefix, k],
      ...paths(v, [...prefix, k]),
    ]);
  }
  return [];
}

type Op = "drop" | "null" | "wrong-type" | "swap";

const OPS = ["drop", "null", "wrong-type", "swap"] as const;

function mutateAt(root: unknown, path: readonly string[], op: Op) {
  const copy = JSON.parse(JSON.stringify(root));
  let parent = copy;
  for (const k of path.slice(0, -1)) parent = parent[k];
  const leaf = path[path.length - 1] as string;
  if (op === "drop") {
    // Deleting an array index would leave a hole that reads as `undefined`
    // rather than a shorter array, which is a third mutation nobody asked
    // for. Splice keeps "drop" meaning the same thing at every position.
    if (Array.isArray(parent)) parent.splice(Number(leaf), 1);
    else delete parent[leaf];
  } else if (op === "null") {
    parent[leaf] = null;
  } else if (op === "swap") {
    parent[leaf] = UNDECLARED_VALUE;
  } else {
    parent[leaf] = wrongType(parent[leaf]);
  }
  return copy;
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let node = root;
  for (const k of path) node = (node as Record<string, unknown>)[k];
  return node;
}

type Mutation = { label: string; payload: unknown };

// `kind` is excluded at the TOP level only — mutating the discriminator tests
// dispatch, not field validation. A nested `kind` belongs to a nested shape
// and is an ordinary field there.
function mutations(valid: Record<string, unknown>): Mutation[] {
  return paths(valid)
    .filter((p) => !(p.length === 1 && p[0] === "kind"))
    .flatMap((p) =>
      opsFor(valueAt(valid, p)).map((op) => ({
        label: `${p.join(".")}/${op}`,
        payload: mutateAt(valid, p, op),
      })),
    );
}

function opsFor(leaf: unknown): readonly Op[] {
  return typeof leaf === "string" ? OPS : OPS.filter((op) => op !== "swap");
}

function verdict(narrow: Narrower, payload: unknown): "accept" | "reject" {
  return narrow(payload) === null ? "reject" : "accept";
}

function isObjectNode(node: WireNode): node is { o: Record<string, WireNode> } {
  return typeof node !== "string" && "o" in node;
}

// Key order is not part of the boundary contract, so it must not be part of
// the comparison: an arm that builds `{kind, network}` and a schema that
// declares `{network, kind}` hand the dispatcher the same object.
function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, canon(v)]),
    );
  }
  return value;
}

function keysOf(value: unknown): string[] {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).sort()
    : [];
}

// Every generated schema that carries a `kind` literal, indexed by it.
function schemasByKind(): Map<string, Candidate[]> {
  const out = new Map<string, Candidate[]>();
  for (const [name, node] of Object.entries(schemas) as [string, WireNode][]) {
    if (!name.startsWith("S_") || !isObjectNode(node)) continue;
    const k = node.o.kind;
    if (k === undefined || typeof k === "string" || !("l" in k)) continue;
    const list = out.get(k.l as string) ?? [];
    list.push({ name, node });
    out.set(k.l as string, list);
  }
  return out;
}

type Candidate = { name: string; node: WireNode };

type ArmReport = {
  arm: string;
  schema: string;
  mutations: number;
  handAcceptsSchemaRejects: string;
  schemaAcceptsHandRejects: string;
  schemaRejectsValid: boolean;
};

function censusArm(kind: string, schemaName: string, node: WireNode): ArmReport {
  const generated: Narrower = (raw) => validate(node, raw);
  const valid = sample(node) as Record<string, unknown>;
  const matrix = mutations(valid);

  const holes: string[] = [];
  const losses: string[] = [];
  for (const { label, payload } of matrix) {
    const byHand = verdict(hand, payload);
    const bySchema = verdict(generated, payload);
    if (byHand === "accept" && bySchema === "reject") holes.push(label);
    if (bySchema === "accept" && byHand === "reject") losses.push(label);
  }

  return {
    arm: kind,
    schema: schemaName,
    mutations: matrix.length,
    handAcceptsSchemaRejects: holes.length === 0 ? "-" : holes.join(", "),
    schemaAcceptsHandRejects: losses.length === 0 ? "-" : losses.join(", "),
    // The oracle's own sanity check: a schema that rejects its OWN sample
    // means the sampler and the schema disagree, and every verdict on that
    // arm is noise rather than a measurement.
    schemaRejectsValid: verdict(generated, valid) === "reject",
  };
}

const BY_KIND = schemasByKind();
// An ambiguous kind literal (`web_session_severed` is emitted by two Wire
// modules) is kept if ANY of its candidate schemas produces a sample the hand
// narrower accepts — and every candidate is then censused, so the arm cannot
// fall out of the list because the first candidate happened to be the wrong
// module's.
const accepts = (k: string): boolean =>
  candidatesFor(k).some(({ node }) => verdict(hand, sample(node)) === "accept");

const ARMS = [...BY_KIND.keys()];

// Every schema whose `kind` literal is this one. Throws rather than returning
// empty: `ARMS` is derived from the same map, so a miss here would mean the
// map changed under the walk, and a census that silently skipped an arm is
// worse than one that stops.
function candidatesFor(kind: string): [Candidate, ...Candidate[]] {
  const found = BY_KIND.get(kind);
  if (found === undefined || found.length === 0) {
    throw new Error(`no generated schema carries the kind literal "${kind}"`);
  }
  return found as [Candidate, ...Candidate[]];
}

// The control. Two boundaries agreeing means nothing unless the matrix can
// tell them apart, so this one is weakened ON PURPOSE — it skips the `state`
// check — and `state` has to show up as a hole.
const weakened: Narrower = (raw) => {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return typeof r.network === "string" ? { kind: "away_confirmed", ...r } : null;
};

// The control for the OTHER direction, which needs its own mutant: an arm
// agreeing in one direction says nothing about the other. `whowas_bundle`'s
// `user` is `string | null` in the typespec, so the schema accepts a null the
// hand narrower here refuses ON PURPOSE — and `user/null` has to show up as a
// loss.
const strengthened: Narrower = (raw) => {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return typeof r.user === "string" ? { kind: "whowas_bundle", ...r } : null;
};

// The 42 `case` labels of `narrowUserEvent`, transcribed from the switch so
// the reconciliation below has a reference OUTSIDE the schema walk.
const HAND_SWITCH_ARMS = [
  "archive_changed",
  "archive_purged",
  "auto_away_debounce_changed",
  "away_confirmed",
  "banlist_bundle",
  "bundle_hash",
  "channels_changed",
  "connection_progress",
  "connection_state_changed",
  "directory_complete",
  "directory_failed",
  "directory_progress",
  "invite_ack",
  "isupport_changed",
  "join_failed",
  "joined",
  "kicked",
  "links_bundle",
  "lusers_bundle",
  "mentions_bundle",
  "names_reply",
  "notify_list",
  "own_nick_changed",
  "peer_away",
  "presence_changed",
  "presence_error",
  "presence_snapshot",
  "query_windows_list",
  "recover_progress",
  "recover_result",
  "server_reply",
  "server_settings_changed",
  "session_identity_changed",
  "supported_umodes_changed",
  "umode_changed",
  "web_session_severed",
  "who_reply",
  "whois_bundle",
  "whowas_bundle",
  "window_invite_declined",
  "window_invited",
  "window_pending",
] as const;

describe("#1393 — user-topic boundary census", () => {
  it("detects a weakened boundary (control for the matrix itself)", () => {
    const node = candidatesFor("away_confirmed")[0].node;
    const valid = sample(node) as Record<string, unknown>;
    const generated: Narrower = (raw) => validate(node, raw);
    const holes = Object.keys(valid)
      .filter((f) => f !== "kind")
      .filter(
        (f) =>
          verdict(weakened, { ...valid, [f]: null }) === "accept" &&
          verdict(generated, { ...valid, [f]: null }) === "reject",
      );
    expect(holes).toMatchInlineSnapshot(`
      [
        "state",
      ]
    `);
  });

  it("detects a strengthened boundary (control for the second direction)", () => {
    const node = candidatesFor("whowas_bundle")[0].node;
    const valid = sample(node) as Record<string, unknown>;
    const generated: Narrower = (raw) => validate(node, raw);
    const losses = Object.keys(valid)
      .filter((f) => f !== "kind")
      .filter(
        (f) =>
          verdict(generated, { ...valid, [f]: null }) === "accept" &&
          verdict(strengthened, { ...valid, [f]: null }) === "reject",
      );
    expect(losses).toMatchInlineSnapshot(`
      [
        "user",
      ]
    `);
  });

  // Reconciliation. The census walks SCHEMAS (indexed by kind literal), while
  // the thing under test is the hand `switch` in `userTopic.ts`. Those two
  // sets are not the same by construction, so the difference is reported
  // rather than assumed away: a hand arm missing from the census is an arm
  // nobody measured, and a censused kind absent from the switch belongs to a
  // different topic and its verdict says nothing about this one.
  it("reconciles the censused set against the hand switch", () => {
    const censused = new Set(ARMS.filter(accepts));
    const handSwitch = new Set<string>(HAND_SWITCH_ARMS);
    expect({
      handArms: handSwitch.size,
      censused: censused.size,
      inSwitchNotCensused: [...handSwitch].filter((k) => !censused.has(k)),
      censusedNotInSwitch: [...censused].filter((k) => !handSwitch.has(k)),
    }).toMatchInlineSnapshot(`
      {
        "censused": 42,
        "censusedNotInSwitch": [],
        "handArms": 42,
        "inSwitchNotCensused": [],
      }
    `);
  });

  it("censuses every hand-narrowed arm against its generated schema", () => {
    const handArms = ARMS.filter(accepts);
    const reports = handArms.flatMap((k) =>
      candidatesFor(k).map(({ name, node }) => censusArm(k, name, node)),
    );
    const divergent = reports.filter(
      (r) => r.handAcceptsSchemaRejects !== "-" || r.schemaAcceptsHandRejects !== "-",
    );
    // Counted over distinct ARMS, not over reports: an ambiguous `kind`
    // literal is censused once per candidate schema, so `reports.length`
    // overcounts the boundary by however many duplicates the wire happens to
    // carry. The parity figure the verdict rests on is an arm count.
    const divergentArms = new Set(divergent.map((r) => r.arm));
    expect({
      armsWithSchema: handArms.length,
      armsCensused: reports.length,
      armsAtParity: handArms.length - divergentArms.size,
      brokenOracles: reports.filter((r) => r.schemaRejectsValid).map((r) => r.arm),
      divergent,
    }).toMatchInlineSnapshot(`
      {
        "armsAtParity": 30,
        "armsCensused": 43,
        "armsWithSchema": 42,
        "brokenOracles": [],
        "divergent": [
          {
            "arm": "web_session_severed",
            "handAcceptsSchemaRejects": "-",
            "mutations": 18,
            "schema": "S_AdminEventsWireWebSessionSeveredEvent",
            "schemaAcceptsHandRejects": "subject_id/swap, at/swap",
            "schemaRejectsValid": false,
          },
          {
            "arm": "web_session_severed",
            "handAcceptsSchemaRejects": "code/swap",
            "mutations": 4,
            "schema": "S_RateLimitWireWebSessionSeveredEvent",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
          {
            "arm": "bundle_hash",
            "handAcceptsSchemaRejects": "version/null, version/wrong-type",
            "mutations": 8,
            "schema": "S_CicWireBundleHashPayload",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
          {
            "arm": "connection_state_changed",
            "handAcceptsSchemaRejects": "network.recoverable/drop, network.recoverable/null, network.recoverable/wrong-type",
            "mutations": 53,
            "schema": "S_NetworksWireConnectionStateEvent",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
          {
            "arm": "server_settings_changed",
            "handAcceptsSchemaRejects": "upload.video_max_duration_seconds/drop, upload.video_max_duration_seconds/null, upload.video_max_duration_seconds/wrong-type, http_host_aliases/drop, http_host_aliases/null, http_host_aliases/wrong-type, http_host_aliases.0/null, http_host_aliases.0/wrong-type",
            "mutations": 32,
            "schema": "S_ServerSettingsWireChangedPayload",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
          {
            "arm": "banlist_bundle",
            "handAcceptsSchemaRejects": "mode/drop",
            "mutations": 30,
            "schema": "S_SessionWireBanlistBundlePayload",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
          {
            "arm": "isupport_changed",
            "handAcceptsSchemaRejects": "list_modes_queryable/drop, list_modes_queryable/null, list_modes_queryable/wrong-type, list_modes_queryable.0/null, list_modes_queryable.0/wrong-type, prefix_order/drop, prefix_order/null, prefix_order/wrong-type, prefix_order.0/null, prefix_order.0/wrong-type, chantypes/drop, chantypes/null, chantypes/wrong-type, chantypes.0/null, chantypes.0/wrong-type, casemapping/drop, casemapping/null, casemapping/wrong-type, casemapping/swap, maxlist/drop, maxlist/null, maxlist/wrong-type, maxlist.key/null, maxlist.key/wrong-type, nicklen/drop, nicklen/wrong-type, channellen/drop, channellen/wrong-type, topiclen/drop, topiclen/wrong-type, frame_budget_base/drop, frame_budget_base/null, frame_budget_base/wrong-type",
            "mutations": 81,
            "schema": "S_SessionWireIsupportChangedPayload",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
          {
            "arm": "links_bundle",
            "handAcceptsSchemaRejects": "mask/drop",
            "mutations": 29,
            "schema": "S_SessionWireLinksBundlePayload",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
          {
            "arm": "lusers_bundle",
            "handAcceptsSchemaRejects": "total_users/drop, total_users/wrong-type, invisible/drop, invisible/wrong-type, servers/drop, servers/wrong-type, operators/drop, operators/wrong-type, unknown_connections/drop, unknown_connections/wrong-type, channels_formed/drop, channels_formed/wrong-type, local_clients/drop, local_clients/wrong-type, local_servers/drop, local_servers/wrong-type, current_local/drop, current_local/wrong-type, max_local/drop, max_local/wrong-type, current_global/drop, current_global/wrong-type, max_global/drop, max_global/wrong-type",
            "mutations": 40,
            "schema": "S_SessionWireLusersBundlePayload",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
          {
            "arm": "recover_progress",
            "handAcceptsSchemaRejects": "reason/swap",
            "mutations": 16,
            "schema": "S_SessionWireRecoverProgressPayload",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
          {
            "arm": "recover_result",
            "handAcceptsSchemaRejects": "reason/swap",
            "mutations": 12,
            "schema": "S_SessionWireRecoverResultPayload",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
          {
            "arm": "whois_bundle",
            "handAcceptsSchemaRejects": "source/drop, source/null, source/wrong-type, source/swap, extra_lines/drop",
            "mutations": 120,
            "schema": "S_SessionWireWhoisBundlePayload",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
          {
            "arm": "window_invited",
            "handAcceptsSchemaRejects": "inviter/drop, inviter/null, inviter/wrong-type",
            "mutations": 16,
            "schema": "S_SessionWireWindowInvitedPayload",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
        ],
      }
    `);
  });

  // The census above measures ACCEPT/REJECT and nothing else, and that is not
  // the whole boundary. `narrowUserEvent` returns the object the dispatcher
  // then consumes, and `validate` builds its OWN object from the schema's
  // declared fields — `wireValidate.ts`'s `walkObject` drops undeclared keys
  // rather than rejecting them (additive-only, GH #447), exactly as the hand
  // arms drop them by constructing a fresh literal.
  //
  // So two narrowers can agree on every verdict in the matrix above and still
  // hand the dispatcher DIFFERENT objects, whenever the schema declares a
  // field the hand arm does not copy out. Swapping one for the other would
  // ship that difference, and the verdict census cannot see it. "At parity"
  // therefore needs both axes before an arm is safe to migrate; this measures
  // the second one.
  it("censuses the VALUE each boundary returns, not just its verdict", () => {
    const pairs = ARMS.filter(accepts).flatMap((k) =>
      candidatesFor(k).map(({ name, node }) => ({ arm: k, schema: name, node })),
    );

    // A pair is comparable only when BOTH sides produced a value. The
    // ambiguous `kind` literal leaves some arms carrying a candidate from the
    // WRONG Wire module, whose sample the hand narrower rightly rejects —
    // there is no value there to compare, and scoring it as a value
    // divergence would report the ambiguity as a defect. Skipped pairs are
    // COUNTED, not dropped, so the arithmetic stays closed.
    const comparable = pairs.filter(
      ({ node }) =>
        verdict(hand, sample(node)) === "accept" &&
        verdict((raw) => validate(node, raw), sample(node)) === "accept",
    );

    const divergent = comparable
      .map(({ arm, schema, node }) => {
        const valid = sample(node);
        const byHand = hand(valid);
        const bySchema = validate(node, valid);
        const handKeys = keysOf(byHand);
        const schemaKeys = keysOf(bySchema);
        return {
          arm,
          schema,
          onlyHand: handKeys.filter((f) => !schemaKeys.includes(f)),
          onlySchema: schemaKeys.filter((f) => !handKeys.includes(f)),
          sameValue: JSON.stringify(canon(byHand)) === JSON.stringify(canon(bySchema)),
        };
      })
      .filter((r) => !r.sameValue);

    expect({
      pairs: pairs.length,
      comparablePairs: comparable.length,
      skippedOneSideRejected: pairs.length - comparable.length,
      armsAtValueParity:
        new Set(comparable.map((p) => p.arm)).size - new Set(divergent.map((r) => r.arm)).size,
      divergent,
    }).toMatchInlineSnapshot(`
      {
        "armsAtValueParity": 42,
        "comparablePairs": 42,
        "divergent": [],
        "pairs": 43,
        "skippedOneSideRejected": 1,
      }
    `);
  });

  // Slice 1 of the migration this file measured.
  //
  // The two censuses above compare the hand narrower against the schema. The
  // moment an arm's `case` calls `validate` with its own generated schema,
  // both of them compare that schema against ITSELF for that arm and report
  // parity BY CONSTRUCTION — still printing 34 and 42, still green, and
  // measuring nothing. A migration that quietly converts its own oracle into
  // a tautology is a gate that lies, so the property the migration has to
  // preserve gets an oracle that never consults a schema to JUDGE.
  //
  // A schema is still the only available source of a valid payload, so it
  // generates the inputs; the recorded verdict and returned value are the
  // narrower's alone. Taken BEFORE the migration this is a record of what the
  // boundary did, and an unchanged snapshot afterwards is the evidence that
  // it still does it. A schema edit moves the inputs and therefore the
  // snapshot — that is a signal, not noise.
  //
  // Extend the list with each slice. An arm left off it is migrated with no
  // oracle at all.
  const MIGRATED_ARMS = [
    "archive_changed",
    "archive_purged",
    "auto_away_debounce_changed",
    "away_confirmed",
    "channels_changed",
    "connection_progress",
    "directory_complete",
    "directory_failed",
    "directory_progress",
    "invite_ack",
    "join_failed",
    "joined",
    "kicked",
    "mentions_bundle",
    "names_reply",
    "notify_list",
    "own_nick_changed",
    "peer_away",
    "presence_changed",
    "presence_error",
    "presence_snapshot",
    "query_windows_list",
    "recover_progress",
    "recover_result",
    "server_reply",
    "session_identity_changed",
    "supported_umodes_changed",
    "umode_changed",
    "web_session_severed",
    "who_reply",
    "whowas_bundle",
    "window_invite_declined",
    "window_pending",
  ] as const;

  it("pins what the migrated arms accept and return, judged without a schema", () => {
    const pinned = MIGRATED_ARMS.map((arm) => {
      // An ambiguous `kind` literal must not be resolved by taking `[0]` —
      // that is a coin toss between two Wire modules, and for
      // `web_session_severed` the loser is the admin one, whose shape this
      // topic never carries. Resolve it by MEASUREMENT rather than by a
      // hard-coded name: the right candidate is the one whose sample the hand
      // narrower accepts, and exactly one must, or the disambiguation is not
      // a fact and the pin refuses to guess.
      const candidates = candidatesFor(arm).filter(
        ({ node }) => verdict(hand, sample(node)) === "accept",
      );
      // `only === undefined` is not defensive noise: a length check does not
      // narrow an index under `noUncheckedIndexedAccess`, and the two
      // conditions are the same fact stated where the compiler can see it.
      const [only] = candidates;
      if (candidates.length !== 1 || only === undefined) {
        throw new Error(
          `"${arm}": ${candidates.length} candidates produce a sample the hand narrower accepts — expected exactly 1`,
        );
      }
      const node = only.node;
      const valid = sample(node) as Record<string, unknown>;

      const matrix: Record<string, string> = {};
      for (const { label, payload } of mutations(valid)) {
        matrix[label] = verdict(hand, payload);
      }
      return { arm, returns: canon(hand(valid)), matrix };
    });

    expect(pinned).toMatchInlineSnapshot(`
      [
        {
          "arm": "archive_changed",
          "matrix": {
            "network_slug/drop": "reject",
            "network_slug/null": "reject",
            "network_slug/swap": "accept",
            "network_slug/wrong-type": "reject",
          },
          "returns": {
            "kind": "archive_changed",
            "network_slug": "sample",
          },
        },
        {
          "arm": "archive_purged",
          "matrix": {
            "network_slug/drop": "reject",
            "network_slug/null": "reject",
            "network_slug/swap": "accept",
            "network_slug/wrong-type": "reject",
            "target/drop": "reject",
            "target/null": "reject",
            "target/swap": "accept",
            "target/wrong-type": "reject",
          },
          "returns": {
            "kind": "archive_purged",
            "network_slug": "sample",
            "target": "sample",
          },
        },
        {
          "arm": "auto_away_debounce_changed",
          "matrix": {
            "auto_away_debounce_seconds/drop": "reject",
            "auto_away_debounce_seconds/null": "accept",
            "auto_away_debounce_seconds/wrong-type": "reject",
          },
          "returns": {
            "auto_away_debounce_seconds": 1,
            "kind": "auto_away_debounce_changed",
          },
        },
        {
          "arm": "away_confirmed",
          "matrix": {
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "state/drop": "reject",
            "state/null": "reject",
            "state/swap": "reject",
            "state/wrong-type": "reject",
          },
          "returns": {
            "kind": "away_confirmed",
            "network": "sample",
            "state": "present",
          },
        },
        {
          "arm": "channels_changed",
          "matrix": {},
          "returns": {
            "kind": "channels_changed",
          },
        },
        {
          "arm": "connection_progress",
          "matrix": {
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "state/drop": "reject",
            "state/null": "reject",
            "state/swap": "reject",
            "state/wrong-type": "reject",
          },
          "returns": {
            "kind": "connection_progress",
            "network": "sample",
            "state": "connecting",
          },
        },
        {
          "arm": "directory_complete",
          "matrix": {
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "total/drop": "reject",
            "total/null": "reject",
            "total/wrong-type": "reject",
          },
          "returns": {
            "kind": "directory_complete",
            "network": "sample",
            "total": 1,
          },
        },
        {
          "arm": "directory_failed",
          "matrix": {
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "reason/drop": "reject",
            "reason/null": "reject",
            "reason/swap": "accept",
            "reason/wrong-type": "reject",
          },
          "returns": {
            "kind": "directory_failed",
            "network": "sample",
            "reason": "sample",
          },
        },
        {
          "arm": "directory_progress",
          "matrix": {
            "count/drop": "reject",
            "count/null": "reject",
            "count/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
          },
          "returns": {
            "count": 1,
            "kind": "directory_progress",
            "network": "sample",
          },
        },
        {
          "arm": "invite_ack",
          "matrix": {
            "channel/drop": "reject",
            "channel/null": "reject",
            "channel/swap": "accept",
            "channel/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "peer/drop": "reject",
            "peer/null": "reject",
            "peer/swap": "accept",
            "peer/wrong-type": "reject",
          },
          "returns": {
            "channel": "sample",
            "kind": "invite_ack",
            "network": "sample",
            "peer": "sample",
          },
        },
        {
          "arm": "join_failed",
          "matrix": {
            "channel/drop": "reject",
            "channel/null": "reject",
            "channel/swap": "accept",
            "channel/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "numeric/drop": "reject",
            "numeric/null": "accept",
            "numeric/wrong-type": "reject",
            "reason/drop": "reject",
            "reason/null": "accept",
            "reason/swap": "accept",
            "reason/wrong-type": "reject",
            "state/drop": "reject",
            "state/null": "reject",
            "state/swap": "reject",
            "state/wrong-type": "reject",
          },
          "returns": {
            "channel": "sample",
            "kind": "join_failed",
            "network": "sample",
            "numeric": 1,
            "reason": "sample",
            "state": "failed",
          },
        },
        {
          "arm": "joined",
          "matrix": {
            "channel/drop": "reject",
            "channel/null": "reject",
            "channel/swap": "accept",
            "channel/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "state/drop": "reject",
            "state/null": "reject",
            "state/swap": "reject",
            "state/wrong-type": "reject",
          },
          "returns": {
            "channel": "sample",
            "kind": "joined",
            "network": "sample",
            "state": "joined",
          },
        },
        {
          "arm": "kicked",
          "matrix": {
            "by/drop": "reject",
            "by/null": "accept",
            "by/swap": "accept",
            "by/wrong-type": "reject",
            "channel/drop": "reject",
            "channel/null": "reject",
            "channel/swap": "accept",
            "channel/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "reason/drop": "reject",
            "reason/null": "accept",
            "reason/swap": "accept",
            "reason/wrong-type": "reject",
            "state/drop": "reject",
            "state/null": "reject",
            "state/swap": "reject",
            "state/wrong-type": "reject",
          },
          "returns": {
            "by": "sample",
            "channel": "sample",
            "kind": "kicked",
            "network": "sample",
            "reason": "sample",
            "state": "kicked",
          },
        },
        {
          "arm": "mentions_bundle",
          "matrix": {
            "away_ended_at/drop": "reject",
            "away_ended_at/null": "reject",
            "away_ended_at/swap": "accept",
            "away_ended_at/wrong-type": "reject",
            "away_reason/drop": "reject",
            "away_reason/null": "accept",
            "away_reason/swap": "accept",
            "away_reason/wrong-type": "reject",
            "away_started_at/drop": "reject",
            "away_started_at/null": "reject",
            "away_started_at/swap": "accept",
            "away_started_at/wrong-type": "reject",
            "messages.0.body/drop": "reject",
            "messages.0.body/null": "accept",
            "messages.0.body/swap": "accept",
            "messages.0.body/wrong-type": "reject",
            "messages.0.channel/drop": "reject",
            "messages.0.channel/null": "reject",
            "messages.0.channel/swap": "accept",
            "messages.0.channel/wrong-type": "reject",
            "messages.0.kind/drop": "reject",
            "messages.0.kind/null": "reject",
            "messages.0.kind/swap": "reject",
            "messages.0.kind/wrong-type": "reject",
            "messages.0.sender/drop": "reject",
            "messages.0.sender/null": "reject",
            "messages.0.sender/swap": "accept",
            "messages.0.sender/wrong-type": "reject",
            "messages.0.server_time/drop": "reject",
            "messages.0.server_time/null": "reject",
            "messages.0.server_time/wrong-type": "reject",
            "messages.0/drop": "accept",
            "messages.0/null": "reject",
            "messages.0/wrong-type": "reject",
            "messages/drop": "reject",
            "messages/null": "reject",
            "messages/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
          },
          "returns": {
            "away_ended_at": "sample",
            "away_reason": "sample",
            "away_started_at": "sample",
            "kind": "mentions_bundle",
            "messages": [
              {
                "body": "sample",
                "channel": "sample",
                "kind": "privmsg",
                "sender": "sample",
                "server_time": 1,
              },
            ],
            "network": "sample",
          },
        },
        {
          "arm": "names_reply",
          "matrix": {
            "channel/drop": "reject",
            "channel/null": "reject",
            "channel/swap": "accept",
            "channel/wrong-type": "reject",
            "members.0.modes.0/drop": "accept",
            "members.0.modes.0/null": "reject",
            "members.0.modes.0/swap": "accept",
            "members.0.modes.0/wrong-type": "reject",
            "members.0.modes/drop": "reject",
            "members.0.modes/null": "reject",
            "members.0.modes/wrong-type": "reject",
            "members.0.nick/drop": "reject",
            "members.0.nick/null": "reject",
            "members.0.nick/swap": "accept",
            "members.0.nick/wrong-type": "reject",
            "members.0/drop": "accept",
            "members.0/null": "reject",
            "members.0/wrong-type": "reject",
            "members/drop": "reject",
            "members/null": "reject",
            "members/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
          },
          "returns": {
            "channel": "sample",
            "kind": "names_reply",
            "members": [
              {
                "modes": [
                  "sample",
                ],
                "nick": "sample",
              },
            ],
            "network": "sample",
          },
        },
        {
          "arm": "notify_list",
          "matrix": {
            "networks.key.0.added_at/drop": "reject",
            "networks.key.0.added_at/null": "reject",
            "networks.key.0.added_at/swap": "accept",
            "networks.key.0.added_at/wrong-type": "reject",
            "networks.key.0.network_id/drop": "reject",
            "networks.key.0.network_id/null": "reject",
            "networks.key.0.network_id/wrong-type": "reject",
            "networks.key.0.nick/drop": "reject",
            "networks.key.0.nick/null": "reject",
            "networks.key.0.nick/swap": "accept",
            "networks.key.0.nick/wrong-type": "reject",
            "networks.key.0/drop": "accept",
            "networks.key.0/null": "reject",
            "networks.key.0/wrong-type": "reject",
            "networks.key/drop": "accept",
            "networks.key/null": "reject",
            "networks.key/wrong-type": "reject",
            "networks/drop": "reject",
            "networks/null": "reject",
            "networks/wrong-type": "reject",
          },
          "returns": {
            "kind": "notify_list",
            "networks": {
              "key": [
                {
                  "added_at": "sample",
                  "network_id": 1,
                  "nick": "sample",
                },
              ],
            },
          },
        },
        {
          "arm": "own_nick_changed",
          "matrix": {
            "network_id/drop": "reject",
            "network_id/null": "reject",
            "network_id/wrong-type": "reject",
            "nick/drop": "reject",
            "nick/null": "reject",
            "nick/swap": "accept",
            "nick/wrong-type": "reject",
          },
          "returns": {
            "kind": "own_nick_changed",
            "network_id": 1,
            "nick": "sample",
          },
        },
        {
          "arm": "peer_away",
          "matrix": {
            "message/drop": "reject",
            "message/null": "reject",
            "message/swap": "accept",
            "message/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "peer/drop": "reject",
            "peer/null": "reject",
            "peer/swap": "accept",
            "peer/wrong-type": "reject",
          },
          "returns": {
            "kind": "peer_away",
            "message": "sample",
            "network": "sample",
            "peer": "sample",
          },
        },
        {
          "arm": "presence_changed",
          "matrix": {
            "initial/drop": "reject",
            "initial/null": "reject",
            "initial/wrong-type": "reject",
            "network_id/drop": "reject",
            "network_id/null": "reject",
            "network_id/wrong-type": "reject",
            "nick/drop": "reject",
            "nick/null": "reject",
            "nick/swap": "accept",
            "nick/wrong-type": "reject",
            "presence/drop": "reject",
            "presence/null": "reject",
            "presence/swap": "reject",
            "presence/wrong-type": "reject",
            "source/drop": "reject",
            "source/null": "reject",
            "source/swap": "reject",
            "source/wrong-type": "reject",
            "ts/drop": "reject",
            "ts/null": "reject",
            "ts/swap": "accept",
            "ts/wrong-type": "reject",
          },
          "returns": {
            "initial": true,
            "kind": "presence_changed",
            "network_id": 1,
            "nick": "sample",
            "presence": "online",
            "source": "monitor",
            "ts": "sample",
          },
        },
        {
          "arm": "presence_error",
          "matrix": {
            "detail/drop": "reject",
            "detail/null": "reject",
            "detail/swap": "accept",
            "detail/wrong-type": "reject",
            "network_id/drop": "reject",
            "network_id/null": "reject",
            "network_id/wrong-type": "reject",
            "reason/drop": "reject",
            "reason/null": "reject",
            "reason/swap": "reject",
            "reason/wrong-type": "reject",
          },
          "returns": {
            "detail": "sample",
            "kind": "presence_error",
            "network_id": 1,
            "reason": "list_full",
          },
        },
        {
          "arm": "presence_snapshot",
          "matrix": {
            "network_id/drop": "reject",
            "network_id/null": "reject",
            "network_id/wrong-type": "reject",
            "nicks.key/drop": "accept",
            "nicks.key/null": "reject",
            "nicks.key/swap": "reject",
            "nicks.key/wrong-type": "reject",
            "nicks/drop": "reject",
            "nicks/null": "reject",
            "nicks/wrong-type": "reject",
          },
          "returns": {
            "kind": "presence_snapshot",
            "network_id": 1,
            "nicks": {
              "key": "online",
            },
          },
        },
        {
          "arm": "query_windows_list",
          "matrix": {
            "windows.key.0.network_id/drop": "reject",
            "windows.key.0.network_id/null": "reject",
            "windows.key.0.network_id/wrong-type": "reject",
            "windows.key.0.opened_at/drop": "reject",
            "windows.key.0.opened_at/null": "reject",
            "windows.key.0.opened_at/swap": "accept",
            "windows.key.0.opened_at/wrong-type": "reject",
            "windows.key.0.target_nick/drop": "reject",
            "windows.key.0.target_nick/null": "reject",
            "windows.key.0.target_nick/swap": "accept",
            "windows.key.0.target_nick/wrong-type": "reject",
            "windows.key.0/drop": "accept",
            "windows.key.0/null": "reject",
            "windows.key.0/wrong-type": "reject",
            "windows.key/drop": "accept",
            "windows.key/null": "reject",
            "windows.key/wrong-type": "reject",
            "windows/drop": "reject",
            "windows/null": "reject",
            "windows/wrong-type": "reject",
          },
          "returns": {
            "kind": "query_windows_list",
            "windows": {
              "key": [
                {
                  "network_id": 1,
                  "opened_at": "sample",
                  "target_nick": "sample",
                },
              ],
            },
          },
        },
        {
          "arm": "recover_progress",
          "matrix": {
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "reason/drop": "reject",
            "reason/null": "accept",
            "reason/swap": "accept",
            "reason/wrong-type": "reject",
            "status/drop": "reject",
            "status/null": "reject",
            "status/swap": "reject",
            "status/wrong-type": "reject",
            "step/drop": "reject",
            "step/null": "reject",
            "step/swap": "reject",
            "step/wrong-type": "reject",
          },
          "returns": {
            "kind": "recover_progress",
            "network": "sample",
            "reason": "wrong_password",
            "status": "running",
            "step": "identify",
          },
        },
        {
          "arm": "recover_result",
          "matrix": {
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "outcome/drop": "reject",
            "outcome/null": "reject",
            "outcome/swap": "reject",
            "outcome/wrong-type": "reject",
            "reason/drop": "reject",
            "reason/null": "accept",
            "reason/swap": "accept",
            "reason/wrong-type": "reject",
          },
          "returns": {
            "kind": "recover_result",
            "network": "sample",
            "outcome": "succeeded",
            "reason": "wrong_password",
          },
        },
        {
          "arm": "server_reply",
          "matrix": {
            "lines.0/drop": "accept",
            "lines.0/null": "reject",
            "lines.0/swap": "accept",
            "lines.0/wrong-type": "reject",
            "lines/drop": "reject",
            "lines/null": "reject",
            "lines/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "source/drop": "reject",
            "source/null": "reject",
            "source/swap": "reject",
            "source/wrong-type": "reject",
          },
          "returns": {
            "kind": "server_reply",
            "lines": [
              "sample",
            ],
            "network": "sample",
            "source": "info",
          },
        },
        {
          "arm": "session_identity_changed",
          "matrix": {
            "account/drop": "reject",
            "account/null": "accept",
            "account/swap": "accept",
            "account/wrong-type": "reject",
            "identified/drop": "reject",
            "identified/null": "reject",
            "identified/wrong-type": "reject",
            "network_id/drop": "reject",
            "network_id/null": "reject",
            "network_id/wrong-type": "reject",
          },
          "returns": {
            "account": "sample",
            "identified": true,
            "kind": "session_identity_changed",
            "network_id": 1,
          },
        },
        {
          "arm": "supported_umodes_changed",
          "matrix": {
            "modes.0/drop": "accept",
            "modes.0/null": "reject",
            "modes.0/swap": "accept",
            "modes.0/wrong-type": "reject",
            "modes/drop": "reject",
            "modes/null": "reject",
            "modes/wrong-type": "reject",
            "network_id/drop": "reject",
            "network_id/null": "reject",
            "network_id/wrong-type": "reject",
          },
          "returns": {
            "kind": "supported_umodes_changed",
            "modes": [
              "sample",
            ],
            "network_id": 1,
          },
        },
        {
          "arm": "umode_changed",
          "matrix": {
            "modes.0/drop": "accept",
            "modes.0/null": "reject",
            "modes.0/swap": "accept",
            "modes.0/wrong-type": "reject",
            "modes/drop": "reject",
            "modes/null": "reject",
            "modes/wrong-type": "reject",
            "network_id/drop": "reject",
            "network_id/null": "reject",
            "network_id/wrong-type": "reject",
          },
          "returns": {
            "kind": "umode_changed",
            "modes": [
              "sample",
            ],
            "network_id": 1,
          },
        },
        {
          "arm": "web_session_severed",
          "matrix": {
            "code/drop": "reject",
            "code/null": "reject",
            "code/swap": "accept",
            "code/wrong-type": "reject",
          },
          "returns": {
            "code": "rate_limit_flood",
            "kind": "web_session_severed",
          },
        },
        {
          "arm": "who_reply",
          "matrix": {
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "target/drop": "reject",
            "target/null": "reject",
            "target/swap": "accept",
            "target/wrong-type": "reject",
            "users.0.channel/drop": "reject",
            "users.0.channel/null": "reject",
            "users.0.channel/swap": "accept",
            "users.0.channel/wrong-type": "reject",
            "users.0.hops/drop": "reject",
            "users.0.hops/null": "accept",
            "users.0.hops/wrong-type": "reject",
            "users.0.host/drop": "reject",
            "users.0.host/null": "reject",
            "users.0.host/swap": "accept",
            "users.0.host/wrong-type": "reject",
            "users.0.modes/drop": "reject",
            "users.0.modes/null": "reject",
            "users.0.modes/swap": "accept",
            "users.0.modes/wrong-type": "reject",
            "users.0.nick/drop": "reject",
            "users.0.nick/null": "reject",
            "users.0.nick/swap": "accept",
            "users.0.nick/wrong-type": "reject",
            "users.0.realname/drop": "reject",
            "users.0.realname/null": "accept",
            "users.0.realname/swap": "accept",
            "users.0.realname/wrong-type": "reject",
            "users.0.server/drop": "reject",
            "users.0.server/null": "reject",
            "users.0.server/swap": "accept",
            "users.0.server/wrong-type": "reject",
            "users.0.user/drop": "reject",
            "users.0.user/null": "reject",
            "users.0.user/swap": "accept",
            "users.0.user/wrong-type": "reject",
            "users.0/drop": "accept",
            "users.0/null": "reject",
            "users.0/wrong-type": "reject",
            "users/drop": "reject",
            "users/null": "reject",
            "users/wrong-type": "reject",
          },
          "returns": {
            "kind": "who_reply",
            "network": "sample",
            "target": "sample",
            "users": [
              {
                "channel": "sample",
                "hops": 1,
                "host": "sample",
                "modes": "sample",
                "nick": "sample",
                "realname": "sample",
                "server": "sample",
                "user": "sample",
              },
            ],
          },
        },
        {
          "arm": "whowas_bundle",
          "matrix": {
            "host/drop": "reject",
            "host/null": "accept",
            "host/swap": "accept",
            "host/wrong-type": "reject",
            "logoff_time/drop": "reject",
            "logoff_time/null": "accept",
            "logoff_time/swap": "accept",
            "logoff_time/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "not_found/drop": "reject",
            "not_found/null": "reject",
            "not_found/wrong-type": "reject",
            "realname/drop": "reject",
            "realname/null": "accept",
            "realname/swap": "accept",
            "realname/wrong-type": "reject",
            "server/drop": "reject",
            "server/null": "accept",
            "server/swap": "accept",
            "server/wrong-type": "reject",
            "target/drop": "reject",
            "target/null": "reject",
            "target/swap": "accept",
            "target/wrong-type": "reject",
            "user/drop": "reject",
            "user/null": "accept",
            "user/swap": "accept",
            "user/wrong-type": "reject",
          },
          "returns": {
            "host": "sample",
            "kind": "whowas_bundle",
            "logoff_time": "sample",
            "network": "sample",
            "not_found": true,
            "realname": "sample",
            "server": "sample",
            "target": "sample",
            "user": "sample",
          },
        },
        {
          "arm": "window_invite_declined",
          "matrix": {
            "channel/drop": "reject",
            "channel/null": "reject",
            "channel/swap": "accept",
            "channel/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
          },
          "returns": {
            "channel": "sample",
            "kind": "window_invite_declined",
            "network": "sample",
          },
        },
        {
          "arm": "window_pending",
          "matrix": {
            "channel/drop": "reject",
            "channel/null": "reject",
            "channel/swap": "accept",
            "channel/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "state/drop": "reject",
            "state/null": "reject",
            "state/swap": "reject",
            "state/wrong-type": "reject",
          },
          "returns": {
            "channel": "sample",
            "kind": "window_pending",
            "network": "sample",
            "state": "pending",
          },
        },
      ]
    `);
  });
});
