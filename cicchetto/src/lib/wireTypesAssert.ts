// Structural-equivalence asserts between hand-rolled cic types in
// `./api.ts` and codegen-emitted types in `./wireTypes.ts`.
//
// Why this file exists:
//
//   * `wireTypes.ts` is the GENERATED mirror of server-side
//     `Grappa.*.Wire` typespecs (`mix grappa.gen_wire_types`,
//     `scripts/check.sh` re-runs with `--check` to fail CI on drift
//     between the typespec source and the committed `wireTypes.ts`).
//
//   * `api.ts` carries CIC-side hand-rolled mirrors of those shapes
//     (with consumer-side enrichments — discriminated unions, cic-
//     aggregate types, etc.). The hand-rolled mirrors drifted from
//     the server-side typespecs in REV cluster findings C1/C2/H1-H6.
//
//   * Migrating every cic call site to `import { X } from
//     "./wireTypes"` is risky in one go (the cic-side type unions
//     are richer than the server-side typespecs in places — REST-
//     aggregate, discriminator-narrowed). Instead, this file asserts
//     STRUCTURAL EQUIVALENCE between each api.ts type and its
//     wireTypes.ts counterpart. The `_Assert_*` type aliases evaluate
//     to `true` when shapes match, `never` when they drift. The
//     `assertExtends/2` helpers further enforce bi-directional
//     subtype-ness at compile time. `bun run check` fails on `never`
//     — closing the drift class at TS compile rather than waiting
//     for a runtime narrower mismatch.
//
//   * The CI-time loop is: typespec change → codegen regen → drift
//     gate (D) catches stale committed file → operator runs codegen
//     → wireTypes.ts updates → this file's asserts fail at `bun run
//     check` if the api.ts hand-roll doesn't match the new shape →
//     operator fixes api.ts to match → CI green.
//
// Maintenance:
//
//   * Add an assert for every api.ts type that has a wireTypes.ts
//     counterpart. When server-side adds a new Wire module + type,
//     the codegen emits it; if a cic consumer needs the new shape,
//     add the assert + the api.ts mirror. EXCEPT for arms of
//     `WireSessionEvent`: #1406 walks that population instead, so a new
//     Session arm needs no line here and gets none of the silence that
//     a forgotten line used to buy.
//
//   * If an assert fails (`Type 'true' is not assignable to type
//     'never'` at the `: true = true` lines), the api.ts mirror has
//     drifted from the server typespec. The fix is on the cic side —
//     update api.ts to match wireTypes.ts (server is the source of
//     truth per CLAUDE.md "Implement once, reuse everywhere").

import type {
  CredentialJson,
  DirectoryEntry,
  FeaturedChannelLink,
  HomeData,
  HomeNetworkRow,
  LinksEntry,
  MentionsBundleMessage,
  NotifyEntry,
  QueryWindowEntry,
  ScrollbackMessage,
  WhoUser,
  WireChannelEvent,
  WireUserEvent,
} from "./api";
import type { ModesEntry, TopicEntry } from "./channelTopic";
import type { MemberEntry } from "./memberTypes";
import type {
  ChannelDirectoryWireEntry,
  CicWireBundleHashPayload,
  NetworksFeaturedChannelsWireLink,
  NetworksWireConnectionStateEvent,
  NetworksWireCredentialJson,
  NetworksWireHomeData,
  NetworksWireHomeNetworkRow,
  NotifyWireEntry,
  NotifyWireNotifyListPayload,
  QueryWindowsWireWindowsEntry,
  QueryWindowsWireWindowsListPayload,
  ReadCursorWireReadCursorSet,
  ScrollbackWireArchiveChangedPayload,
  ScrollbackWireArchivePurgedPayload,
  ScrollbackWireEvent,
  ScrollbackWireT,
  ServerSettingsWireChangedPayload,
  SessionWireChannelModesWire,
  SessionWireLinksEntry,
  SessionWireMember,
  SessionWireMentionsBundleMessage,
  SessionWireTopicEntryWire,
  SessionWireWhoUser,
  UserSettingsWireAutoAwayDebounceChangedPayload,
  WindowCountsWireEvent,
  WireSessionEvent,
} from "./wireTypes";

// Bi-directional subtype assert helper. `Equal<A, B>` is `true` when
// `A` and `B` are structurally identical, `false` otherwise.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Assert<T extends true> = T;

// === #85 — Featured channels ===
// Public delivery link (HomePane) + the /list directory entry's new
// `featured` flag, pinned to their codegen counterparts.
export type _Assert_FeaturedChannelLink = Assert<
  Equal<FeaturedChannelLink, NetworksFeaturedChannelsWireLink>
>;
export type _Assert_DirectoryEntry = Assert<Equal<DirectoryEntry, ChannelDirectoryWireEntry>>;

// === S3 (2026-07-08 review) — end-to-end gate for the flat wire mirrors ===
// Every hand-rolled `api.ts` type below has a structurally-identical
// codegen counterpart; the `Equal` assert makes ANY drift between the
// two a `tsc` error (`Type 'true' is not assignable to type 'never'`).
// This is the S3 fix: ~90% of the wire was previously an unguarded
// parallel transcription. The gate now covers the scrollback message
// (S14 kind atom union), the mentions bundle (S14 sibling), the query
// window (S43), the /who + /topic + /modes + members payloads, the
// home rows, and the credential JSON (S3 caught `auth_method` drift).
//
// #410 — the leaf ENUM types (MessageKind, ConnectionState, ServicesFlavor,
// DirectoryStatus, ServerReplySource) are no longer asserted here: they are
// now single-sourced in api.ts as `export type X = <generated>` aliases, so
// equality with the codegen type holds BY CONSTRUCTION (an alias can't
// drift). Only the STRUCT mirrors below still need a pin.
//
// Enriched / discriminated types (`WireUserEvent`, `WireChannelEvent`,
// `WireAdminEvent`, `MeResponse`, `Network`) carry cic-side
// consumer enrichments and are validated via their runtime narrowers +
// `assertNever`; their per-arm PAYLOADS that have a flat counterpart
// are pinned below (e.g. `ScrollbackMessage`, `MentionsBundleMessage`).
export type _Assert_ScrollbackMessage = Assert<Equal<ScrollbackMessage, ScrollbackWireT>>;
export type _Assert_MentionsBundleMessage = Assert<
  Equal<MentionsBundleMessage, SessionWireMentionsBundleMessage>
>;
export type _Assert_WhoUser = Assert<Equal<WhoUser, SessionWireWhoUser>>;
export type _Assert_MemberEntry = Assert<Equal<MemberEntry, SessionWireMember>>;
export type _Assert_TopicEntry = Assert<Equal<TopicEntry, SessionWireTopicEntryWire>>;
export type _Assert_ModesEntry = Assert<Equal<ModesEntry, SessionWireChannelModesWire>>;
export type _Assert_QueryWindowEntry = Assert<
  Equal<QueryWindowEntry, QueryWindowsWireWindowsEntry>
>;
export type _Assert_NotifyEntry = Assert<Equal<NotifyEntry, NotifyWireEntry>>;
export type _Assert_HomeNetworkRow = Assert<Equal<HomeNetworkRow, NetworksWireHomeNetworkRow>>;
export type _Assert_HomeData = Assert<Equal<HomeData, NetworksWireHomeData>>;
export type _Assert_CredentialJson = Assert<Equal<CredentialJson, NetworksWireCredentialJson>>;

// === cross-surface S7 (2026-07-19 review) — the biggest boundary payloads ===
// S7 pinned the largest payloads on the wire — WhoisBundle (28 fields, grown
// three times: P-0a, #221, #367 oper_text), WhowasBundle, LusersBundle, the
// NamesReply/WhoReply envelopes, the #238 LINKS bundle and the #247 presence
// arms — because a server-side field add or rename regenerates wireTypes.ts
// cleanly and would leave the api.ts mirror plus its runtime narrower
// silently stale, dropping every such bundle with only console noise.
//
// #1406 removed those pins: all of them named `WireSessionEvent` arms, and
// the walk at the bottom of this file re-derives exactly the same relation
// for the whole 37-arm population. What survives here is the ELEMENT type
// nested inside an arm, which the walk covers only through its container
// and which cic also reuses standalone in its stores.
export type _Assert_LinksEntry = Assert<Equal<LinksEntry, SessionWireLinksEntry>>;

// === cross-surface S1 (2026-07-19 review) — envelope discriminator pins ===
// The envelope `kind` (and Session `state`) discriminators of ~10 Wire
// modules were typed `String.t()` server-side, so codegen emitted
// `kind: string` and cic restated each literal by hand with zero
// compile-time gate — a server rename of any discriminator shipped
// silently past codegen + tsc, then every event of that kind was dropped
// at the cic narrower with only a console.warn. S1 tightened the
// typespecs to literal atoms (Dialyzer now pins the builders; codegen
// emits `kind: "literal"`); these pins tie cic's hand-rolled union arms
// to the generated literal payloads so a future rename is a `tsc` error.
// Each `Extract<Union, {kind}>` also revalidates the arm's full field
// shape (kind + body) against the generated type. These arms come from
// other Wire modules, so no generated union covers them and the #1406 walk
// cannot reach them — they stay hand-pinned.
export type _Assert_ScrollbackMessageEvent = Assert<
  Equal<Extract<WireChannelEvent, { kind: "message" }>, ScrollbackWireEvent>
>;
export type _Assert_ReadCursorSet = Assert<
  Equal<Extract<WireChannelEvent, { kind: "read_cursor_set" }>, ReadCursorWireReadCursorSet>
>;
export type _Assert_WindowCounts = Assert<
  Equal<Extract<WireChannelEvent, { kind: "window_counts" }>, WindowCountsWireEvent>
>;
export type _Assert_NotifyList = Assert<
  Equal<Extract<WireUserEvent, { kind: "notify_list" }>, NotifyWireNotifyListPayload>
>;
export type _Assert_QueryWindowsList = Assert<
  Equal<Extract<WireUserEvent, { kind: "query_windows_list" }>, QueryWindowsWireWindowsListPayload>
>;
export type _Assert_ArchiveChanged = Assert<
  Equal<Extract<WireUserEvent, { kind: "archive_changed" }>, ScrollbackWireArchiveChangedPayload>
>;
export type _Assert_ArchivePurged = Assert<
  Equal<Extract<WireUserEvent, { kind: "archive_purged" }>, ScrollbackWireArchivePurgedPayload>
>;
export type _Assert_AutoAwayDebounceChanged = Assert<
  Equal<
    Extract<WireUserEvent, { kind: "auto_away_debounce_changed" }>,
    UserSettingsWireAutoAwayDebounceChangedPayload
  >
>;
export type _Assert_ServerSettingsChanged = Assert<
  Equal<
    Extract<WireUserEvent, { kind: "server_settings_changed" }>,
    ServerSettingsWireChangedPayload
  >
>;
export type _Assert_ConnectionStateChanged = Assert<
  Equal<
    Extract<WireUserEvent, { kind: "connection_state_changed" }>,
    NetworksWireConnectionStateEvent
  >
>;

// bundle_hash: cic's arm carries the deliberate post-narrow enrichment
// `version: string | null` (absent → null) vs the wire's `version?:
// string` (cross-surface S2), so a full-shape Equal cannot hold. Pin the
// `kind` discriminator only — that is the rename gap S1 closes.
export type _Assert_BundleHashKind = Assert<
  Equal<Extract<WireUserEvent, { kind: "bundle_hash" }>["kind"], CicWireBundleHashPayload["kind"]>
>;

// === #1406 — the Session arm population is WALKED, not listed ===
// Every pin above names its arm by hand, so a new server arm lands with no
// pin unless a human remembers to write one. That is not a lapse, it is the
// shape of the mechanism: the maintenance note at the top of this file asks
// for a line per type, and 16 of the 37 `WireSessionEvent` arms never got
// one. Codegen already emits the exhaustive union, so the population can be
// quantified over instead of transcribed — and then a new server arm is
// covered the moment codegen emits it, and the pins for the arms it covers
// stop being a list anybody has to maintain.
//
// Two failures are checked separately, because they fail differently:
//
//   * `_Assert_NoUndeclaredArm` — a generated arm cic declares on NEITHER
//     topic. No hand pin can catch this class at all: there is nothing yet
//     to write the pin about.
//   * `_Assert_No{User,Channel}ArmDrift` — a generated arm whose cic copy
//     has a different shape. Walked per union rather than over their union,
//     so the four dual-topic arms (`joined`, `join_failed`, `kicked`,
//     `isupport_changed`) are pinned to the generated payload on BOTH
//     topics, which pins the two copies to each other as a side effect.

// `Flatten` first: many cic arms are declared as an INTERSECTION with the
// standalone type their stores reuse (`({ kind: "whois_bundle" } &
// WhoisBundle)`), and an intersection is never `Equal` to the flat object
// it is equivalent to — `Equal` compares type identity and `A & B` keeps
// both operands. The homomorphic mapped type collapses it into one object,
// preserving optional and readonly modifiers. Without it the walk reports
// every intersection-declared arm as drift and the exemptions below would
// have to swallow the mechanism whole.
type Flatten<T> = { [K in keyof T]: T[K] };

// The empty-set check is spelled as a MAPPED TYPE rather than
// `Equal<T, never>` so the tsc error NAMES the offending arms — it prints
// `Type '{ recover_progress: "…"; }' does not satisfy the constraint
// 'true'` — instead of the anonymous `Type 'false' is not assignable to
// type 'true'` the pins above produce. A tuple `[Message, T]` does NOT
// work: tsc prints the unexpanded alias reference inside it.
type NoArms<Message extends string, T> = [T] extends [never]
  ? true
  : { [K in T & string]: Message };

// Arms whose cic copy diverges from the generated payload ON PURPOSE, each
// mapped to the ONE field it widens. This is not an exemption list with a
// hole in it: `_Assert_NoWidening{User,Channel}Overrun` below re-checks
// every OTHER field of these arms exactly, and checks that the widened
// field is a genuine SUPERSET of what the server can send. Adding a kind
// here without naming its field does not type-check.
//
// All three entries are the same posture, and it is the additive-only wire
// rule (#447) reaching the type layer: a value that only SELECTS COPY must
// not be allowed to drop its event when the server adds to its vocabulary.
//
//   * `isupport_changed.frame_budget_base` (#1108) — absent means a server
//     predating the field, the realistic case being a cic-only bundle
//     deploy. `narrowIsupportChanged` degrades to `null` rather than
//     rejecting the envelope, which would take the whole capability table
//     (and with it the /mode toggles) down.
//   * `recover_progress.reason` / `recover_result.reason` (#581) — kept a
//     nullable string, deliberately NOT hardened to the token union, so an
//     additive server reason can never drop a terminal recovery result;
//     `RecoverModal.reasonCopy` maps the known tokens and falls back.
//     #1338 X-S14 widened `web_session_severed.code` citing exactly this
//     posture, so hardening these two would reverse a standing ruling.
//
// The generated type describes the server we ship; a widened field
// describes the set of servers cic must survive. That is why these are not
// drift — and why the widening still has to be bounded.
type DeliberatelyWidened = {
  isupport_changed: "frame_budget_base";
  recover_progress: "reason";
  recover_result: "reason";
};

type WidenedArm = keyof DeliberatelyWidened & WireSessionEvent["kind"];
type WalkedArm = Exclude<WireSessionEvent["kind"], WidenedArm>;

type GeneratedArm<K extends WireSessionEvent["kind"]> = Extract<WireSessionEvent, { kind: K }>;

// Index by a key tsc can prove is present. A bare `T[DeliberatelyWidened[K]]`
// is rejected inside the generic walk; `Extract<F, keyof T>` is assignable to
// `keyof T`, and the `extends keyof` guard at the call site keeps the absent
// case from resolving to `never` and passing vacuously.
type At<T, F> = T[Extract<F, keyof T>];

type DriftedIn<U extends { kind: string }> = {
  [K in WalkedArm]: K extends U["kind"]
    ? Equal<Flatten<Extract<U, { kind: K }>>, Flatten<GeneratedArm<K>>> extends true
      ? never
      : K
    : never;
}[WalkedArm];

// A widened arm overruns its exemption when anything OTHER than the named
// field differs, or when the named field stops covering every value the
// generated type admits (`[Gen] extends [Cic]` — cic must accept at least
// what the server can send; a server-side retype of the field lands here).
type WideningOverrunIn<U extends { kind: string }> = {
  [K in WidenedArm]: K extends U["kind"]
    ? Equal<
        Flatten<Omit<Extract<U, { kind: K }>, DeliberatelyWidened[K]>>,
        Flatten<Omit<GeneratedArm<K>, DeliberatelyWidened[K]>>
      > extends true
      ? DeliberatelyWidened[K] extends keyof GeneratedArm<K>
        ? [At<GeneratedArm<K>, DeliberatelyWidened[K]>] extends [
            At<Extract<U, { kind: K }>, DeliberatelyWidened[K]>,
          ]
          ? never
          : K
        : K
      : K
    : never;
}[WidenedArm];

export type _Assert_NoUndeclaredArm = Assert<
  NoArms<
    "generated Session arms cic declares on neither topic",
    Exclude<WireSessionEvent["kind"], WireUserEvent["kind"] | WireChannelEvent["kind"]>
  >
>;
export type _Assert_NoUserArmDrift = Assert<
  NoArms<"user-topic arms whose cic copy differs from codegen", DriftedIn<WireUserEvent>>
>;
export type _Assert_NoChannelArmDrift = Assert<
  NoArms<"channel-topic arms whose cic copy differs from codegen", DriftedIn<WireChannelEvent>>
>;
export type _Assert_NoWideningOverrunUser = Assert<
  NoArms<
    "user-topic arms widening more than their declared field",
    WideningOverrunIn<WireUserEvent>
  >
>;
export type _Assert_NoWideningOverrunChannel = Assert<
  NoArms<
    "channel-topic arms widening more than their declared field",
    WideningOverrunIn<WireChannelEvent>
  >
>;
