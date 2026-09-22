# Architecture Review — 2026-09-22

**Base:** `main` @ `c678ea5a`.
**Method:** 6 concern agents per `.claude/skills/review` (architecture mode), dispatched in parallel, each following its concern across the whole tree rather than a directory. Read-only: no `mix`, no `bun`, no docker. Every count below is a command an agent ran, and the counts two agents disagreed on were re-run and reconciled before this document was written (see *Reconciled counts*).
**Previous review:** 2026-08-15 @ `575e203a` — 38 days, 1,934 commits. An interim review ran on 2026-09-13 but was filed only as issue #2118, not under `docs/reviews/`, so this document compares against 2026-08-15 and cites #2118 where its follow-ups (#2132, #2135, #2137) changed a number.
**Scope, new this time:** `frontends/shottino/` — a standalone C terminal client of the same REST + Phoenix Channels wire. It is 50,002 lines of C (vendor excluded), so the wire now has three consumers: cicchetto, shottino, and the planned Phase-6 IRCv3 listener. The TypeScript codegen reaches only the first.

**Size of what was reviewed.** Production code 283,141 lines (server 112,564; client 94,965; shottino 50,002; client CSS 16,043; migrations 7,445; config 2,122). Tests 351,130 lines (server 145,950; client unit 131,497; client e2e 73,683). No agent read all of it; each read what its concern touched and backed its claims with greps.

## Severity summary

New findings as each agent reported them:

| Concern | CRITICAL | HIGH | MEDIUM | LOW | Findings |
|---------|---------:|-----:|-------:|----:|---------:|
| Abstraction boundaries | 0 | 2 | 2 | 2 | 6 |
| Responsibility & cohesion | 0 | 1 | 4 | 1 | 6 (+2 re-raised) |
| Duplication | 0 | 1 | 7 | 3 | 11 |
| Dependency architecture | 0 | 1 | 2 | 3 | 6 |
| Type system leverage | 0 | 1 | 3 | 2 | 6 |
| Extension & maintainability | 0 | 3 | 5 | 1 | 9 |
| **Total (raw)** | **0** | **9** | **23** | **12** | **44** |

**The nine raw HIGHs are four findings.** Five of them are the same shottino finding seen from five concerns, and two more are the same wire-pin finding seen from two. Zero CRITICAL.

### What this review says, in one paragraph

**The server-side debt the last review named is being paid down, and the new debt is at the edges of the wire contract.** Of the 21 prior HIGHs, 5 are fixed and 12 partially fixed; 4 are still open and none regressed. `Session.Server` is no longer outgrowing the codebase (its share of `lib` fell from 8.2% to 7.8% and its state-key count is flat). What is new is that the contract grew a third consumer that nothing checks: shottino hand-mirrors every closed set and every field it reads, and its only gate compares one integer. That gate passed while five pieces of the contract had moved underneath it (below). Separately, the gate that is supposed to make `protocol_version` total cannot see most controller responses, and the version number itself has become the single most-contended line of code in the repository.

### The four HIGHs

**H-N1. shottino is a third, ungated copy of the wire contract, and five pieces of it have already drifted.** *(Abstraction A16, Types A1, Dependency A1, Duplication A1, Extension A3.)* Every closed set and field shottino reads is typed by hand in C. Its only drift gate, added 2026-09-21, checks that `WIRE_PROTOCOL_VERSION` equals the server's integer; both are 30, so it passes. Measured on the tree, each verified by grep for this document:

| Drift | Server | shottino | Effect |
|---|---|---|---|
| `:failing` connection state (#1675, v5) | `credential.ex:123` has 4 values | `wire.c:32` has 3 | every `connection_state_changed` touching `failing` is **dropped whole**, and the REST seed marks the row unknown |
| `admin` server-reply source | `session/wire.ex:419` has 4 sources | `wire.c:691-693` accepts 3 | every `/admin` reply is **dropped** |
| `row_count` on archive entries | removed at v8 (#1626) | still read at `shottino.c:5527` | the ROWS column silently prints 0 |
| 7 user-topic event kinds | emitted by `session/wire.ex`, `user_settings/wire.ex` | unknown to `wire.c` | events ignored |
| `text/markdown` uploads (#1764) | accepted | missing from `mime_for_path` | `/upload notes.md` refused locally |

The version pin proves someone looked at `protocol.ex`, not that shottino learned what changed. **Fix:** have `mix grappa.gen_wire_types` emit a C header of closed-set tables (and a language-neutral field manifest) under the same `--check` gate, and have shottino's tests assert against it. Teach `wire.c` `failing` and `admin` now; each is a one-line change.

**H-N2. The wire pin cannot see most controller responses, so `protocol_version` is not total over REST.** *(Abstraction A15, Extension A1; Types A2 is the codegen half.)* The pin digests the generated TypeScript artefacts and the `@spec`s of `GrappaWeb.*JSON` views. 43 of 55 controllers render inline instead, and after reconciliation about **43 inline map literals carry domain data** outside the pin (see *Reconciled counts*). `protocol.ex` itself records the pin answering green on a real wire change five times (v10, v11, v21, v24, v29); each bump happened only because an author remembered. **Fix:** add the router's route table to the digest, and make a `*JSON` view or `*.Wire` function mandatory for any non-trivial response body, enforced by a test that fails on an inline literal carrying more than `ok:`/`error:`.

**H-N3. `@protocol_version` is a global serialization point.** *(Extension A2.)* 28 bumps in 38 days; `protocol.ex` changed in 36 commits and `shape.pin` in 31, making them the #4 and #6 code hotspots. Three concurrent-branch collisions are recorded in the file. The number now lives in four places across three languages, and a rebase conflicts on only one of them. **Fix:** generate `PROTOCOL_VERSION` into `wireTypes.ts` and the shottino C header from `Grappa.Protocol.version/0`, so bumping is one line and a collision conflicts on exactly that line.

**H-N4. `shottino.c` is a 23,790-line single translation unit, past the size its own no-split ruling assumed.** *(Responsibility A3 HIGH, Extension A5 MEDIUM.)* One `struct app` with 159 fields, 483 functions, and a single 1,189-line command dispatcher with 103 arms. Six test files `#include` the whole `.c`. The ruling that declined to split it (P4.7, 2026-08-01) rested on "14.7k lines"; the file has grown 61% since, and the two splits that ruling said "would pay" — the ircd bridge and the LLM/bot cluster — are still inside. **Fix:** re-open P4.7 on today's numbers, extract the ircd bridge and the bot cluster behind narrow host vtables, and replace the dispatcher with a verb table, as cicchetto did in #1396.

## Reconciled counts

Two agents measured some things with different greps and got different answers. Each was re-run for this document.

| Quantity | Agents reported | Reconciled | Why they differed |
|---|---|---|---|
| Inline JSON map literals in controllers | 34 in 21 files (abstraction); 147 in 37 files (extension) | **151 on-line literals in 39 files**, of which 92 are `%{error: …}` envelopes and 13 are trivial (`%{}`, `%{ok: true}`), leaving **~43 that carry domain data** (29 in the `json(conn, %{` form + 14 in the piped `\|> json(%{` form) | The 34 counted only `json(conn, %{`; the 147 counted every literal, error envelopes included |
| `(await res.json()) as` casts at the REST edge | 55 (types); 47 (duplication) | **55**: `api.ts` 29, `userSettings.ts` 20, `push.ts` 3, `themesApi.ts` 2, `serverSettings.ts` 1 | different pattern |
| `Session.Server` state keys | prior review said 83–87 | **82 at both `575e203a` and `c678ea5a`**, same regex both trees (two agents independently) | the prior "87" does not reproduce; retracted |
| Components importing `api.ts` | 35 of 99 (abstraction); 35 of 96 (dependency) | **35** | denominator glob differs; the numerator agrees |

## Prior HIGH findings (2026-08-15) — status

| # | Finding | Status | Evidence |
|---|---|---|---|
| H1 | `EventRouter` 4-key state contract + `optional(any())` | **FIXED** | now `@type state :: Session.Server.t()` (#2132) |
| H2 | Five reply-bundle accumulators as bare `map()` | **FIXED** | five `*_accum.ex` structs; `Map.get(accum` in `Session.Wire` 43 → 0 |
| H3 | `Grappa.Subject` SSOT adopted by 3 of 5 contexts | PARTIAL | private spellings gone; 4 literal type re-declarations remain |
| H4 | Codegen membership by filename; `Push.Payload` outside | OPEN | now three nominal rules instead of one (see H-N2) |
| H5 | Sub-machine extractions left bespoke interpreters | PARTIAL | a third private action vocabulary added (`DirectoryIngest`); three timer disciplines |
| H6 | No outbound-line door | PARTIAL | `send_outbound/3` exists with 1 caller; `/quote` and perform still hand-pair |
| H7 | User login policy in an 888-line controller | PARTIAL | decision moved to `Accounts.Login`; controller 902 lines, keeps throttles by stated reason |
| H8 | `compose.ts` god module | **FIXED** | 2,345 → 1,529 lines; 14 `lib/commands/*` modules (#1396) |
| H9 | 162 runtime schemas generated, 3 used | PARTIAL | 196 generated / 64 imported; per-channel topic still 0% |
| H10 | Server test helpers re-declared 12–20× | PARTIAL | the six named helpers now defined once; `visitor_fixture` shadowed ×5 |
| H11 | 60+ copies of nine e2e helpers | PARTIAL | the nine consolidated; 23 other helpers now ×98 copies |
| H12 | `Networks → Session` inversion, escape hatches growing | PARTIAL | `dirty_xrefs` 5 → 0; closures 10 → 11; inversion intact |
| H13 | Three incompatible "schema-only dep" resolutions | **FIXED** | struct-only `Accounts` deps 13 → 0; leaf promotion is the only pattern |
| H14 | 73 of 165 generated types unconsumed | PARTIAL | 94 of 201 have no direct importer; hot-path union still hand-written but structurally pinned |
| H15 | Eleven numeric-bundle accumulators as `map()` | PARTIAL | five became structs; six remain, four sharing one shape |
| H16 | 83 `as`-casts on `.json()` at the REST edge | PARTIAL | 83 → 55 |
| H17 | Runtime-schema codegen stopped at 3 of 162 | PARTIAL | 64 imported; `narrowChannelEvent` still hand-written |
| H18 | New scrollback kind forces a table recreate (CHECK duplicates `Ecto.Enum`) | OPEN | CHECK unchanged; the recreate target is now a 403,907-row table |
| H19 | Window-state set restated in six places | **FIXED** | aliased to the generated type (#1402) |
| H20 | `Session.Server` 7,230 lines as the merge-conflict epicentre | OPEN | 8,789 lines, `handle_info` 40 → 57, still the #1 code hotspot (63 commits); relative growth slowed |
| H21 | One new IRC verb costs 23 files | OPEN | no verb table; no new outbound verb landed to re-measure |

**Tally: 5 FIXED, 12 PARTIAL, 4 OPEN, 0 REGRESSED.** Among the lower-severity priors there are regressions, each re-raised in its concern section: `lib → component` imports (2 → 4), `as ChannelKey` escapes (14 → 17), legacy-tolerance optionals on `RawNetwork` (9 → 15), `SettingsDrawer` (+62.8%, 5 of 12 pages still inline), `UserSettings` (+60.7%, key constants 9 → 15), and the upload MIME taxonomy (a new drifted copy in shottino).

## Triage — must-fix (the four distinct HIGHs)

| # | Finding | Raw findings merged | Bucket |
|---|---|---|---|
| H-N1 | shottino ungated wire copy, 5 measured drifts | Abstraction A16, Types A1, Dependency A1, Duplication A1, Extension A3 | A shottino-contract |
| H-N2 | Wire pin blind to inline controller bodies | Abstraction A15, Extension A1 | B wire-contract-membership |
| H-N3 | `protocol_version` as a global serialization point | Extension A2 | C protocol-number |
| H-N4 | `shottino.c` monolith past its ruling's premise | Responsibility A3, Extension A5 | D shottino-structure |

H-N1 and H-N3 share a cure: a generated C artefact from `gen_wire_types` carries both the closed sets and the version number. H-N2 retires prior H4 in the same move.

## Triage — gating MEDIUMs

- **A shottino-contract:** Responsibility A4 (shottino re-derives mentions, channel names and `/ignore`, each differently; the mention predicate now has four implementations with three answers), Dependency A2 (`--ircd` advertises a hardcoded `CASEMAPPING=rfc1459` while the wire carries the real value and shottino's own fold is ASCII — the #525/#537 identity fork reintroduced one hop out, with no ruling on the facade vs Phase 6), Abstraction A20 LOW (shottino overrides server window classification).
- **B wire-contract-membership / REST edge:** Types A2 (8 of 12 `*_json.ex` views outside codegen, 20 of the 55 casts in `userSettings.ts`), Abstraction A18 (REST transport spread across eight modules with their own headers and error handling — the structural reason `readError` keeps being bypassed), Duplication A4 (`GET /networks` hand-typed with every field optional beside unused generated schemas).
- **E wire-codegen (client):** Duplication A2 (`narrowChannelEvent` still 0% on generated schemas — ~508 hand-narrower lines remain), Duplication A3 (54 of 59 hand event arms proven identical to generated ones; a double-declared `isupport_changed` whose comments contradict runtime behaviour).
- **F session-decomposition:** Responsibility A1 (the DCC lifecycle landed in `Session.Server` in the exact shape #1390 had just removed), A2 (`EventRouter`, documented as pure, starts an HTTP + DB + disk task outside its effect union), A5 (session-spawn assembly across 10 sites in 6 modules, one a controller).
- **G settings:** Responsibility A7 (`UserSettings` absorbing unrelated domains, now per-network `ignores`), A8 (`SettingsDrawer` 55 signals).
- **H boundary-hygiene:** Dependency A3 (nine phantom `deps:` edges and four sites still designing around a cycle that no longer exists; Boundary 0.10.4 cannot report unused deps).
- **I types:** Types A3 (#2132's cure stopped at `EventRouter`; 7 `optional(any())` catch-alls remain on sibling projections), A4 (the AdminEvents ring mixes atom-keyed and string-keyed events after a reboot under one spec).
- **J closed-sets:** Duplication A5 (20 of 29 generated consts unconsumed; fonts, colour keys and presence hand-copied), A6 (MIME taxonomy, 6 places in 3 languages), A7 (`CONTENT_KIND_PROJECTION` still a hand mirror).
- **K wire-semantics:** Abstraction A17 (positional IRC parameters decoded per verb in a cicchetto view component; shottino renders the same rows differently).
- **L test-harness:** Extension A7 (the LockWatch suite — 38 tests — is quarantined out of every CI run, flaky by design, on the module that watches production write-lock incidents), A6 (393 synchronous `vi.mock` factories restating module surfaces), Duplication A8 (23 e2e helpers ×98 copies, one with a forked signature).
- **M maintainability:** Extension A4 (`default.css`, 16,043 lines, the #1 code hotspot at 85 commits), A8 (decision narrative inside hot files — `protocol.ex` is 89% comments, and its prose is what conflicts).

LOW findings (12) are improvement opportunities; see each concern's section.

**Security.** Hardening items are tracked out of band and are deliberately absent from this document.

**Checkpoint.** The review skill says to update the active checkpoint. `docs/checkpoints/` does not exist in this repository, so there is none to update; this document is the record.

---

## Concern: abstraction boundaries

Base `main` @ `c678ea5a`. All counts come from `grep`/`wc` runs against the working tree. Nothing was built or run. There is a 2026-09-13 review (#2118) between the two, and its A4/A7 work is recorded in DESIGN_NOTES entry #2135. Where that entry corrects a count, it is said so.

### Status of prior findings (2026-08-15)

**A1: FIXED, though not the way that review recommended.** `event_router.ex:139` now reads `@type state :: Session.Server.t()`, which drops the old 4-key map with `optional(any())`. `Server.t` (`server.ex:494`) has no catch-all in its body. The typedoc (`:116-137`) records the measured gain: a field rename went from 2 errors to 6. The seven `Map.get(state, :key)` sites the type still cannot see are pinned by `StateContractDriftTest`. The review had recommended the narrow projection that `NumericRouter` uses; issue 2132 chose to widen to the host type instead. The premise ("Dialyzer accepts anything") no longer holds.

**A2: FIXED.** All five accumulators are now structs with `@type t`: `whois_accum.ex:51/85`, `whowas_accum.ex:26/34`, `links_accum.ex:26/33`, `lusers_accum.ex:24/39`, `list_mode_accum.ex:25/33`. `Session.Wire.whois_bundle/4` pattern-matches `%WhoisAccum{}` (`wire.ex:1650-1652`). `grep -c "Map.get(accum" lib/grappa/session/wire.ex` returns 0 (it was 43).

**A3: PARTIAL.**
- Fixed: no private `subject_where`/`subject_filter`/`subject_attrs` remains (`grep -rn "defp subject_where\|defp subject_filter\|defp subject_attrs" lib` is empty). Scrollback (`scrollback.ex:57,378,486`) and ReadCursor (`read_cursor.ex:99,115`) both use `Grappa.Subject`.
- Still open:
  - Four literal re-declarations of the subject type remain. `accounts.ex:110` repeats the SSOT verbatim. `accounts/revocations.ex:100` and `rate_limit/request_budget.ex:63` use `String.t()` in place of `Ecto.UUID.t()`. `session_log.ex:102` uses `{:user | :visitor, String.t()}`.
  - `Session.put_subject_id/2` (`session.ex:2446`) is still a second public spelling that delegates to `Subject.put_subject_id/2`, with 8 in-Session callers.
  - `admin/uploads_controller.ex:92+` re-derives the XOR in the web layer (`subject_kind(%{user_id: id})`).

**A4: OPEN.** Membership is still nominal, and there are now three rules instead of one:
1. the path glob `@wire_glob "lib/grappa/**/*wire.ex"` (`lib/mix/tasks/grappa/gen_wire_types.ex:116`);
2. a hand-kept module list `@extra_modules [AuthJSON, BootJSON, ErrorTokens, MeJSON]` (`:141-146`), whose own comment says a new envelope "MUST be added here in the same commit… or the pin green means only 'nothing I was looking at moved'";
3. a beam-name glob `"Elixir.GrappaWeb.*JSON.beam"` in `wire_pin.ex:147`.

`Push.Payload` is still outside all three. Its shape is now declared twice on the server, identically: `push/payload.ex:114-120` and `push/sender.ex:227-233`. It is mirrored twice on the client: `cicchetto/src/lib/pushPayload.ts:26` (the type) and `:46` (a hand narrower). The client comment points at `Grappa.Push.Sender.payload()`, the wrong one of the two server copies.

**A5: OPEN.** `readCursor.ts:295-305` and `serverSettings.ts:132-136` still call `fetch` directly and never reach `readError`. `userSettings.ts` still builds the error from `statusText` at 5 GET sites (`:85, :138, :184, :248, :298`). New finding A18 covers the wider version.

**A6: OPEN.** `RawNetwork` + `tagNetwork` are still in `api.ts:519-575`. `api.ts` imports 0 schemas from `wireSchema.ts`. Its REST edge is split: 32 `.json()` reads go through `narrow*`, and 29 are `(await res.json()) as T` (line-scoped grep; entry #2135 measured 34 with a comment-stripping tool).

**A7: OPEN.**
- 41 `export type X = {` object literals are hand-written in `api.ts`. Response shapes among them include `TotpEnrollment:210`, `PasskeyStatus:1782`, `AdminSettingsView:2356`, `IgnoresResponse:2927`, `PerformView:3157` and `ShareTokenMintResponse:3576`.
- `admin/settings_controller.ex` still hand-assembles `addressing`.
- Two controllers now project schemas themselves: `admin/uploads_controller.ex:77` (`row_to_json(%Grappa.Uploads.Upload{})`) and `passkey_controller.ex:325` (`public_passkey/1`).

**A8: OPEN, and grew.**
- `api.ts` is 3,604 lines (was 3,159), with 114 value exports and 108 type exports. 107 non-test modules import it.
- Of 99 component files (`src/*.tsx` + `src/admin/*`), 35 import it.
- 19 call transport functions directly: the 7 admin tabs, `ArchiveModal`, `DirectoryPane`, `HomePane`, `PasskeySettings`, `PerformSettings`, `ShareConsume`, `ShareSessionModal`, `SubjectAutocomplete`, `TopicBar`, `TotpSettings`, `WatchlistsSettings` and `main.tsx`.
- 4 import domain helpers from the transport module (`ownNickForNetwork`, `isContentKind`, `displayNick`, `visitorNetworkNick`): `MembersPane`, `ScrollbackPane`, `SettingsDrawer`, `Shell`.

**A9: OPEN.**
- `cicchetto/src/lib/` holds 258 non-test `.ts` modules at the root (was 218), plus one subdirectory, `lib/commands/` (14).
- "Join + focus" is still spelled three ways: `lib/channelJoin.ts:37` (`switchToChannelWindow`, which folds); `DirectoryPane.tsx:231/252` (folds inline, per #731); `HomePane.tsx:78/86`, which focuses with the raw `name` — safe only because featured channels happen to be stored folded.

**A10: PARTIAL.** `compose.ts` shrank from 2,345 to 1,529 lines, and the commands moved into `lib/commands/*` (14 files). The `queryTopicJoin.ts` indirection is still there because `subscribe.ts` (1,542 lines) still boots its `createRoot` as an import side effect (`queryTopicJoin.ts:6-9`).

**A11: OPEN, and the drift is worse.** The prose registry in `user_settings/settings.ex:28-40` lists 6 keys. The code uses 16: 14 `@*_key "…"` attributes in `user_settings.ex:260+`, plus the literals `"highlight_patterns"` (7 uses) and `"muted_targets"` (4 uses). There is still no enumerable key set in code.

**A12: PARTIAL.** `priv/wire/schema_inventory.md` reports 196 schemas generated, 64 imported, 132 reachable and 64 never read. The prior count was 3 wired. None of the imports is on the REST edge.

**A13: OPEN.** The channel's `{:ok, …}` replies are still inline maps: `grappa_channel.ex:1029` (`%{user: entry.user, host: entry.host}`, a projection of the userhost cache); `:1527/:1584/:1599` (`%{patterns: …}`); `admin_channel.ex:88` (`push(socket, "snapshot", %{events: …})`). The 53 error-token replies are pinned by `ErrorTokens` and its drift test, which is sanctioned.

**A14: OPEN.** `ownNickForNetwork(net, me)` (`api.ts:467-470`) uses `me` only as a null gate. It has 11 non-test callers, and each has to thread `user()` through.

---

### A15. The protocol-version pin cannot see inline controller payloads, so "total" `protocol_version` cannot be enforced there
**Concern:** Abstraction boundaries
**Severity:** HIGH
**Scope:** `lib/mix/tasks/grappa/wire_pin.ex`, `lib/mix/tasks/grappa/gen_wire_types.ex`, `lib/grappa_web/controllers/**`, `lib/grappa_web/channels/grappa_channel.ex`
**Problem:**
- CLAUDE.md (#1393d) makes `protocol_version` bump on every wire-shape change and says a single un-bumped addition makes the number lie forever.
- The enforcement, `priv/wire/shape.pin`, digests three things only: the generated `wireTypes.ts`, the generated `wireSchema.ts`, and the `@spec`s of `GrappaWeb.*JSON` beams (header of `shape.pin`; `wire_pin.ex:147`).
- `grep -rn "json(conn, %{" lib/grappa_web` finds 34 sites in 21 controller files, none of them a `*JSON` view. 5 are trivial (`%{}`, `%{ok: true}`); 29 carry domain data. Examples: `passkey_controller.ex:31` (`mode` + `public_passkey/1`, a schema projection in the controller); `totp_controller.ex:46` (the enrollment); `admin/uploads_controller.ex:48` (a projection of `%Upload{}`); `admin/vhosts_controller.ex:59`; `server_settings_controller.ex:48` (`http_host_aliases`); `ignores_controller.ex:81`; `read_cursor_controller.ex:94`.
- Channel `{:reply, {:ok, %{…}}}` payloads (A13) sit outside the pin as well.
- A field added at any of these sites changes what clients receive with no signal from `wire_pin --check`.
- The pin's own header states the failure mode: "a field added to one of those views moved neither artefact, and this gate said `agree.`" (#2037). That was cured only for the `*JSON` class.
**Impact:** The client-facing number is total only over the part of the wire whose file or module name matches a pattern. A client reading `server >= N` as "has what N had" can be wrong for REST endpoints it actually calls: TOTP, passkeys, ignores, DCC offers, read-cursor. Both cicchetto and shottino depend on those numbers.
**Recommendation:** Make contract membership declarative and total over emitters, not names. (1) Move every non-trivial inline `json(conn, %{…})` into the owning context's `*.Wire` module, or into a `GrappaWeb.*JSON` view that exports a named `@type`. (2) Add a Credo check or AST test in the style of `error_tokens_drift_test.exs` that fails on any `json/2` or `{:reply, {:ok, map}}` whose payload is a literal map with non-literal values. (3) Then extend `wire_pin` to cover the set that test enumerates rather than a glob. This retires A4's three nominal rules in the same move.

### A16. shottino consumes the wire through two disciplines, and its hand mirror has already drifted
**Concern:** Abstraction boundaries
**Severity:** HIGH
**Scope:** `frontends/shottino/wire.{c,h}`, `frontends/shottino/shottino.c`, `frontends/shottino/json.c`
**Problem:**
- The WS surface goes through a single decoder, `wire_narrow` (`wire.h:591`, `wire.c`: 135 `json_*_req/opt` calls). It describes itself as "the C twin of cicchetto's `lib/wireNarrow.ts`… so the two can be diffed by eye" (`wire.h:1-6`). No generated artefact targets C.
- REST is parsed ad hoc across `shottino.c`, a 23,790-line file: 39 `http_request(` call sites, 16 `json_parse(` and 67 raw `json_get(` reads; envelope guessing — `rows_of()` (`shottino.c:5510-5516`) takes a bare array OR `root[key]` OR `root["data"]`; the directory reader (`:19166-19167`) tries `"channels"` and then `"entries"`.
- Measured drift: (1) `render_archive_rows` reads `row_count` (`shottino.c:5527`). That field was removed from the archive entry at protocol v8 (#1626; `scrollback/wire.ex:83`). The file declares `WIRE_PROTOCOL_VERSION 30` (`wire.h:56`), matching the server's `shape.pin`. Its ROWS column therefore always prints 0, silently: `json_long` fails and `count` keeps its default. (2) Seven event kinds that cicchetto narrows are unknown to `wire.c`: `auto_away_debounce_changed`, `auto_away_reason_changed`, `quit_part_reason_changed`, `recover_progress`, `recover_result`, `session_identity_changed`, `whois_avatar_ready`. All seven are emitted by `session/wire.ex` or `user_settings/wire.ex`. Found with `comm` over `case "…"` labels in `userTopic.ts`+`wireNarrow.ts` against string literals in `wire.c`.
- The `test_commands` pin (`tests/test_commands.c:269-291`) compares the number only. It went green at 30 with a v8 removal still being read.
**Impact:** The third wire consumer can silently show wrong data. Its only drift gate checks a number, not a shape. Every REST shape it reads is a fourth hand copy (server spec, `wireTypes.ts`, `api.ts`, `shottino.c`), and those copies sit in the file least suited to review.
**Recommendation:** (1) Move every REST read in `shottino.c` behind typed `wire_narrow_<endpoint>` functions in `wire.c`, one per endpoint, with the same strict "drop as a unit" contract as the WS arms, and delete `rows_of`'s guessing. (2) Emit a language-neutral artefact from `gen_wire_types` (JSON Schema, or a flat field manifest under `priv/wire/`). Add a shottino test that checks each `wire_narrow*` field list against it. That turns "diffed by eye" into a gate and catches reads of removed fields such as `row_count`.

### A17. The IRC parameter vector crosses the wire, and per-verb IRC semantics live in a cicchetto view component
**Concern:** Abstraction boundaries
**Severity:** MEDIUM
**Scope:** `lib/grappa/scrollback/meta.ex`, `lib/grappa/session/event_router.ex` (`persist_raw_event/3`), `cicchetto/src/ScrollbackPane.tsx:525-680`, shottino
**Problem:**
- `meta.raw_verb`, `raw_sender` and `raw_params :: [String.t()]` (the positional IRC parameter list, per `meta.ex:69-90`) are persisted and pushed to clients.
- `ScrollbackPane.tsx` decodes them with protocol knowledge: `renderRawEvent` has 6 per-verb arms (`WALLOPS`, `GLOBOPS`, `KILL`, `ERROR`, `CHGHOST`, `INVITE`) that read positions (`KILL` target = `params[0]`, trailing = last); `renderNumeric` drops `raw_params[0]` on the assumption that it is always the recipient's own nick.
- #424 (design_notes/2026-07.md:11355-11405) sanctions `raw_params` as the no-silent-drop floor, and names the structured path ("add it to `@delegated_numerics` + an EventRouter bundle") as the way forward for anything that needs a view. The per-verb decoding in the client goes beyond that floor.
- shottino reads no `meta` at all: `wire_scrollback_message.meta` is "opaque bag, read per call site" (`wire.h:214`), and `grep -c meta shottino.c` finds only 4 comment hits. The same rows therefore render differently in the two clients.
**Impact:** IRC positional semantics now live in a UI component of one client, against the spirit of "one IRC parser, on the server; cicchetto consumes typed JSON events". Each new verb costs a client arm, and every other consumer (shottino, the Phase-6 facade) has to re-learn or lose it.
**Recommendation:** Keep `raw_params` as the floor. Promote each verb cicchetto already special-cases to a typed `meta` shape built in `EventRouter` (for example `kill: %{target, reason}`, `chghost: %{user, host}`), declared in `Scrollback.Meta`, so the client renders fields rather than positions. Delete the positional arms as each verb lands.

### A18. cicchetto's REST transport is spread across eight modules, each with its own headers, error and decode handling
**Concern:** Abstraction boundaries
**Severity:** MEDIUM
**Scope:** `cicchetto/src/lib/{api,userSettings,push,themesApi,readCursor,serverSettings,uploadHost,auth}.ts`
**Problem:**
- `grep 'Bearer ${'` outside `api.ts` finds 29 sites across 7 modules: `userSettings.ts` 20, `push.ts` 4, and 1 each in `readCursor.ts`, `serverSettings.ts`, `themesApi.ts`, `uploadHost.ts` and `auth.ts`.
- `api.ts` exports `buildHeaders` (`:108`), which none of them uses.
- Raw `fetch(` against grappa's own API, outside `api.ts`: `userSettings.ts` 20, `themesApi.ts` 14, `push.ts` 5, `readCursor.ts` 1, `serverSettings.ts` 1.
- Casts: `userSettings.ts` has 20 `(await res.json()) as`, `push.ts` 3, `themesApi.ts` 2, `serverSettings.ts` 1, with zero narrowers among them.
- The 401 dead-token hook lives inside `readError` (`api.ts:1629`). Any module that skips it (A5) also skips session-death detection.
**Impact:** Policy that is supposed to be written once has several independent copies: auth header, 401 handling, error envelope, response validation. A change to any of them has to be found and applied up to eight times. This is the structural reason A5 keeps recurring.
**Recommendation:** Add one internal `request<T>(method, path, {token, body, narrow})` in the transport module that owns headers, `readError` and the narrower slot. Route `userSettings`, `push`, `themesApi`, `readCursor` and `serverSettings` through it and remove their private `fetch`. Then enable Biome's `noRestrictedGlobals` for `fetch` outside the transport and the external-resource modules (`beep`, `mediaAvailability`, `nowPlaying`, `textResource`, `bootFetch`).

### A19. The Session context API returns wire payloads, not domain values
**Concern:** Abstraction boundaries
**Severity:** LOW
**Scope:** `lib/grappa/session.ex:1193-1197`, `:1838-1897`; `lib/grappa/session/dcc_offers.ex:261`; `lib/grappa/session/window_state.ex`
**Problem:** `Session.list_dcc_offers/2` is specced `{:ok, [Wire.dcc_offer_payload()]}`: `DccOffers.held_offers/2` calls `SessionWire.dcc_offer/6` inside the GenServer. `window_state_snapshot.invited_windows` is `[Session.Wire.window_invited_payload()]`. The controller (`dcc_offers_controller.ex:49`) passes the value straight to `json/2`. The wire projection therefore happens inside the context boundary and crosses its public API. The deliberate goal (backfill map equals live-event map, `dcc_offers.ex:259`) could be met the same way by projecting at the edge.
**Impact:** Any non-web consumer — the Phase-6 listener is the obvious one — receives JSON-shaped maps with atom `kind:` tags instead of domain structs, and has to un-project them. It also puts wire-module calls on the session process's hot path.
**Recommendation:** Have `held_offers/2` return `[{offer_id, held()}]` domain tuples, and call `Session.Wire.dcc_offer/6` in the controller and in the channel snapshot push. Treat `invited_windows` the same way. The "same map" guarantee still holds because both doors call the same Wire function.

### A20. shottino overrides the server's window classification
**Concern:** Abstraction boundaries
**Severity:** LOW
**Scope:** `frontends/shottino/shottino.c:3220-3250` (`route_target`), `lib/grappa/session/event_router.ex:3185-3230`
**Problem:** `route_target` rewrites any row whose channel equals the network name to `$server` before a window is keyed. Its comment calls this "the client half. The whole fix belongs upstream in grappa's `route_non_channel_notice/3`… Until then". The server has since changed: #546 routes every nick-sender NOTICE to `$server` unless a query window is already open (`event_router.ex:3200-3210`). The client override remains and still applies to PRIVMSG and to rows the server deliberately filed under a query. It misfiles a DM from a peer whose nick equals the network name, which the comment accepts.
**Impact:** The two clients render different window sets for the same server state. The server owns window classification, and a client-side reclassification rule cannot be discovered from the wire.
**Recommendation:** Check whether the `AzzuRRa` case still mints a window server-side after #546. If it does not, delete `route_target`. If it does, move the rule into `route_non_channel_notice_non_chanserv/3` (network-name sender → `$server`) and then delete it.

---

### Prior-finding status table

| # | Finding | Status | Evidence |
|---|---|---|---|
| A1 | EventRouter 4-key contract + `optional(any())` | FIXED | `event_router.ex:139` `@type state :: Session.Server.t()`; `Server.t` has no catch-all |
| A2 | Reply-bundle accumulators as bare `map()` | FIXED | 5 `defstruct` + `@type t` accumulator modules; `Map.get(accum` in `session/wire.ex` = 0 (was 43) |
| A3 | `Grappa.Subject` SSOT partially adopted | PARTIAL | private spellings gone; 4 literal type re-declarations remain; `Session.put_subject_id` delegate (8 callers); XOR re-derived in `admin/uploads_controller.ex` |
| A4 | Codegen membership by filename; `Push.Payload` outside | OPEN | now 3 nominal rules; push shape declared 2× server-side + 2× client-side |
| A5 | `readError` bypasses | OPEN | `readCursor.ts:295`, `serverSettings.ts:132`; `userSettings.ts` uses `statusText` at 5 sites |
| A6 | `RawNetwork`/`tagNetwork` re-validation | OPEN | `api.ts:519-575`; 0 `wireSchema` imports in `api.ts`; 29 `json()) as` vs 32 narrowed |
| A7 | Hand-written REST shapes both sides | OPEN | 41 hand object types in `api.ts`; controller schema projections; `addressing` still hand-assembled |
| A8 | `api.ts` size/exports/importers | OPEN (grew) | 3,604 lines, 114 value + 108 type exports, 107 importers; 19 components call transport directly |
| A9 | Flat `lib/`, join verb spellings | OPEN | 258 root modules (was 218); 3 join+focus spellings |
| A10 | `compose.ts` transitive imports / `queryTopicJoin` | PARTIAL | 2,345 → 1,529 lines, `lib/commands/` 14 files; seam still needed |
| A11 | UserSettings key registry as prose | OPEN (worse) | prose lists 6 keys; code uses 16 |
| A12 | 162 validators, 3 wired | PARTIAL | 196 generated / 64 imported / 132 reachable / 64 unread; none on the REST edge |
| A13 | Channel `{:reply,…}` bypass Wire | OPEN | `grappa_channel.ex:1029, 1527, 1584, 1599`; `admin_channel.ex:88` |
| A14 | `ownNickForNetwork` dead parameter | OPEN | `me` used only as a null gate; 11 callers |

New findings: CRITICAL 0, HIGH 2 (A15, A16), MEDIUM 2 (A17, A18), LOW 2 (A19, A20) — 6 total.

---

## Concern: responsibility & cohesion

### Method and size data (all measured)

Growth: line counts summed over every `.ex` under `lib/` and every `.ts`/`.tsx` under `cicchetto/src/` whose path does not contain "test", both revisions read with `git ls-tree` + `git show`. Server `lib`: **88,122 → 112,564 (+27.7%)**. cicchetto: **71,839 → 94,965 (+32.2%)**. Per-module: `git show 575e203a:<f> | wc -l` against `wc -l` now. `Session.Server` state keys: the same regex applied to both revisions over the `@type t :: %{` block (old lines 561–956, current 494–938). Callback clauses: `^  def handle_(info|call|cast|continue)`.

| Module | 575e203a | now | Δ | vs its side |
|---|---:|---:|---:|---|
| `session/server.ex` | 7,230 | 8,789 | +21.6% | **slower** than lib |
| — state keys (same regex both revs) | 82 | 82 | 12 removed / 12 added | flat |
| — callback clauses | 108 | 132 | +22% | |
| — `defp` | 219 | 237 | | |
| `session/event_router.ex` | 4,401 | 5,549 | +26.1% | ≈ lib |
| `user_settings.ex` | 1,829 | 2,940 | **+60.7%** | 2.2× lib |
| `networks.ex` | 1,112 | 1,688 | **+51.8%** | 1.9× lib |
| `networks/credentials.ex` | 1,360 | 1,827 | +34.3% | faster |
| `networks/credential.ex` (schema) | 937 | 1,299 | +38.6% | faster |
| `controllers/networks_controller.ex` | 543 | 886 | **+63.2%** | 2.3× lib |
| `controllers/auth_controller.ex` | 888 | 902 | +1.6% | |
| `channels/grappa_channel.ex` | 2,082 | 2,366 | +13.6% | |
| `test/.../server_test.exs` | 12,491 | 14,783 | +18.3% | |
| `ScrollbackPane.tsx` | 3,985 | 4,597 | +15.4% | slower than cic |
| `lib/api.ts` | 3,159 | 3,604 | +14.1% | |
| `SettingsDrawer.tsx` | 1,975 | 3,216 | **+62.8%** | 1.9× cic |
| `lib/scrollback.ts` | 1,428 | 1,939 | +35.8% | |
| `lib/uploadOrchestrator.ts` | 746 | 1,138 | +52.5% | |
| `lib/compose.ts` | 2,345 | 1,529 | **−34.8%** | |
| `AdminNetworksTab.tsx` | 1,286 | 1,486 | +15.6% | |
| `frontends/shottino/shottino.c` | 23,017 | 23,790 | +3.4% | 14,761 on 2026-08-01 (`d1b0455e`) |

**`Session.Server` is no longer growing faster than the codebase.** Its share of `lib` fell from 8.2% to 7.8%, and its state-key count is flat because 12 keys were consolidated (injected closures moved into `deps`; 4 directory fields collapsed into one `directory` key). The width is still there in absolute terms — 8,789 lines and 132 callback clauses — and the 12 keys that were added bring in new domains (see A1). **The modules now growing faster than the codebase sit elsewhere:** `UserSettings`, `Networks` and `NetworksController` on the server, `SettingsDrawer` on the client.

---

### A1. DCC file-transfer lifecycle absorbed into the session GenServer, in the shape #1390 had just removed
**Concern:** Responsibility & cohesion
**Severity:** MEDIUM
**Scope:** `lib/grappa/session/server.ex`, `lib/grappa/session/dcc_offers.ex`, `lib/grappa/dcc/*`
**Problem:** #1390 moved the channel-directory ETL out of `Session.Server` because it was "a domain of its own … none of that belonged on the hottest process in the tree" (`directory_ingest.ex` moduledoc). The next foreign domain landed in the same place: issue 2089 put the whole DCC SEND receive lifecycle in `Session.Server` —
- **Intake** (policy gate, ceiling, hold, auto-accept fork): `admit_dcc_offer/4` :7782, `take_dcc_offer` :7809, `auto_accept_dcc?` :7840, `hold_dcc_offer` :7861.
- **Accept** (policy + quota, then a detached transfer task): `admit_dcc_accept` :7913, `start_dcc_transfer` :7947.
- **Delivery storage with retention policy:** `store_dcc_delivery` :7973. **Report persistence:** `persist_dcc_report` :8040.
- **Process surface:** 3 `handle_call`s (`accept_dcc_offer`, `list_dcc_offers`, `refuse_dcc_offer`), 3 `handle_info`s (`:dcc_offer_expired`, 2× `:dcc_transfer_done` at :3823–3850), 2 `apply_effects` arms (:6706, :6714).
- About 290 contiguous lines (:7764–8056) plus the clauses above; `grep -c dcc` matches 97 lines of `server.ex`. Its expiry timer is armed with no stored ref (`_ = Process.send_after(...)` :7862).

The same window added more unrelated state keys: `ignores`, `peer_profile_cache`, `profile`, `avatar_url`, `show_peer_profiles`, `auto_reply_budget`, `queued_joins`.
**Impact:** File-transfer policy (quota, retention, disk) can only be exercised by booting a `Session.Server`. A DCC change edits the most merge-contended file in the tree and its 14,783-line test file. The session-crash boundary now covers transfer bookkeeping.
**Recommendation:** Apply the #1390 pattern. Create a `Grappa.Dcc.Intake` (or `Session.DccOffers`-owned) decision module returning actions such as `{:hold, id, ms} | {:start_transfer, offer} | {:report, Report.t()}`. Move `store_dcc_delivery` into `Grappa.Dcc` as a context function the transfer task calls directly — it needs nothing from session state except subject and network, so the `:dcc_transfer_done` round trip through the GenServer can go. The session keeps only the held-offer set and the calls that read it.

### A2. `EventRouter` declares itself pure and runs an HTTP + DB + disk side effect outside its effect union
**Concern:** Responsibility & cohesion
**Severity:** MEDIUM
**Scope:** `lib/grappa/session/event_router.ex`, `lib/grappa/session/server.ex`, `lib/grappa/avatars.ex`
**Problem:** The moduledoc (`event_router.ex:1-8`) says "Pure inbound-IRC event classifier … No process, no socket, no Repo", with outputs "a list of side-effects the caller must flush". `dispatch_avatar_fetch/3` (:3767-3783) instead calls `Task.Supervisor.start_child(Grappa.TaskSupervisor, fn -> Grappa.Avatars.fetch_and_cache(...) end)` directly. That task makes an outbound HTTP request to a peer-supplied URL, writes a `peer_avatars` row and writes a file — none of it through the 35-arm `effect` union that `apply_effects/2` interprets. The result comes back as `{:peer_avatar_ready, …}` to `Session.Server` (`server.ex:3469-3485`), so the two halves of one effect live in two modules. DESIGN_NOTES 2026-08-30 (#1865a) records a real bug in exactly this path (a fetch fired for a subject with the feature off); the fix added a gate but did not return the effect to the interpreter. The sibling shows the right shape: the DCC transfer task is started by `Session.Server` from an effect arm (`:dcc_offered`).
**Impact:** A reader or test that trusts the moduledoc treats `EventRouter.route/2` as replayable and side-effect-free; it is not. Replaying a CTCP AVATAR reply in a unit test performs network I/O. This is the one effect `apply_effects/2` cannot see, log or gate.
**Recommendation:** Add `{:fetch_peer_avatar, nick_key, url}` to `EventRouter.effect()`, return it alongside the `:pending` cache mark, and move the `Task.Supervisor.start_child` into a `Session.Server.apply_effects/2` arm next to the DCC transfer start.

### A3. `shottino.c` is a 23,790-line single translation unit, and the ruling that declined to split it rested on a size it has since outgrown by 61%
**Concern:** Responsibility & cohesion
**Severity:** HIGH
**Scope:** `frontends/shottino/shottino.c`, `frontends/shottino/docs/REVIEW-2026-08.md`
**Problem:** One file holds transport, state, rendering, input, admin, calls, media, an LLM bot and a downstream IRC server.
- **Shared state:** `struct app` (:1057–1721) has **159 field declarations** — bearer and URL; networks, windows and panes; the log ring and its six parallel arrays; the input editor and history; mouse hit-test regions; the admin panel and inline media; call settings, the LLM/bot, voice, STT and notifications; `struct ircd`, the downstream IRC server.
- **Functions:** 483 top-level definitions (signature regex). By prefix: `ircd_*` 36, `call_*`/`whip_*` 36, `bot_*`/`llm_*` 25, `admin_*` 12, `stt`/`voice`/`dictate` 6, media 8.
- **Command dispatch:** `handle_command_dispatch` is a **single 1,189-line function**, an if/else chain with 103 `strncmp`/`strcmp(line, "/…")` arms — the shape cicchetto's `compose.ts` had before prior A4 was fixed.
- **Tests:** 6 test files `#include "../shottino.c"` directly.
- **The ruling:** P4.7 in `docs/REVIEW-2026-08.md` (2026-08-01) says "Splitting shottino.c: a considered NO", on the premise "14.7k lines, but organized rather than accreted: ~50 section banners". The file was 14,761 lines that day, 23,017 by 2026-08-15, 23,790 now. The same ruling named the two splits that "would pay" — the ircd bridge and the /llm+/bot cluster. Both are still inside, and a third comparable cluster (calls, 36 functions) has grown since.
**Impact:** Every feature touches the single `struct app` and the single dispatcher. The six test binaries each recompile the whole client. The ircd bridge's protocol state machine is one `#include` away from UI state, so a UI change can break the bridge and vice versa. This is the third wire consumer, and nothing structural separates "what the wire says" from "what the terminal draws".
**Recommendation:** Re-open P4.7 on the new numbers and do the two splits the ruling already priced: the ircd bridge into `ircd_bridge.c` behind a narrow `struct ircd_host` vtable of the ~6 app callbacks it needs (publish, send, lookup window, fold); `/llm`+`/bot` into `bot.c` the same way. Replace the 1,189-line dispatcher with a `{verb, handler}` table, one handler per command family, as cicchetto's `lib/commands/*.ts` + `CommandContext` did (#1396). Leave the rest `struct app`-coupled, as the ruling argued.

### A4. The third wire consumer re-derives server domain decisions, and its copies have already diverged
**Concern:** Responsibility & cohesion
**Severity:** MEDIUM
**Scope:** `frontends/shottino/shottino.c`, `lib/grappa/mentions.ex`, `cicchetto/src/lib/mentionMatch.ts`, `cicchetto/src/lib/chantypes.ts`, `lib/grappa/user_settings.ex` (ignores)
**Problem:** Three decisions the server owns are made again by shottino, each differently.
- **Is this row a mention?** The server SSOT is `Grappa.Mentions.mentioned?/3` (`mentions.ex:264`): word-boundary match over own nick plus `highlight_patterns`, with sender exclusions. cicchetto mirrors it in `mentionMatch.ts`, whose header records an earlier divergence between the two ports (#370, issue 1481). shottino has **two more predicates**: `message_mentions_me` (:4895) is a case-insensitive substring match on own nick only, with no highlight patterns and no word boundary; `bot_consider` (:13194) is `contains_ci(body, own)`. So a `/hilight` keyword notifies (server push) and highlights (cic) but not in shottino, and a nick that is a substring of a word highlights in shottino only.
- **Is this name a channel?** The server publishes `chantypes` and cic consumes it (`lib/chantypes.ts`). shottino's `is_channel_name` (:1910) hardcodes `# & + !`, with 13 call sites and **0** references to `chantypes`.
- **What does `/ignore` mean?** Server `/ignore` (#162, `92233a69`, 2026-09-06) is a per-network mask list stored in `UserSettings` and dropped at the door for every client. shottino's `/ignore` (`ae3a1119`, 2026-07-31) is aliased to a **local, file-persisted nick block list** (`blocks[]`, `is_blocked_locked` :6608, dispatch :20417-20418); by its own comment "nothing is sent upstream — no … server-side ignore". The same verb means two different things: an ignore set in shottino is invisible to cicchetto, and a server ignore set from cicchetto cannot be listed from shottino.
**Impact:** Each consumer's copy drifts independently. The mention predicate already has four implementations in two languages, with three different answers. The Phase-6 facade would be a fifth consumer facing the same choice.
**Recommendation:** **Mentions:** stamp the verdict on the scrollback wire (e.g. `mentions_me: boolean`, computed once by `Mentions.mention_row?/3`; the per-channel topic is already per-user) and have every client read it; cicchetto keeps its local predicate only for live re-evaluation when the highlight list changes. **Channel names:** make shottino read `chantypes` from the network payload. **`/ignore`:** rename shottino's local list to `/block` only and route `/ignore` to the server endpoint.

### A5. Session-spawn assembly is scattered across six modules, one of them a controller
**Concern:** Responsibility & cohesion
**Severity:** MEDIUM
**Scope:** `lib/grappa/spawn_orchestrator.ex`, `bootstrap.ex`, `operator.ex`, `visitors.ex`, `visitors/login.ex`, `lib/grappa_web/network_spawn.ex`, `controllers/networks_controller.ex`
**Problem:** `SpawnOrchestrator.spawn/4` and `reconnect/5` take a pre-resolved `plan` and a pre-built `capacity_input`, so every door assembles both itself. `requesting_subject:` map literals, excluding `admission.ex`'s own type and builders: **10 production construction sites across 6 modules** — `bootstrap.ex` :364, :459; `operator.ex` :764, :860; `visitors/login.ex` :405, :510, :581; `visitors.ex` :1278; `network_spawn.ex` :60; `networks_controller.ex` :883. `NetworksController` grew 543 → 886 lines (+63%) and now holds subject-branched plan resolution (`resolve_plan/3` :677-711), spawn-then-commit ordering (`apply_transition/5` :613-636), a live-identity reconnect (`live_apply_identity/3` :840-873), a park-reason policy reading `UserSettings` (:648-653), and a capacity builder whose comment reads "Mirror of `NetworkSpawn.orchestrate/4`'s capacity_input" (:876). The Boundary cycle explains why this cannot live in `Networks` (prior H12); it does not explain why it lives in a controller when `SpawnOrchestrator` is itself a top-level boundary module.
**Impact:** A change to admission inputs (a new `flow`, a new per-IP rule) must be replayed at 10 sites. The controller copy is reachable only over HTTP. The "mirror" comment is the only enforcement that the controller and `NetworkSpawn` agree.
**Recommendation:** Give `SpawnOrchestrator` subject-level verbs — `spawn_for(subject, network, flow, source_ip)` and `reconnect_for(...)` — that resolve the plan (user or visitor `SessionPlan`) and build `capacity_input` internally. Bootstrap, Operator, `Visitors.Login`, `NetworkSpawn` and the controller then pass facts, not pre-assembled maps, and `resolve_plan/3` and `identity_capacity_input/2` leave the controller.

### A6. IRC framing is still hand-spelled outside `IRC.Client`
**Concern:** Responsibility & cohesion
**Severity:** LOW
**Scope:** `lib/grappa/session/server.ex`, `ghost_recovery.ex`, `recover_identity.ex`, `lib/grappa/irc/client.ex`
**Problem:** `IRC.Client` exposes 41 `send_*`/builder functions, yet hand-framed `"…\r\n"` literals remain: **7 in `Session.Server`** (same as at base) — `LIST` :2266, labelled `AWAY` :8443 and :8490, and `MODE` framed **twice with identical code** at :2518-2519 and :8295-8296 — plus **3 in `GhostRecovery`** and **4 in `RecoverIdentity`**.
**Impact:** Wire framing rules (tag prefix, trailing-param colon, CRLF) have three homes, the duplicated `MODE` builder can drift, and this is also why prior A2's door has to accept raw strings.
**Recommendation:** Add `Client.mode_line/3`, `Client.away_line/2` and a labelled variant; have both `MODE` sites and the sub-machines call them.

### A7. `UserSettings` keeps absorbing unrelated domains (re-raised: prior A15, REGRESSED LOW → MEDIUM)
**Concern:** Responsibility & cohesion
**Severity:** MEDIUM
**Scope:** `lib/grappa/user_settings.ex`
**Problem:** 1,829 → 2,940 lines (+60.7%, 2.2× the rate of `lib`). Top-level key constants (`^  @*_key "`) went **9 → 15**; new since base: `show_peer_profiles`, `upload_confirm_enabled`, `ignores`, `dcc_auto_accept`, `quit_part_reason`, `auto_away_reason`. The store now mixes UI preferences (`display_prefs`, themes); network-addressing state that is not a preference (`last_client_prefix64`, `vhost_selection`); a per-network moderation list (`ignores`, with `add_ignore`/`remove_ignore` and casemapping-aware mask normalisation); DCC and upload policy; part and away message text. 47 public function heads. Broadcasting is per-setter and ad hoc (3 PubSub sites).
**Impact:** Every new per-subject datum defaults to this module because it is the only per-subject KV store. Unrelated domains share one file, one `data` map column and one test suite, and nothing can enumerate or type the key set (abstraction A11).
**Recommendation:** Split out the domains that carry behaviour, not just a value: `ignores` becomes `Grappa.Ignores` (mask normalisation, per-network lists, the session-notify); addressing moves to `Vhosts`/`Net` beside the pool. Keep `UserSettings` for plain scalar preferences with a declared `@keys` registry.

### A8. `SettingsDrawer` is the fastest-growing component, and its inline half grew (re-raised: prior A14, REGRESSED)
**Concern:** Responsibility & cohesion
**Severity:** MEDIUM
**Scope:** `cicchetto/src/SettingsDrawer.tsx`, `cicchetto/src/lib/settingsNav.ts`
**Problem:** 1,975 → 3,216 lines (+62.8% vs +32.2% for cicchetto); `createSignal` 37 → 55. Of the 12 `SettingsSubPage` values, 7 render an extracted component (security, vhost, themes, watchlists, ignores, aliases, perform); 5 are still inline in the one closure — `main` (:1452), `general` (:1778, ~460 lines), `profile` (:2240), `display` (:2457), `push` (:2736, ~420 lines). 29 `await` sites across 23 distinct API or store functions; some go through store modules (`save*`), others hit REST directly (`updateProfile`, `updateIdentity`, `getVhostSettings`, `listPushDevices`, `renamePushDevice`). It imports from 38 distinct `lib/*` modules. Sibling settings components show the same component-owns-fetch pattern (`PasskeySettings.tsx` has 19 awaits).
**Impact:** Every new preference lands in the 55-signal closure, and the settings surface repeats prior A9's admin pattern — state and fetch owned by components.
**Recommendation:** Extract `general`, `profile`, `display` and `push` into page components, as the other 7 already are, and put the direct REST calls behind store functions in `lib/*` so the drawer holds navigation only.

---

### Prior findings (2026-08-15, responsibility & cohesion) — status

| Prior | Finding | Status | Evidence |
|---|---|---|---|
| A1 | Sub-machine extractions left bespoke interpreters; 2 private effect vocabularies; 8 timer fields | **PARTIAL** | Lines now route through `apply_effects` (`emit_reply_lines` `server.ex:5548-5550`). Runners `advance_ghost` (:5393) and `advance_recover` (:5581) still hand-written. Still 8 stored timer fields and 18 `cancel_and_drain` calls. A **third** private vocabulary was added: `DirectoryIngest.action` (`directory_ingest.ex:104`, run by `perform_directory_action` :8115). Two new timers keep no ref (:5442, :7862), so three timer disciplines now. No `SubMachine` runner exists. |
| A2 | No outbound-line door (24 free sends vs 6 capture sites) | **PARTIAL** | `send_outbound/3` door exists (#1394, :5197) with **1** caller (:6958). `/quote` (:2096→2099) and perform (:5059-5060) still pair capture and `send_raw` by hand. Send call sites: `send_raw` 10, `send_line` 9, `send_privmsg` 6, `send_notice` 2. |
| A3 | User login policy in 888-line controller | **PARTIAL** | Decision moved to `Accounts.Login` (99 lines, #1395). Controller now 902 lines, 61 `defp`, still holds 22 `visitor_error_response` clauses, the throttles and challenge minting; its moduledoc gives a reason for keeping those at the edge. |
| A4 | `compose.ts` = store + pipeline + 59-arm command table | **FIXED** | 1,529 lines; 14 `lib/commands/*.ts` modules (1,603 lines) take a `CommandContext` (#1396); the switch is a dispatcher (66 labels); only the privmsg/me/msg send-pipeline arms stay inline. |
| A5 | 005 parsed twice with two merge rules | **FIXED** | #1390: one `ISupport.merge_isupport/2` (:4163); `reduce_while` 0 outside a comment. |
| A6 | Channel-directory ETL in session GenServer | **FIXED** | `DirectoryIngest` struct (238 lines) under one `directory` key; ~50 lines of interpreter remain (:8068-8118). The shape has since recurred for DCC (new A1). |
| A7 | `GrappaChannel` = verb router + snapshot assembler | **OPEN** | 2,366 lines (+13.6%); 39 `do_handle_in` clauses and 12 `push_*` functions, unchanged. |
| A8 | `api.ts` = transport + type library + domain helpers + 401 hook | **OPEN** | 3,604 lines; 222 `export` statements (216 at base); 107 non-test importers; `displayNick` :429, `ownNickForNetwork` :467, `isContentKind` :706 still there. |
| A9 | Admin components own fetch/state/error | **OPEN** (grew) | `AdminNetworksTab` 1,486 lines, 12 `createSignal`, 6 `createStore`, 28 `await`s, 15 `admin*` API functions imported. 8 of 12 `Admin*.tsx` import `./lib/api`. No admin store module in `lib/`. |
| A10 | `ScrollbackPane` = renderer + scroll machine + cursor policy | **OPEN** | 4,597 lines; per-kind renderers still in the file (:482-1284); the component closure runs :1298 to EOF (~3,300 lines); 63 signal/effect/memo/mount/cleanup calls. |
| A11 | Read-cursor advancement has 4 doors; "single door" bypassed | **OPEN** | `setReadCursor` 4 call sites: `selection.ts:692` (comment at :680 still says "single door"), `scrollback.ts:1244`, `:1293`, `:1626`. |
| A12 | REST envelopes shaped inline in controllers | **OPEN** | 34 inline `json(conn, %{` literals across 21 controllers (37 across 21 at base). |
| A13 | `Bootstrap` Task does 3 boot jobs; `OutboundV6Pool` in no tree | **OPEN** / half **RETRACTED** | `run/0` (:212-247) still validates, installs the pool, then runs the spawn loop. `OutboundV6Pool` is now a `boot/0` `persistent_term` seam called from `application.ex:158`, not a process, so the "in no tree" half no longer applies. |
| A14 | `SettingsDrawer` half-extracted, 37 signals | **REGRESSED** | New A8: 3,216 lines (+62.8%), 55 signals, 5 of 12 pages inline. |
| A15 | `UserSettings` a generic KV store for 10 domains | **REGRESSED** | New A7: 2,940 lines (+60.7%), key constants 9 → 15, now also holds per-network `ignores`. |
| A16 | `host_candidates/0` computes a domain rule in a controller | **FIXED** | Composes `HostAddresses.reject_in_prefix/2` with `ServerSettings`, with a documented pass-config-in reason (`vhosts_controller.ex:79-84`). |

Prior tally: 4 FIXED, 3 PARTIAL, 7 OPEN (1 half-retracted), 2 REGRESSED.

New findings: CRITICAL 0, HIGH 1 (A3), MEDIUM 4 (A1, A2, A4, A5), LOW 1 (A6) — 6 total. Plus 2 re-raised (A7 ← prior A15, A8 ← prior A14), both MEDIUM, counted in the prior table.

---

## Concern: duplication

Read-only; every count comes from a grep, awk or python command run against the tree. `priv/wire/schema_inventory.md` was checked independently: a python walk of `wireSchema.ts` export bodies, seeded from the `import {…} from "./wireSchema"` blocks, gives **196 generated / 64 imported / 132 reachable / 64 never read**, matching the inventory exactly.

---

### A1. shottino is a third hand-written copy of the wire contract, and it has already drifted while its only gate says it is current
**Concern:** Duplication
**Severity:** HIGH
**Scope:** `frontends/shottino/wire.h`, `wire.c`, `shottino.c`, `tests/test_commands.c`; server `lib/grappa/networks/credential.ex`, `lib/grappa/session/wire.ex`
**Problem:** shottino decodes the wire entirely by hand; the codegen does not reach C.
- `wire.c`'s `KIND_TABLE` has **49** event kinds (`grep -c '^    {"' wire.c`) — 36 of the 40 kinds in `SESSION_WIRE_WIRE_EVENT_KIND` plus 13 cross-module kinds. `wire.c` reads **90** distinct field names; `shottino.c` reads another **49** straight off REST JSON through `json_get`, bypassing `wire.c`'s narrowing — two decoding disciplines inside shottino itself.
- Every closed set is a hand mirror: message kind (`wire.c:11-12`), connection state (`wire.c:32`, and again at `shottino.c:3048-3050` for `GET /networks`), presence (`wire.c:55-60`), severity (`wire.c:68-75`), server-reply source (`wire.c:691-694`).
- The only CI gate on the contract is `test_commands.c:269-291`, comparing `WIRE_PROTOCOL_VERSION` with `lib/grappa/protocol.ex`. Both are **30**, so it passes. Two closed sets are nonetheless stale:
  - **`:failing` connection state** (#1675, `ff48b13f`, 2026-08-23) is missing. `CONNECTION_STATE_NAMES = {"connected","parked","failed"}` (`wire.c:32`) is applied to `from`, `to` and `network.connection_state` of `connection_state_changed` (`wire.c:579-588`), so any transition into or out of `failing` fails narrowing and the whole event is dropped. The REST seed at `shottino.c:3048-3051` sets `conn_known = false` for the same value.
  - **`server_reply.source = "admin"`** is missing. The server declares `@server_reply_sources [:info, :version, :motd, :admin]` (`session/wire.ex:419`); `wire.c:691-694` accepts three of the four and `return false`s otherwise, so every `/admin` reply is dropped.
- A version pin detects that the number moved. It cannot detect what moved, and here it passed while two closed sets were stale.
**Impact:** Each server wire change now has three consumers to update, and only cicchetto's copy is shape-gated. The CLAUDE.md ruling that `protocol_version` is TOTAL is already false for shottino, and nothing reports it.
**Recommendation:** Generate the closed sets for C: have `mix grappa.gen_wire_types` emit a third artefact, `frontends/shottino/wire_gen.h`, with `static const char *const X[] = {…}` tables for every `@type … :: literal | literal` set, under the same `--check` gate, replacing the hand tables in `wire.c` and `shottino.c`. Then add a fixture gate: emit one canonical sample JSON per `*_payload` typespec into `priv/wire/samples/`, and have `test_wire.c` require `wire_narrow` to accept every sample, so a new required field or enum member turns shottino's suite red instead of silently dropping events in the field.

### A2. Runtime-schema adoption went from 3 to 64, but the per-channel topic and seven user-topic arms are still hand-narrowed beside unused generated schemas
**Concern:** Duplication
**Severity:** MEDIUM
**Scope:** `cicchetto/src/lib/wireNarrow.ts`, `lib/userTopic.ts`, `lib/wireSchema.ts`, `lib/pushPayload.ts`
**Problem:** Adoption: 196 generated, 64 imported (38 in `userTopic.ts`, 26 in `wireNarrow.ts`), 132 reachable, 64 never read. Hand narrowers remain:
- **`narrowChannelEvent` and helpers** (`wireNarrow.ts:82-610`): 529 raw lines, **304** code lines. None of the per-channel topic runs off a schema, though `S_SessionWireTopicChangedPayload`, `S_SessionWireChannelModesChangedPayload`, `S_SessionWireChannelCreatedPayload`, `S_SessionWireMembersSeededPayload`, `S_ReadCursorWireReadCursorSet`, `S_WindowCountsWireEvent`, `S_SessionWireJoinedPayload`, `S_SessionWireJoinFailedPayload`, `S_SessionWireKickedPayload` and `S_SessionWireIsupportChangedPayload` are all generated.
- **Seven hand arms in `narrowUserEvent`** (`userTopic.ts:263-823`), **204** code lines: `whois_bundle` (79), `server_settings_changed` (42), `recover_progress`/`recover_result` (32), `lusers_bundle` (20), `bundle_hash` (5), `web_session_severed` (4), plus element helpers at 207-262 (22). The matching `S_…` schemas exist and are unread.
- **Generated consts restated inside hand narrowers:** `narrowMemberGender` (`wireNarrow.ts:328-330`) spells `NETWORKS_CREDENTIAL_GENDER`; `narrowCasemapping` (`:227-229`) spells `IRCIDENTIFIER_CASEMAPPING`. Neither const has a runtime consumer.
- **`Push.Payload`** is still outside the `**/*wire.ex` glob (`gen_wire_types.ex:116`), and `pushPayload.ts:47` hand-narrows it.

Total about **508** hand-narrower code lines (about 884 raw), down from about 1,150 raw.
**Impact:** Of the two highest-traffic surfaces, the per-channel `message` path is still 0% migrated. The failure mode #429 recorded (a hand copy losing an arm) is still possible there at runtime, even though the type level is now pinned (A3).
**Recommendation:** Do `narrowChannelEvent` next, as #429 did for admin: `validate(S_…)` per arm, keeping the named tolerance wrappers (`frame_budget_base`, severity default, `badge_count` default) as explicit wrappers around the schema call. Then the seven user-topic arms. Delete each hand transcription in the same commit. Replace the gender and casemapping hand checks with `.includes()` on the generated consts.

### A3. 59 hand-declared event arms that a type assert proves identical to the generated ones
**Concern:** Duplication
**Severity:** MEDIUM
**Scope:** `cicchetto/src/lib/api.ts:738-856` (`WireChannelEvent`), `:1026-1493` (`WireUserEvent`), `lib/wireTypesAssert.ts:490-600`
**Problem:** `WireUserEvent` declares 48 kinds inline (only `SessionWireWhoisAvatarReadyPayload` is referenced by name) and `WireChannelEvent` 11 — 587 raw lines, **254** code. `wireTypesAssert.ts` walks every hand arm (`_Assert_NoUnpinnedHandArm`) and requires `Equal<Flatten<hand>, Flatten<generated>>` for every arm except the 4 in `DeliberatelyWidened` and the 1 `DiscriminatorOnlyArm` — so **54 of 59** arms are hand copies the build proves identical to a generated type. DESIGN_NOTES 2026-08 (`docs/design_notes/2026-08.md:20360-20365`) already settled this for `WindowState` and themes: "a derived type cannot drift, so the assert would be an identity", and chose aliasing over an asserted transcription. The `isupport_changed` arm is declared **twice** (`api.ts:766-777` and `:1103-1114`) with duplicated comments that both say absent `list_modes_queryable`/`prefix_order`/`chantypes` fall back to defaults — while the narrower (`wireNarrow.ts:274-289`, #1393d) now *requires* all three and drops the envelope otherwise.
**Impact:** A wire change has to be hand-edited into up to two union copies, and the assert then only confirms the edit. The prose on the copies has already drifted from runtime behaviour, and the assert cannot see prose.
**Recommendation:** Build both unions from the generated ones — e.g. `type WireUserEvent = Extract<WireSessionEvent, {kind: UserKind}> | CrossModuleArm[PinnedArm] | Widened<…>` — keeping hand declarations only for the 5 widened or transformed arms. Delete the 54 copies and both `isupport_changed` comment blocks. `_Assert_NoUnpinnedHandArm` and the widening-overrun checks still cover the 5 that remain.

### A4. `GET /networks` is hand-typed and hand-tagged while its generated type and schema go unread; REST uses two narrowing disciplines side by side
**Concern:** Duplication
**Severity:** MEDIUM
**Scope:** `cicchetto/src/lib/api.ts:519-600` (`RawNetwork`, `tagNetwork`), `:2430-2435` (`listNetworks`), `lib/networks.ts:142`
**Problem:** `RawNetwork` re-declares all 20 fields of `NetworksWireNetworkWithNickJson` / `NetworksWireVisitorNetworkWithNickJson` (`wireTypes.ts:785-826`) as optional, justified by "legacy fixtures + mid-rollout"; `tagNetwork` then hand-defaults and hand-drops rows. `listNetworks` returns `(await res.json()) as RawNetwork[]` — cast, not validated — while `UserNetwork` *is* the generated type (`api.ts:499`) and `S_NetworksWireNetworkWithNickJson` / `S_NetworksWireVisitorNetworkWithNickJson` are on the never-read list. Across the REST edge the cast count is **55** (reconciled; see the review's count table), against **43** `narrow*(await res.json())` schema calls (the previous review found 83 casts).
**Impact:** The most-read REST shape has three descriptions (generated type, `RawNetwork`, `tagNetwork`'s defaults). The optional-everything type exists specifically to tolerate drift, and it hides it.
**Recommendation:** Validate `listNetworks` with `narrowRest(S_…union…)` against the two generated schemas and delete `RawNetwork` and the defaulting half of `tagNetwork`, keeping only the `kind` discriminator promotion if still needed. Then keep converting the remaining casts; `narrowRest` (`wireNarrow.ts:799`) already exists.

### A5. Closed sets: generated consts go unconsumed while hand copies stand beside them
**Concern:** Duplication
**Severity:** MEDIUM
**Scope:** `lib/grappa/themes/token_model.ex:35-44`, `cicchetto/src/lib/customTheme.ts:39`, `lib/themesApi.ts:48`, `lib/themeEditor.ts:13-28`, `ThemeEditor.tsx:40-49`, `lib/notifyWatch.ts:40`, `lib/api.ts:1446,1457`
**Problem:** **20 of 29 generated `export const` closed sets in `wireTypes.ts` have no consumer outside the two generated files and tests** (per-const `grep -lw`). Fonts: `ThemeEditor.tsx:40-49` keeps a hand `FONT_FAMILIES` list next to `THEMES_TOKEN_MODEL_FONT_FAMILY`; the 2026-08 mutation campaign (`2026-08.md:20371-20375`) showed a *removal* fails typecheck, but an *addition* on the server compiles green and never appears in the editor dropdown. Colour keys: `@color_keys` has no generated counterpart and the client declares it three times — `COLOR_KEYS` (`customTheme.ts:39`), the `ThemeColorKey` union (`themesApi.ts:48`), the `EDITOR_*_KEYS` groups (`themeEditor.ts:13-28`) — pinned to each other (`customTheme.test.ts:418`), not to the server. Presence: `"online" | "offline" | "unknown"` is written inline four times in cic (`api.ts:1446,1457`, `notifyWatch.ts:40,54`) and once in shottino (`wire.c:55-60`); the server has no named set to derive from.
**Impact:** A server-side vocabulary addition compiles green everywhere and goes missing in the UI.
**Recommendation:** Iterate `THEMES_TOKEN_MODEL_FONT_FAMILY` directly in `ThemeEditor`. Give `color_keys/0` a closed `@type` so the codegen emits a const, and derive `COLOR_KEYS` and `ThemeColorKey` from it (editor groups stay hand-written, pinned against the const). Name the presence set as a server `@type` and alias it. Add a `--check`-time count of unconsumed consts next to the schema inventory so the 20 stay visible.

### A6. Upload MIME taxonomy: shottino adds two more copies, and one has already drifted
**Concern:** Duplication
**Severity:** MEDIUM
**Scope:** server `uploads_controller.ex:94-126` (`@mime_categories`), `uploads/mime_ext.ex`, `uploads/metadata_strip.ex:74-82`, `net/image_fetcher.ex:34`, `avatars.ex:209`; cic `lib/uploadCategory.ts:15-137`, `lib/mediaSession.ts:72`, `SettingsDrawer.tsx:2376`, `ThemeEditor.tsx:297`; shottino `shottino.c:17195` (`view_extension`), `:18135` (`mime_for_path`)
**Problem:** The server copies are pinned to each other (`mime_ext_test.exs:62`). cic's `uploadCategory.ts` is still pinned only by its header comment ("keep entries in the SAME ORDER") and a test holding literal counts. shottino adds a hand upload allowlist, `mime_for_path`, plus a mime→extension map. Measured drift: `mime_for_path` has no `md → text/markdown` entry; the server accepts `text/markdown` since #1764, but shottino refuses `/upload notes.md` locally ("unsupported").
**Impact:** Adding a MIME now means editing at least 6 places in 3 languages; only the server-internal ones are gated, and the uncovered copy drifted.
**Recommendation:** Expose `@mime_categories` through a Wire typespec or an `/api/config` field — ideally in `GET /api/server`, which both clients already fetch — and derive cic's `*_MIMES` and shottino's allowlist from it at runtime, or through the generated C header proposed in A1. Leave `view_extension` alone: it serves arbitrary third-party links and is a separate concern.

### A7. `CONTENT_KIND_PROJECTION` is a hand mirror, and the notify subset is re-inlined in both clients
**Concern:** Duplication
**Severity:** MEDIUM
**Scope:** `lib/grappa/scrollback/message.ex:177-188`, `cicchetto/src/lib/api.ts:677-704`, `lib/subscribe.ts:843`, `frontends/shottino/shottino.c:4542, 21660, 21690, 21722, 22011`
**Problem:** The server's `@content_kind_projection` and cic's `CONTENT_KIND_PROJECTION` Map are independent declarations; the pin is `api.test.ts:941-955`, asserting literal arrays, and nothing reads the server's `content_kinds/0` or `notify_kinds/0`. `subscribe.ts:843` re-spells `NOTIFY_KINDS` as `kind === "privmsg" || kind === "action"`, and shottino spells the content set `PRIVMSG || NOTICE || ACTION` inline **5** times.
**Impact:** A new content kind needs 1 server edit and at least 7 client edits. CLAUDE.md singles this map out as the single source, yet it is held together by prose and literal tests.
**Recommendation:** Emit `SCROLLBACK_CONTENT_KIND_PROJECTION` from the codegen (a `@type` map, or `@spec content_kind_projection() :: [{kind(), :notify | :unread}]`). Derive `CONTENT_KINDS` and `NOTIFY_KINDS` from it, replace `subscribe.ts:843` with `NOTIFY_KINDS.has(...)`, and give shottino one `is_content_kind()` helper, generated per A1.

### A8. e2e: the nine named helpers were consolidated, but 23 other helpers are now duplicated 98 times, and one has forked its signature
**Concern:** Duplication
**Severity:** MEDIUM
**Scope:** `cicchetto/e2e/tests/*.spec.ts` (473 files), `e2e/fixtures/`
**Problem:** Fixed: `adminLogin`, `fetchScrollbackPage`, `setAdminFlag` and `adminPatchCaps` each now have one definition in `fixtures/`; `adminFriendlyLogin`, `seedCursor` and `findVjtUserId` are gone. Remaining (whole-tree scan): **23** helpers defined as `function` in ≥3 spec files, **98 copies** in total — none of `scrollbackGeometry` (×9), `openChannel` (×6), `deleteNetworkBestEffort` (×6), `waitForNetworkState` (×5), `getNetworks` (×4) or `createNetwork`/`restoreNetwork`/`clearAliases` (×5) exists in `fixtures/`. `deleteNetworkBestEffort` has forked its signature: `(token, slug: string)` in `admin-network-crud.spec.ts:28`, `(token, networkId: number)` in four specs, `(token, id: number | null)` in `issue1760-…spec.ts:89`. `type NetRow` is re-declared in 3 specs although `wireTypes` describes that row (only 2 e2e files import `wireTypes`).
**Impact:** The previous review's class of failure (one copy gains a barrier, the rest don't) comes back for every new helper, and the forked signature means a grep for one form misses the others.
**Recommendation:** Promote the ten most-copied helpers into `fixtures/grappaApi.ts` (REST verbs) and `fixtures/cicchettoPage.ts` (page verbs), with one `deleteNetworkBestEffort(token, id)`. Type `NetRow` as `NetworksWireNetworkWithNickJson`. Add a lint in `scripts/check.sh` that fails when a spec defines a function whose name already exists in `fixtures/`.

### A9. Two byte-identical private `live_state` projections of `SessionEntry`
**Concern:** Duplication
**Severity:** LOW
**Scope:** `lib/grappa/networks/credentials/admin_wire.ex:222-234`, `lib/grappa/visitors/admin_wire.ex:141-153`, `lib/grappa/live_introspection/admin_wire.ex:117-140`
**Problem:** The `peer_*` scoping is now a recorded ruling (#550/#1509, `2026-08.md:28119`) and the dead cic aliases are gone, but the two 7-key `live_state_to_json/1` bodies are still byte-identical private copies of one projection. The ruling covers *which keys* each endpoint shows, not the duplicated code.
**Impact:** A new `SessionEntry` field must be added twice, or the credentials and visitors tabs diverge silently.
**Recommendation:** Move one `live_state_base/1` into `Grappa.LiveIntrospection.AdminWire` and call it from both; the sessions projection becomes `Map.merge(live_state_base(e), %{peer_address: …, peer_port: …, peer_name: …})`.

### A10. The "session should be live" subset `[:connected, :failing]` is restated in 6 code sites with no named guard
**Concern:** Duplication
**Severity:** LOW
**Scope:** `lib/grappa/networks.ex:1014, 1060, 1150, 1245`, `lib/grappa/networks/credentials.ex:1715`, `lib/grappa/operator.ex:576`
**Problem:** `Credential` owns the closed set (`credential.ex:123`), but the "link is supposed to be up" subset #1675 introduced is spelled inline at 6 guards and queries (`grep -rnE 'in \[:connected, :failing\]' lib`; 2 more hits are prose). #1675 had to find all of them by hand, and a fifth state would have to do the same.
**Recommendation:** Add `defguard is_link_expected(state) when state in [:connected, :failing]` plus `Credential.link_expected_states/0` for the Ecto query, and replace the six sites.

### A11. Residual server test-helper copies
**Concern:** Duplication
**Severity:** LOW
**Scope:** `test/grappa/{notify,read_cursor}_test.exs`, `test/grappa/push/{observability_log,sender,triggers}_test.exs`, 6 `setup_user_and_network` files, `test/grappa/scrollback_test.exs`
**Problem:** `visitor_fixture` is shadowed in 5 test files; the local copies go through `Visitors.find_or_provision_anon/3` while the shared `AuthFixtures.visitor_fixture/1` inserts directly, so the copies differ in behaviour, not just name. `setup_user_and_network` is re-declared in **6** files with 1- and 2-arity variants. `scrollback_test.exs` makes **12** direct `Accounts.create_user/1` calls, taking the Argon2 cost `AuthFixtures.user_fixture/1` exists to avoid.
**Recommendation:** Delete the 5 local `visitor_fixture` copies, or name the provision-path variant `provisioned_visitor_fixture/1` in `AuthFixtures`. Hoist `setup_user_and_network` into `Grappa.IRCServer` or `AuthFixtures`. Switch `scrollback_test.exs` to `user_fixture/1`.

---

### Prior findings (2026-08-15, duplication section)

| # | Prior finding | Status | Evidence |
|---|---|---|---|
| A1 | 162 schemas generated, 3 used, ~1,150 hand-narrower lines | **PARTIAL** | 196 generated / **64** imported / 132 reachable / 64 never read (python walk, matches `schema_inventory.md`). Hand narrowers down to ~508 code lines: all of `narrowChannelEvent` plus 7 user-topic arms. Now new A2 |
| A2 | Six test helpers re-declared 12–20×; `user_fixture` bypassing the Argon2 helper | **PARTIAL** | `user_fixture`, `network_fixture`, `passthrough_handler`, `start_server`, `await_handshake`, `admin_session` each defined once; `import Grappa.AuthFixtures` in 167 files. `visitor_fixture` still shadowed ×5. Now new A11 |
| A3 | 60+ copies of nine e2e helpers; 20 admin-login copies missing the barrier | **PARTIAL** | The nine named helpers consolidated or deleted. The class persists: 23 helpers ×98 copies; `deleteNetworkBestEffort` forked. Now new A8 |
| A4 | One `SessionEntry` projected to `live_state` 3×, diverged on `peer_*` | **PARTIAL** | `peer_*` scope now a ruling (#550/#1509); dead aliases deleted. Two byte-identical private copies remain. Now new A9 |
| A5 | Theme vocabulary declared 5× across two languages | **PARTIAL** | Fonts + size modes now generated consts, but `ThemeEditor.tsx:40` keeps a hand `FONT_FAMILIES`; `color_keys` has no codegen and 3 client copies pinned to each other. Now new A5 |
| A6 | 14–18 unpinned `WireUserEvent` arms; `frame_budget_base` drifted | **FIXED** | `_Assert_NoUnpinnedHandArm` + `DriftedIn`/`WideningOverrunIn` cover every hand arm; `frame_budget_base` a declared widening. The now-redundant copies are new A3 |
| A7 | 9 `fetch` sites hand-roll the error shape `readError` owns | **PARTIAL** | 8 `new ApiError(res.status, res.statusText \|\| "…_failed")` sites remain (`push.ts` ×3, `userSettings.ts` ×5), both files already calling `readError` elsewhere; the invented codes are not in `ERROR_TOKENS_*` |
| A8 | Upload MIME taxonomy: cross-language copy comment-pinned | **REGRESSED** | cic copy still comment-pinned; shottino adds `mime_for_path` (`shottino.c:18135`), already lacking `text/markdown` (#1764). Now new A6 |
| A9 | Three homes for cic unit tests with same-name pairs | **FIXED** | All 365 test files under `cicchetto/src/__tests__/`, 0 duplicate basenames |
| A10 | `MentionsRow` re-declares a generated type with `kind: string` | **OPEN** | `MentionsWindow.tsx:28-34`, `kind: string` |
| A11 | `mentioned?` / `matchesWatchlist` two ports, fixture lacks regex/non-ASCII | **OPEN** | `shouldNotifyTruthTable.json`: 48 rows, 8 patterns, all alphanumeric, 0 non-ASCII bodies |
| A12 | `monitor_targets/1` re-derives prefix-nick extraction | **OPEN** | `event_router.ex:5544-5548` `String.split("!", parts: 2)` |
| A13 | `refresh_plan` closure scaffold written twice | **OPEN** | `networks/session_plan.ex:218` and `visitors/session_plan.ex:299` |
| A14 | Notify REST envelope differs from WS envelope | **OPEN** | REST `{entries: […], presence}` built inline (`notify_controller.ex:56,94`); WS `{kind: :notify_list, networks: %{id => […]}}` (`notify/wire.ex:63`) |
| A15 | `web_session_severed` names two unrelated payloads | **OPEN** | `AdminEventsWireWebSessionSeveredEvent` (5 fields) vs `RateLimitWireWebSessionSeveredEvent` (`code`); shottino now also decodes the latter by hand |
| (Ext. A8) | `CONTENT_KIND_PROJECTION` held together by prose | **OPEN** | Still hand-written on both sides, now also inline in `subscribe.ts:843` and 5× in shottino. Now new A7 |

New findings: CRITICAL 0, HIGH 1 (A1), MEDIUM 7 (A2–A8), LOW 3 (A9–A11) — 11 total.

---

## Concern: dependency architecture

**Method.** Read-only. A Python parser read every code-level `use Boundary` block in `lib/` and `test/support/`: 122 blocks (116 in `lib`, 456 declared `lib` edges, 472 edges across all 122); Tarjan's SCC and reachability queries were run over that graph. A second script resolved aliases and matched each boundary's code references against its declared `deps:` (stripping docs, comments, `alias` lines and the `use Boundary` block); its output was a candidate list only, and every "phantom dep" cited below was confirmed by hand with `grep`. A Python import-graph builder covered 373 non-test `cicchetto/src` modules and 1,494 relative-import edges, each tagged type-only or value; SCC was run with and without the type edges. shottino: plain greps. The compiler was not run, so Boundary's own verdict was not observed. CI is green with `noImportCycles: "error"`, so it is **inferred** that Biome's rule does not count type-only edges.

An interim review, filed only as issue #2118 (2026-09-13), counted "twelve" injected closures; issue 2137, filed from it, later counted them in `lib/grappa/session/deps.ex` and got **eleven**. Eleven is used here.

---

### A1. shottino hand-copies the server's closed sets; the only check is the version integer, and one set has been stale for a month
**Concern:** Dependency architecture
**Severity:** HIGH
**Scope:** `frontends/shottino/wire.c`, `wire.h`, `shottino.c`, `tests/test_commands.c`; `lib/grappa/protocol.ex`; `docs/CLIENT_PROTOCOL.md` §2
**Problem:**
- **The drift.** The server's `connection_state` set has had four values since #1675 (`[:connected, :parked, :failing, :failed]`; `protocol.ex:89-99` records "v5 adds the `failing` value", `ff48b13f`, 2026-08-23). shottino's copy still has three: `wire.c:32` `CONNECTION_STATE_NAMES[] = {"connected", "parked", "failed"}`; `wire.h:81` `typedef enum { CONN_CONNECTED, CONN_PARKED, CONN_FAILED }`.
- **What it does on the wire.** `connection_state_of` returns false for an unknown string, and the `connection_state_changed` narrower calls it three times, on `from`, `to` and `network.connection_state` (`wire.c:579`, `:580`, `:588`). **Any `connection_state_changed` that touches `failing` is dropped whole** — the transition into `failing` and the recovery out of it alike. The REST seed has the same gap: `shottino.c:3048-3051` sets `conn_known = false` for a `failing` row.
- **How shottino depends on the server.** Only through hand-written tables: `MESSAGE_KIND_NAMES`, `CONNECTION_STATE_NAMES`, presence strings and a 20+-entry `KIND_TABLE`. The server already generates **29** closed-set constants (`grep -c '^export const [A-Z_0-9]* = \['` on `cicchetto/src/lib/wireTypes.ts`), including `NETWORKS_CREDENTIAL_CONNECTION_STATE` with `"failing"` at `:50`; none can reach a C consumer. The only gate is `WIRE_PROTOCOL_VERSION 30` (`wire.h:57`), pinned by `tests/test_commands.c:276-301` to the integer in `protocol.ex`. The pin landed 2026-09-21 (`7170f9db`) and declared 30 without re-reading the sets that changed between v5 and v30. **The pin compares a number, not what the number stands for.**
- **The contract gap.** `CLIENT_PROTOCOL.md` §2 (`:95-107`) says what a client does with unknown *fields* and *events*, and nothing about an unknown *value* in an existing enumerated field. The server treats a new literal as the additive case (`protocol.ex:93-96`), while both clients reject unknown literals strictly — shottino at `wire.h:69-71` ("an unknown value is a narrowing failure"), cic through its generated schemas.
**Impact:** A packaged binary (`/usr/bin/shottino`) silently stops tracking link state for any network in `failing`, the state #1675 added so a hammering network could be shown as such. Every future literal added to any of the 29 sets repeats this with no red anywhere, and a third-party client author has to guess whether a new enum value is fatal.
**Recommendation:** (1) Emit the closed sets language-neutrally next to `priv/wire/shape.pin` — e.g. `priv/wire/closed_sets.json` from `mix grappa.gen_wire_types` — and have `tests/test_wire.c` assert shottino's tables equal it. (2) Add a sentence to `CLIENT_PROTOCOL.md` §2 on what an unknown enum value means, per field class: drop the event, or map to an "unknown" arm. (3) Teach `wire.c` `failing` now — one line plus an enum arm.

### A2. shottino's `--ircd` tells downstream clients network facts it does not have, while the wire carries the real ones
**Concern:** Dependency architecture
**Severity:** MEDIUM
**Scope:** `frontends/shottino/shottino.c:22205-22216`, `ircd.c:134-160`, `ircd.h:24-40`, `README.md:37-41`; `lib/grappa/session/wire.ex:174-177`, `:1037-1040`
**Problem:**
- `--ircd` makes shottino a downstream IRC server with its own RFC 1459 line grammar (`ircd_parse_line`, `ircd.h:40`; 264 `ircd_` references and 52 ircd functions in `shottino.c`), translating the REST/WS wire into IRC for irssi — a client-side, unversioned forerunner of the Phase-6 listener facade.
- Its RPL_ISUPPORT is hardcoded (`shottino.c:22214`): `CHANTYPES=#&+! … CASEMAPPING=rfc1459 NICKLEN=32 CHANNELLEN=64`. That contradicts shottino's own fold (`ircd.c:134-160` folds ASCII only, "the client twin" of `canonical_target/1`, and says bahamut "advertises AND implements `CASEMAPPING=ascii`"), and contradicts the server, whose `isupport_changed` carries `chantypes`, `casemapping`, `nicklen` and `channellen` (`session/wire.ex:174-177`, `:1037-1040`) — shottino reads none of them (0 matches for `chantypes|casemapping` in `wire.c`).
- **Consequence:** irssi is told to fold `[`/`{` together while grappa and shottino keep `foo[1]` and `foo{1}` apart — the identity fork #525 and #537 fixed server-side, reintroduced one hop further out.
- **Unrecorded tension:** README `:40` says shottino "does not parse IRC"; the 2026-04-20 DESIGN_NOTES ruling says "grappa is not an ircd"; commit `c678ea5a` deliberately keeps shottino's rationale out of DESIGN_NOTES. No ruling anywhere weighs this facade against the "one IRC parser, on the server" invariant or against Phase 6.
**Impact:** Downstream clients key identities under the wrong casemapping, and advertised limits disagree with the upstream network. Phase 6 will inherit a user base whose expectations were set by a facade with no spec.
**Recommendation:** (1) Relay the per-network `isupport_changed` values (`casemapping`, `chantypes`, `nicklen`, `channellen`, `prefix`) into the downstream 005 instead of constants. (2) Record in DESIGN_NOTES a one-paragraph ruling on whether a client-side IRC facade is sanctioned alongside Phase 6; if it is, the 005 it emits is contract and belongs under A1's closed-set gate. (3) Correct the README sentence.

### A3. Cycle workarounds outlived their cycles: phantom `deps:` edges and stale justifications still shape the code
**Concern:** Dependency architecture
**Severity:** MEDIUM
**Scope:** `lib/grappa/admission.ex`, `lib/grappa/networks.ex`, `networks/admin_wire.ex`, `networks/credentials/admin_wire.ex`, `window_counts/push_source.ex`, `window_counts/pusher.ex`, `session.ex`, `visitors.ex`, `vhosts.ex`, `grappa_web.ex`, `mentions.ex`, `push.ex`
**Problem:** #1398/#1399 promoted the schema leaves and removed several cycles; the workarounds built around those cycles stayed.
1. **`Admission → Networks` is a phantom edge that four sites design around.** `admission.ex:56` declares `Grappa.Networks`, but no Admission file references anything Networks owns — it aliases only the promoted leaves (`:68`). On the declared graph the only path `Admission ⇝ Networks` is that direct edge; remove it and `Networks → Admission` closes no cycle. The four sites still avoiding that cycle: `networks/admin_wire.ex:24-28` (circuit composition moved into a controller); `networks.ex:31` (spawn kept out of Networks); `networks.ex:597-601` (`list_all` composition moved into a controller); `credentials/admin_wire.ex:243-247` (`spawn_error` spelled out by hand "because `Grappa.Networks` must not depend on `Grappa.Admission` … only this type would go stale").
2. **The WindowCounts seam is justified by an edge that no longer exists.** `push_source.ex:11-14` and `pusher.ex:8-10` justify the behaviour + `:persistent_term` seam with `Session → ReadCursor → Networks → Session`. `ReadCursor` now depends only on the `Networks.Network` leaf, and `Session → ReadCursor` closes no cycle. The seam is still needed, for a different reason (`Pusher → PresenceFilter.Resolver → Session`) that is documented nowhere.
3. **A typespec is loosened for the same dead cycle.** `session.ex:250-254` types `services_flavor` as bare `atom()` "to avoid a Session → Networks Boundary cycle". But `Networks.Network` is a leaf with deps `[Grappa.IRC]`, and a typespec reference creates no edge anyway (CLAUDE.md, the Boundary paragraph). `Network.services_flavor/0` is available at `network.ex:58`.
4. **Nine declared-but-unreferenced edges**, each confirmed by hand grep:

| Boundary | Phantom deps | Where the deps actually live now |
|---|---|---|
| `Admission` | `Networks` | (see 1) |
| `Networks` | `Vault`, `EncryptedBinary`, `Visitors.Visitor` | used only by the promoted `Networks.Credential` leaf (`credential.ex:68,72`) |
| `Visitors` | `IRC` | `visitors.ex:40` still says it is "for the child schema", now its own leaf |
| `Vhosts` | `Net.HostAddresses` | docs only |
| `GrappaWeb` | `OutboundV6Pool` | one comment, `vhosts_controller.ex:27` |

`visitors.ex:36-44` also still says Accounts and Networks are "NOT a dep"; both are now declared.
5. **The full-context-for-one-struct pattern survives in two places.** `Mentions → Scrollback` (`mentions.ex:173`) and `Push → Scrollback` (`push.ex:79`) reference only `Scrollback.Message`; so does `test/support` `ScrollbackHelpers`. This is the pattern CLAUDE.md retired: "declare the schema, not the context".

Boundary 0.10.4 does not report unused deps, so nothing catches any of this.
**Impact:** Every phantom edge is a constraint nobody needs. The four Admission sites keep a hand-copied type their own comment says "would go stale". A reader who trusts the written reason for a seam gets the wrong graph, and each dead workaround makes the next genuine inversion look ordinary.
**Recommendation:** One mechanical commit, verified with `mix compile --force --warnings-as-errors` under both `dev` and `test`: drop the nine phantom edges; fold the Admission composition back into `Networks` (or `Operator`) and delete the hand-spelled `spawn_error`; re-type `services_flavor` as `Networks.Network.services_flavor()`; correct the PushSource/Pusher justification to the Resolver edge; promote `Scrollback.Message` to a leaf. Then add a small check (~60 lines) that fails on a declared boundary dep the boundary's modules never reference.

### A4. `:persistent_term` is written on request paths, and one runtime env read sits in a plug
**Concern:** Dependency architecture
**Severity:** LOW
**Scope:** `lib/grappa/outbound_v6_pool.ex:66-69`, `vhosts.ex:781-784`, `grappa_web/controllers/admin/servers_controller.ex:209`, `admin/vhosts_controller.ex:219`, `net/source_alias_manager.ex:206-210,313-319`, `grappa_web/endpoint.ex:295-320`
**Problem:** `lib` has **37** `:persistent_term.put` sites outside `def boot`/`put_test` (40 in total). Three run on request-triggered paths: `Vhosts.resync_pool/1` → `OutboundV6Pool.apply_pool/1` writes a list (a non-word term, so a global GC) from two admin controllers right after their DB write; `SourceAliasManager.handle_call({:arm, _})` → `publish_arm/1`, reached from the admin settings door; and `GrappaWeb.Endpoint.cached_session_opts/0` lazily does `Application.fetch_env!/2` (`:318`) plus a `put` on the **first HTTP request** — a plug body reading env at runtime, which CLAUDE.md bans outside boot, while the sibling `GrappaWeb.PasskeyOrigin.boot/0` does the same job the prescribed way. The Vhosts pool is also composed in three places (two controllers and `bootstrap.ex:264-266`), because `Vhosts` cannot depend on `Networks` (`vhosts.ex:778-779`).
**Impact:** Under the #1715 rule each of these puts blocks behind any dirty NIF parked on a SQLite write-lock wait — admin-rare, but one sits right after a write. The Endpoint site is one more boundary site a reader can copy.
**Recommendation:** Move the session opts into an `Endpoint`-adjacent `boot/0` called from `start/2`. Hold the v6 pool and the arm flag in their owning GenServer's state, or in ETS as `Session.Backoff` does, rather than `:persistent_term` — both change at runtime by design. Give the pool recompute one owner (`Operator`, or a `Vhosts`-side verb that takes the fixed sources) instead of three call sites.

### A5. `Uploads.base_url` is seeded after the sessions it serves can already be running, and the comment explaining that is out of date
**Concern:** Dependency architecture
**Severity:** LOW
**Scope:** `lib/grappa/application.ex:500-535`, `lib/grappa/uploads.ex:142-152`, `lib/grappa/dcc.ex:432-434`, `lib/grappa/session/server.ex:7988`
**Problem:** `Uploads.boot_base_url/1` runs after `Supervisor.start_link/2` returns (`application.ex:509-535`) — by then `Grappa.Bootstrap`, a Task and the last child, has already started spawning sessions. `base_url/0` raises when the key is unset (`uploads.ex:148-152`). The load-bearing comment justifies the ordering because the URL is "reached only from the CTCP AVATAR reply", but issue 2127 added a second reader: `Dcc.public_url/2` (`dcc.ex:434`), called from `Session.Server` (`server.ex:7988`). The window is **inferred** to be narrow — a session must register upstream and complete a DCC transfer before `start/2` returns — but nothing records or enforces the ordering. The 18 pre-tree `boot/0` seams and this one post-tree seed are not part of the CLAUDE.md tree either.
**Impact:** The next `base_url` reader added to a session path inherits a boot-order race with no warning, justified by a comment that already undercounts its readers.
**Recommendation:** Derive the URL before the tree from the Endpoint's configured `url:` (the same config `Endpoint.url/0` projects), or seed it from a child placed right after `GrappaWeb.Endpoint` and before `Bootstrap`. List the boot-seam phase in the CLAUDE.md tree section.

### A6. `api.ts` imports types from a store, forming a 6-module type-only cycle the lint cannot see
**Concern:** Dependency architecture
**Severity:** LOW
**Scope:** `cicchetto/src/lib/api.ts:15`, `wireNarrow.ts:7-8`, `channelTopic.ts:4`, `identityScopedStore.ts:2`, `auth.ts:2,4`, `passkeys.ts:6`, `selection.ts:33`, `windowState.ts:4`
**Problem:** With type edges included the client graph has two SCCs — {`api`, `wireNarrow`, `channelTopic`, `identityScopedStore`, `auth`, `passkeys`} and {`selection`, `windowState`}. With type-only edges removed there are **zero**. The root of the larger one is a layering inversion: the transport module imports `ModesEntry` and `TopicEntry` from `channelTopic.ts`, a store (`api.ts:15`, `import type`), and that store reaches `auth` → `api` at runtime.
**Impact:** Runtime is safe, but the transport layer's type vocabulary now depends on the store layer, and converting any one of those `import type` lines to a value import creates a real cycle the lint only flags at that moment.
**Recommendation:** Move `ModesEntry`/`TopicEntry` to `wireNarrow.ts`, next to the narrowers that produce them, or to the generated `wireTypes.ts`. Stores then import them downward and `api.ts` stops importing from `channelTopic.ts`.

---

### Prior findings (2026-08-15), re-checked

| Prior | Status | Evidence |
|---|---|---|
| A1 `Networks → Session` inversion | PARTIAL | `dirty_xrefs` 5→0 (only 3 comment hits); silent-nil hazard closed by `Session.Deps.from_opts/2` + `refresh!/2` raising `DepsInjectionError` at spawn (`deps.ex:333-352`). Not fixed: injected closures 10→11 (7 user-side + 8 visitor-side, 11 distinct keys); `Networks` still declares `Grappa.Session`, and a `Session → Networks` edge would close through `Networks → LiveIntrospection → Session`; escape hatches still four kinds (11 per-session closures; one composition-root closure `held_source_fn` at `application.ex:718`; two behaviour + `:persistent_term` seams `Push.BadgeSource`/`WindowCounts.PushSource`; caller-hoisted composition, Admission ×3 and Vhosts pool ×3, several now unnecessary per new A3). The recommended `Session.Control` extraction is retracted per DESIGN_NOTES #1393b ("as written it does not compile") and #1398c. |
| A2 three schema-dep resolutions | FIXED | struct-only `Accounts` deps 13→0 (all 16 dependents call an Accounts function); 0 waivers; leaf promotion now the only pattern (7 schema leaves; `Grappa.Subject` depends on both). Residue (`Mentions`/`Push` → `Scrollback`) in new A3. |
| A3 client cycle + lint off | FIXED (runtime) | `biome.json` `"noImportCycles": "error"`; value-edge SCCs = 0; `selection ↔ windowState` now type-only; remaining type-only cycles in new A6. |
| A4 `lib → component` inversions | REGRESSED | 2 → 4: `creditsRain.ts:1` → `MatrixRain` (type); `mentionsWindow.ts:2` → `MentionsWindow` (type, still the hand-written `MentionsBundle` while the generated `SessionWireMentionsBundlePayload` sits at `wireTypes.ts:1274`); `keepKeyboard.ts:55` and `messageGestures.ts:28` import the *value* `isDiagEnabled` from `DiagFloat.tsx`. |
| A5 components into `api.ts` | OPEN | 35 of 96 components import it (28 value, 7 type-only); 7 admin tabs call `admin*` transport directly; 6 components (excl. `main.tsx`) call `socket.ts` push verbs directly; `api.ts` 3,604 lines. |
| A6 two bearer-death mechanisms | OPEN | `Revocations.announce` fires inside `Accounts` (`accounts.ex:485, 817, 889, 942, 988`) and `visitors.ex:873`; controllers also hand-push `UserSocket.disconnect_subject` (`users_controller.ex:153, 181`; `auth_controller.ex:338/341`; `me_controller.ex:193`; `request_budget.ex:91`). At least two paths fire both: admin password reset (`:942` + `users_controller.ex:153`) and admin delete (`:485` + `:181`). |
| A7 nested `top_level?` boundaries | RETRACTED (ruled) | 11 → 23, 7 of them schema leaves; the namespace/model mismatch is accepted by vjt's 2026-08-20 ruling in CLAUDE.md, and DESIGN_NOTES #1393b declines the `Session.Backoff` rename. |
| A8 tree omits SAM / DI undocumented | PARTIAL | CLAUDE.md tree now matches `application.ex` child for child, `SourceAliasManager` included; `held_source_fn` (`application.ex:718`) still 0 mentions in CLAUDE.md, boot-seam phase still absent (new A5). |
| A9 module-global DI / bearer-key copy | OPEN | `"grappa-token"` still appears outside `auth.ts:30` at `uploadHost.ts:395` and `:410`; 34 module-level `let`s across 23 non-test files. |
| A10 `ReadCursor.force_set/4` in prod | OPEN | still at `read_cursor.ex:659-661`; only caller `TestReadCursorController` (`router.ex:749`). |

New findings: CRITICAL 0, HIGH 1 (A1), MEDIUM 2 (A2, A3), LOW 3 (A4, A5, A6) — 6 total.

---

## Concern: type system leverage

All counts come from commands run against main @ c678ea5a. Unless a line says otherwise, "non-test cic" means the 372 `.ts`/`.tsx` files under `cicchetto/src`, excluding `*.test.*`, `__tests__/`, `test/`, and the two generated files `wireTypes.ts` and `wireSchema.ts`.

**Baseline re-measured, no finding:**
- **Public `@spec` coverage:** an awk pass over `lib/**/*.ex` found 1,575 public `def` names. 29 had no `@spec`, and every one is a behaviour callback (`handle_*`, `init`, Ecto.Type `cast`/`load`/`dump`, plug `call`, adapter `list_aliases`) the heuristic missed because `@impl` sat on an earlier clause. Uncovered public context functions: 0.
- **Client escape hatches:** `any` 0 (all 16 regex hits are in comments), `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck` 0, non-null assertions 0.
- **Client strictness:** `cicchetto/tsconfig.json` has `strict` and `noUncheckedIndexedAccess` on.
- **Closed-set Ecto columns:** 34 `Ecto.Enum` uses. The only closed-set `:string` column left is `admin_events.kind` (see A4).

---

### A1. shottino's closed sets are hand-mirrored with no link to the wire contract, and one has already drifted: `failing` is missing, so every link-state change to or from it is dropped
**Concern:** Type system leverage
**Severity:** HIGH
**Scope:** `frontends/shottino/wire.h:81`, `wire.c:32,43-48,579-580`, `shottino.c:3046-3051`, `tests/test_commands.c:269-291`
**Problem:**
- shottino represents its closed sets correctly as C enums with name tables (`wire.h:67-101`), and the header says an unknown value is a narrowing failure.
- Nothing ties those enums to the server. Every enum and name table is typed by hand; the only compile-time link to grappa is `WIRE_PROTOCOL_VERSION 30` (`wire.h:55`), which `test_commands.c:276` pins to `lib/grappa/protocol.ex`.
- The drift that link was meant to catch has already happened. `wire_connection_state` is `{CONN_CONNECTED, CONN_PARKED, CONN_FAILED}` and `CONNECTION_STATE_NAMES` is `{"connected","parked","failed"}`. `:failing` joined the set in #1675 (`ff48b13f`, 2026-08-23, the bump from protocol 4 to 5); cic's generated array has it (`wireTypes.ts:50`). shottino claims protocol **30** and has no `failing` — `grep -rn failing frontends/shottino/*.[ch]` finds only prose.
- **WS side:** `connection_state_of()` returns false on `"failing"`, and `wire.c:579-580` then fails the whole `connection_state_changed` narrowing. The event is dropped, not just the field.
- **REST side:** `shottino.c:3048-3051` parses the `GET /networks` row with its own second copy of the same three `strcmp`s, bypassing `wire.c`. It falls through to `conn_known = false`.
- The same REST-vs-WS split as cic: `shottino.c` makes 67 raw `json_get(` reads (REST envelopes), while WS frames and scrollback rows go through `wire.c`'s 73 narrowed reads.
**Impact:** A network in the backoff loop — the state #1675 exists to surface — is invisible in the third wire consumer on both doors. The version pin passed through 25 bumps while a closed set shottino narrows went stale: its green means "someone re-read `protocol.ex`", not "the enums match". Every future `@type` literal-union change repeats this silently.
**Recommendation:** Have `mix grappa.gen_wire_types` emit a third artefact, `frontends/shottino/wire_gen.h`, for every closed set it already emits as a TS const array (`SESSION_WINDOW_STATE_*`, `SCROLLBACK_MESSAGE_KIND`, `NETWORKS_CREDENTIAL_CONNECTION_STATE`, …), each as an enum plus a `static const char *const` name table. Gate it with the same `--check`. `wire.c` includes it and the hand enums in `wire.h:67-101` are deleted. Route `shottino.c:3048` through `connection_state_of()` so one parse serves both doors.

### A2. Typed web-layer response envelopes are shut out of codegen by a four-entry hand list, so cic hand-types them and casts `.json()`
**Concern:** Type system leverage
**Severity:** MEDIUM
**Scope:** `lib/mix/tasks/grappa/gen_wire_types.ex:116,142-147`, `lib/grappa_web/controllers/*_json.ex`, 21 controllers with inline `json(conn, %{…})`, `cicchetto/src/lib/userSettings.ts`, `push.ts`, `api.ts`
**Problem:**
- Codegen membership is `lib/grappa/**/*wire.ex` plus `@extra_modules [AuthJSON, BootJSON, ErrorTokens, MeJSON]`.
- 12 `*_json.ex` view modules exist and 8 are outside that list. Two of the excluded ones carry complete wire typespecs that never reach the client: `UserSettingsJSON` (11 `@type`s, 10 `@spec`s) and `PushSubscriptionJSON` (3 `@type`s).
- On the cic side, `userSettings.ts` declares 9 hand-written `*Response` types, imports nothing from `wireTypes`, and holds **20** of the remaining 55 `(await res.json()) as X` casts. `push.ts` holds 3 more.
- The same settings reach cic over WS as `S_UserSettingsWire*` payloads, which *are* validated (`userTopic.ts`).
- Beyond the view modules: `grep "json(conn, %{"` finds **34** inline response literals in **21** controllers (totp 4, passkey 3, notify 3, ignores 2, dcc 4, admin/settings 2, …). They have no typespec and no Wire module, so no generator can reach them.
**Impact:** One setting has a validated shape on one door and an unchecked cast on the other. A server rename of `upload_ttl_seconds` produces no red anywhere in cic. "Every new web-layer envelope MUST be added to `@extra_modules`" (the file's own comment, `:137-140`) is enforced by nothing, and 8 of 12 view modules are already outside it.
**Recommendation:** Replace the hand list with a rule: a glob over `lib/grappa_web/controllers/*_json.ex`, resolved by module rather than path so the `MeJson` camelize trap does not recur. Move each inline `json(conn, %{…})` into the controller's `*JSON` module with a `@type`. Then route `userSettings.ts`/`push.ts`/`api.ts` through `narrowRest(S_…)` as the 43 narrowed sites already do.

### A3. #2132's cure stopped at EventRouter; sibling Session helpers still re-declare host state as a widened projection closed by a catch-all
**Concern:** Type system leverage
**Severity:** MEDIUM
**Scope:** `lib/grappa/session/part_cleanup.ex:69-78`, `identity_state.ex:109-115`, `persistor.ex:96-103`, `broadcaster.ex:51-55`, `deps.ex:594`, `server.ex:1848-1851`, `session_log.ex:134-141`
**Problem:**
- The DESIGN_NOTES entry for issue 2132 (2026-09-14) and `event_router.ex:116-139` record why a hand projection ending in `optional(any()) => any()` "checked nothing": it is inhabited by every map. EventRouter now takes `Session.Server.t()`.
- `grep "optional(any()) => any()"` still finds **7** type-level uses (plus 3 in comments). Clearest case, `PartCleanup.state_slice`, re-declares five host fields more loosely than the host does: `members: %{String.t() => map()}`, `topics: map()`, `channel_modes: map()`, `channels_created: map()`, `userhost_cache: map()` — while `Server.t()` types them as `%{String.t() => %{String.t() => [String.t()]}}`, `%{String.t() => EventRouter.topic_entry()}`, `%{String.t() => EventRouter.channel_mode_entry()}`, `%{String.t() => DateTime.t()}` and `EventRouter.userhost_cache()`. `PartCleanup` sits in the same boundary as EventRouter, so nothing prevents naming `Server.t()`.
- No DESIGN_NOTES ruling covers the siblings.
**Impact:** Renaming or retyping any of those host fields produces zero Dialyzer errors in `PartCleanup` — the pre-2132 EventRouter failure mode. The projection is a second, looser declaration of state that has one owner.
**Recommendation:** `PartCleanup.state_slice` becomes `Session.Server.t()`. For the row-polymorphic contexts that genuinely accept non-Server maps (`Broadcaster.ctx`, `Persistor.session_ctx`, `SessionLog.emit/3`), keep the required keys but say so in the typedoc, and re-check each caller set. `IdentityState.facts` stays all-optional only if the #216 hot-reload rationale is still live — cite the ruling or drop the tail.

### A4. The AdminEvents ring declares `[Wire.event()]` but after a reboot holds string-keyed decoded maps; `kind` is a `:string` column
**Concern:** Type system leverage
**Severity:** MEDIUM
**Scope:** `lib/grappa/admin_events.ex:81-85,109,336-357`, `lib/grappa/admin_events/event.ex:17-26`
**Problem:**
- `@type t` has `buffer: [Wire.event()]` and `snapshot/0 :: [Wire.event()]`.
- The boot reload path fills that buffer from `load_recent/1 :: [map()]`. Its own comment says these are "JSON-decoded (string-keyed) payload maps" whose `"kind"` is a string, while fresh events are atom-keyed with an atom `kind`.
- After any restart with persistence on, the ring mixes two representations under one spec that admits only one. Dialyzer cannot object, because `[map()]` flows into a list of map types.
- The schema stores `kind` as `field :kind, :string` / `kind: String.t() | nil`, the one remaining closed-set string column in `lib/`. `payload` is a bare `:map`.
- The moduledoc's defence ("never atom-matched server-side") is a convention, not a type.
**Impact:** The first server-side reader that pattern-matches `%{kind: :circuit_open}` on `snapshot/0` silently misses every pre-reboot event, and the spec actively tells that reader it is safe.
**Recommendation:** Rehydrate on load through a `Wire.from_stored/1` that validates `kind` against the `Wire` kind set and atomizes the known keys (the `Scrollback.Meta` `load/1` pattern). Alternatively make the ring type honest (`Wire.event() | Wire.stored_event()`). Make `admin_events.kind` an `Ecto.Enum` over the same set.

### A5. Exhaustiveness is spelled three ways, and two switches over closed unions end in a silent `default`
**Concern:** Type system leverage
**Severity:** LOW
**Scope:** `cicchetto/src/lib/api.ts:1513`, `ScrollbackPane.tsx:1286-1295,3341-3417`, `banMask.ts`, `compose.ts:1211`, `members.ts:108`
**Problem:** Non-test cic has 51 `switch (` statements, and exhaustiveness is written three ways: `assertNever(x)` (12 call sites); `const _exhaustive: never = x` (4 sites — `banMask.ts`, `compose.ts`, `members.ts`, `ScrollbackPane.tsx:1147`); and implicitly through `noImplicitReturns` plus a declared return type (e.g. `beep.ts:150`). Two switches over closed unions defeat all three with a catch-all default: `rowTime()` (`ScrollbackPane.tsx:1286`) names 4 of the 7 `Row` arms and returns `null` for the rest; `dispatchScrollWrite` (`:3413`) returns silently for kinds its own comment calls unreachable.
**Impact:** A new `Row` arm or `ScrollIntentKind` compiles green and quietly takes the fallback — and these are exactly the unions whose arms grow.
**Recommendation:** Standardise on `assertNever` and convert the 4 `: never =` sites. In the two defaults, enumerate the remaining arms explicitly and end with `assertNever`. Enable Biome's `useExhaustiveSwitchCases` (nursery) if the pinned Biome version has it.

### A6. Specs return bare `map()` where the codebase already has the named type, including one inside a Wire module
**Concern:** Type system leverage
**Severity:** LOW
**Scope:** `lib/grappa/networks/credentials/admin_wire.ex:262`, `lib/grappa_web/controllers/client_token_json.ex:26`, `lib/grappa/session/event_router.ex:4337,4574`, `server.ex:4865`, `lib/grappa/networks/session_plan.ex:269-276`, `lib/grappa/scrollback/meta.ex:222-251`
**Problem:** 22 `@spec`s return bare `map()` or `{:ok, map()}`. Several have a named type available: `Credentials.AdminWire.with_session_action/2 :: map()` is a *Wire* function, so codegen sees the PUT response as `map()` and cic re-types `session_action?` by hand (`api.ts:3480-3483`); `ClientTokenJSON.create/1 :: map()`; `EventRouter.channel_mode_meta/3`, `put_sender_prefix/5` and `Server.own_sender_prefix_meta/2` all produce scrollback meta but return `map()` rather than `Scrollback.Meta.t()`; `SessionPlan.base_plan/6 :: map()` feeds `build_plan/4 :: Session.start_opts()` (prior P-A12's erasure, unchanged). Separately, `Scrollback.Meta` declares its 25-key set twice in one file — the `@type t` union (`:222-248`) and `@known_keys` (`:251`) — with nothing deriving one from the other.
**Impact:** Dialyzer checks nothing across these producers. The wire-codegen hole means a client-visible field (`session_action`) has no generated type.
**Recommendation:** Retype the five producers to the existing types, and give `with_session_action` a `@type put_response`. Derive `@type t` from `@known_keys` with a macro, or add a compile-time equality assert between them.

---

### Prior findings (2026-08-15, type-leverage section)

| Prior | Status | Evidence |
|---|---|---|
| A1 — 73 of 165 generated types and 159 of 162 schemas unconsumed | **PARTIAL** | Schemas: 69 of 196 `S_*` now referenced, all from `userTopic.ts`, `wireNarrow.ts`, `wireValidate.ts` (was 3 of 162). Types: 94 of 201 have no direct non-test importer (was 73 of 165); 81 reached only through other generated types, 13 referenced nowhere, incl. all four auto-emitted unions except `WireSessionEvent`, which only `wireTypesAssert.ts` uses. Hot path: `WireUserEvent` still hand-written (`api.ts:1026`, ~469 lines, 41 kind literals) beside the generated 40-arm union, now structurally pinned by `DriftedIn`/`WideningOverrunIn` (`wireTypesAssert.ts:502-560`). Still no gate on unconsumed generated types. |
| A2 — eleven numeric-bundle accumulators as bare `map()` | **PARTIAL** | Five became structs (#1391). Six still `map()` in `Server.t()`: `who_pending`, `names_pending`, `info_pending`, `version_pending`, `motd_pending`, `admin_pending`. Four share one `%{lines:, reply_to:}` shape read by `Map.get(accum, :reply_to)` (`event_router.ex:2579,2708`), so one struct would close all four. |
| A3 — 83 `as`-casts on `.json()` at the REST edge | **PARTIAL** | 55 remain (api.ts 29, userSettings.ts 20, push.ts 3, themesApi.ts 2, serverSettings.ts 1). 43 sites now go through `narrow*(await res.json())`. Unconstrained `as T` survives in `passkeyRequest` (`api.ts:1756`); `getPasskeyStatus` returns implicit-`any` `await res.json()` (`api.ts:1789`). Root cause for the rest: new A2. |
| A4 — wire payload typespecs outside Wire modules | **PARTIAL** | 14 → 7 outside `*wire.ex`/`*_json.ex`, 3 of the 7 now delegate. Two widened copies unchanged at `grappa_channel.ex:208-221` vs `Session.Wire:307,325`. `kind: String.t()` in `lib/` 8 → 3. `Push.Payload.t` and `Push.Sender.payload` still two identical server declarations plus a hand cic mirror. |
| A5 — `:map` columns never adopted the `Scrollback.Meta` pattern | **OPEN** (drift grew) | Still 4 `:map` columns (`user_settings.data`, `themes.payload`, `admin_events.payload`, `passkey.transports`). `user_settings.ex` now 16 keys; context table lists 14; schema table (`settings.ex:29-40`) still 6. Dual-key read survives at `user_settings.ex:2289`. |
| A6 — per-kind `meta` shapes prose-only | **PARTIAL** | Keys typed (`ScrollbackMetaT = Partial<Record<ScrollbackMetaTKey, unknown>>`); values still `unknown`/`term()`; per-kind shapes still prose. cic still has 5 `meta … as` casts and 14 `typeof …meta` probes. |
| A7 — inbound verbs untyped in both directions | **OPEN** | 33 distinct inbound verbs are bare string literals in `grappa_channel.ex` `do_handle_in/3` (39 clauses). `pushUserChannelVerb(event: string, payload: object)` unchanged (`socket.ts:861`), 19 verb literals at call sites. `AdminCredentialCreate.auth_method: string` beside the generated `NetworksCredentialAuthMethod`. |
| A8 — same closed set authored twice across two type systems | **PARTIAL** | Font families + size modes now generated, but `ThemeEditor.tsx:40-49` still hand-lists `FONT_FAMILIES`. Color keys not generated: three cic declarations; `ThemeColorKey`'s `nick_${number}` admits `nick_16+`. `me_json.ex:98` still spells `WindowCounts.t()` longhand and its typedoc cites this finding as open. |
| A9 — `ChannelKey` the only branded type | **OPEN** | 2 brands now. `canonicalChannel()` still returns bare `string`. 156 `networkSlug: string`, 131 `slug: string`, 68 `nick: string`, 168 `Record<string, …>`. |
| A10 — `as ChannelKey` escapes | **REGRESSED** | 17 non-test occurrences, up from 14 (same `git grep` at 575e203a); concentrated in `Object.keys` loops (`selection.ts` ×7). |
| A11 — e2e tsconfig missing 7 strictness flags | **PARTIAL** | 6 of 7 added (issue 2139). `noUncheckedIndexedAccess` off by in-file decision (813 errors across 287 of 496 files, measured 2026-09-14), deferred. |
| A12 — representation discarded at the boundary | **OPEN** | `SessionPlan.base_plan/6 :: map()` still erases `start_opts()`. Generated types carry `DateTime` as `string` beside epoch-ms `number`, no branded timestamp type. |
| A13 — legacy-tolerance optionals on `RawNetwork` | **REGRESSED** | 15 optional fields (`api.ts:519-551`), up from 9, justified by "legacy fixtures / mid-rollout servers" though protocol is now 30 and #1393d exists to let a client require fields by version. `RawNetwork[]` still arrives via a cast (`api.ts:2435`). |

New findings: CRITICAL 0, HIGH 1 (A1), MEDIUM 3 (A2, A3, A4), LOW 2 (A5, A6) — 6 total.

---

## Concern: extension & maintainability

**Base:** `main` @ `c678ea5a`, 1,934 commits after `575e203a` (`git rev-list --count 575e203a..HEAD`). Real change sets were traced with `git show --stat` and `git diff --stat`; every count is from a grep, `wc` or `git log` command named next to it. Anything inferred is marked "inferred".

### How recent changes were traced

- **(a) New user-topic event kinds (issue 2219).** The `network_attached` kind alone, commit `8efd7c2e`, touched **20 files**: 4 server (`networks.ex`, `networks/wire.ex`, `visitors.ex`, `session_controller.ex`), 2 protocol (`protocol.ex`, `shape.pin`), 3 generated (`wireTypes.ts`, `wireSchema.ts`, `schema_inventory.md`), 5 client (`api.ts`, `home.ts`, `socket.ts`, `userTopic.ts`, `wireTypesAssert.ts`), 3 test, 3 docs (`CLAUDE.md`, `CLIENT_PROTOCOL.md`, `DESIGN_NOTES.md`). shottino followed **two days later**: `ee491cc1` touched 5 files and `7170f9db` 4. The whole PR (#2257) touched **35 files, +2,130 lines**.
- **(b) New numeric handling (issue 2116, IRCnet 344/345).** 3 commits, **8 + 2 + 1 files**. The fix touched 4 separate places — 3 server modules plus a cic label — while the issue named only 3; the 4th was `@delegated_numerics`, and missing it would have created a new leak (DESIGN_NOTES 2026-09-13).
- **(c) New scrollback message kind.** None has landed since 2026-05-14 (`@kinds` in `scrollback/message.ex:117` unchanged). Issue #2176 added a meta key instead (`structural`); even that needed a forced Logger allowlist entry and a protocol bump, and issue 2228b then promoted it to a column.

---

### A1. The wire-shape pin cannot see controller-rendered bodies, so the "every shape change bumps" rule runs on memory for most of REST
**Concern:** Extension & maintainability
**Severity:** HIGH
**Scope:** `lib/mix/tasks/grappa/wire_pin.ex`, `priv/wire/shape.pin`, `lib/grappa/protocol.ex`, 43 inline-rendering controllers under `lib/grappa_web/controllers/`
**Problem:** The #1393d ruling says `protocol_version` must bump on **every** wire-shape change and that the number is only meaningful if total. `wire_pin` digests three things: `wireTypes.ts`, `wireSchema.ts`, and the `@spec`s of `GrappaWeb.*JSON` views discovered from `*JSON` beams (`wire_pin.ex:268`). **43 of 55 controllers** build their response inline instead. Neither those bodies nor the router's route table is in the digest. `protocol.ex` itself records the pin answering GREEN on a real wire change at least **five times**: v10 (`:232`, a new route); v11 (`:246`, a new settings route — "said 'wire shape and protocol 10 agree' with this route already in the router"); v21 (`:486`, a moved route); v24 (`:597`, a hand-typed `display_prefs` key); v29 (`:765`, the same — "GREEN at 28 with this key already added"). Each of those bumps happened only because the author remembered the rule.
**Impact:** The pin's guarantee holds only for `*.Wire` / `*JSON` shapes. A REST field or route added through the majority controller pattern gets a green gate and an unchanged number — the "floor that lies" the ruling exists to prevent. The controller split (prior A6) has become a correctness-of-versioning split.
**Recommendation:** Close the hole from the side the gate can see. (1) Add `Phoenix.Router.routes(GrappaWeb.Router)` (verb + path + action) as a fourth digest component, so a new route reddens the pin. (2) Make a `*JSON` view or a `*.Wire` function mandatory for any non-empty response body, enforced by a Credo check or an ExUnit test that fails on a `json(conn, %{…})` literal with more than an `ok:`/`error:` key. That also settles prior A6 with a stated rule instead of proximity.

### A2. `@protocol_version` is a single global integer every wire branch must edit — three measured collisions, four sites, three languages
**Concern:** Extension & maintainability
**Severity:** HIGH
**Scope:** `lib/grappa/protocol.ex`, `cicchetto/src/lib/socket.ts:266`, `frontends/shottino/wire.h:55`, `priv/wire/shape.pin`, `test/grappa/protocol_test.exs`, `frontends/shottino/tests/test_commands.c:275`
**Problem:** The version went from 1 at `575e203a` to **30** now (27 deliberately skipped): 28 bumps in 38 days. Since 2026-08-15, `protocol.ex` changed in **36** commits and `shape.pin` in **31** — the #4 and #6 code-path hotspots. The file records **three concurrent-branch collisions** over the same number: 22/23 (#2143 vs #2150, `:577`), 24/25 (#2186 vs #2176, `:642`), 25/26 (#2176 vs #2175, `:664` — "it is now the third occurrence and it is structural"). The number now lives in **four** places: `@protocol_version`; `@spec version() :: 30`; `CLIENT_PROTOCOL_VERSION` in `socket.ts`; `WIRE_PROTOCOL_VERSION` in shottino's `wire.h` (added 2026-09-21). `protocol.ex:844-866` measures that a rebase conflicts only on site 1: site 2 merges clean with the wrong value, and sites 3 and 4 are "NEVER CONSIDERED" by git. Sites 3 and 4 are caught by `protocol_test.exs` and the shottino C test, but per the same comment `protocol_test.exs` runs "in no targeted suite", so five commits carried the mismatch without a red build.
**Impact:** Every concurrent wire-touching branch serialises on one integer. Whoever rebases second must re-derive the number by hand, edit four files in three languages, and rewrite narrative prose written against a number that is no longer theirs. The cost grows with the number of concurrent worktrees — the project's normal operating mode.
**Recommendation:** Derive the number instead of hand-editing it. Emit `PROTOCOL_VERSION` into the generated `wireTypes.ts`, and a generated C header for shottino, from `Grappa.Protocol.version/0`, and delete sites 3 and 4 as hand literals so the existing `--check` covers them. Replace the literal `@spec version() :: 30` with a spec generated from the attribute, or accept `pos_integer()` and drop the `:underspecs` idiom for this one function — the spec's value as a tripwire is already refuted by the file's own measurement. Bumping stays a one-line edit, and a collision conflicts on exactly one line.

### A3. shottino hand-mirrors every closed set, and has been dropping `:failing` connection events since 2026-08-22 behind a green protocol tripwire
**Concern:** Extension & maintainability
**Severity:** HIGH
**Scope:** `frontends/shottino/wire.h`, `wire.c`, `shottino.c`, `tests/test_commands.c`; `.github/workflows/ci.yml` job `shottino`
**Problem:** shottino is a third wire consumer with **no codegen input**. `wire.h:62-94` hand-mirrors message kinds, connection states, presence values and counts severity; its own comment says an unknown value is "a narrowing failure". `CONNECTION_STATE_NAMES` (`wire.c:32`) is `{"connected","parked","failed"}` while the server's set has been `[:connected, :failing, :parked, :failed]` since #1675 (`credential.ex:123`, 2026-08-22). So every `connection_state_changed` whose `from`, `to` or `network.connection_state` is `failing` fails `connection_state_of` (`wire.c:579-588`), and shottino logs "dropped a connection_state_changed event this client could not read — please report it" (`shottino.c:8546`). A **second** hand copy, the `strcmp` chain at `shottino.c:3048-3051`, marks a `failing` network row "state unknown". The protocol tripwire added 2026-09-21 (`test_commands.c:275`) only checks `WIRE_PROTOCOL_VERSION == @protocol_version`; it was set to 30 with the `:failing` gap still open, so it carries **no content** — it proves someone looked, not that shottino learned what changed. A new scrollback kind would likewise make shottino reject the whole `message` frame. REST narrowing is split between `wire.c` (73 `json_get(` calls) and `shottino.c` (67), so the second copy is structural.
**Impact:** When the wire changes, shottino's build and CI stay green; it misbehaves silently at runtime and relies on the user to report it. Each new closed-set value has to be found by hand in two C files.
**Recommendation:** Have `mix grappa.gen_wire_types` emit a small `frontends/shottino/wire_enums.h` of string tables for every generated literal-union const, held by the same `--check`. Make `wire.c` the only place that reads closed-set values, and route `shottino.c:3048` through `connection_state_of`. Until then, a C test can parse `wireTypes.ts`'s `export const … = [` arrays the way it already parses `protocol.ex` and compare them with the C tables — turning the tripwire from "the number moved" into "this set moved".

### A4. One 16,043-line global stylesheet is the client's only CSS file and its #1 code hotspot
**Concern:** Extension & maintainability
**Severity:** MEDIUM
**Scope:** `cicchetto/src/themes/default.css`
**Problem:** `find cicchetto/src -name "*.css"` returns **1** file. It grew 12,822 → **16,043** lines since `575e203a` (+25%) and changed in **85** commits in the window — 3rd in the repo overall, first among code files, ahead of `server.ex` (63). Issue 2136 (DESIGN_NOTES) measured it as 55.4% CSS, 34.4% comment, 10.2% blank, with 1,370 top-level blocks under 519 section comments, and built a byte-identical-bundle oracle that would make a split safe. No split was made; the only follow-up gate (`test/infra/review_scope_css_test.bats`) makes reviewers *name* the file.
**Impact:** Every UI change from every concurrent worktree edits the same file, so conflicts land in comment prose and unrelated neighbouring blocks. There is no scoping, so a removed component leaves dead selectors nothing can detect; the browser is the only oracle.
**Recommendation:** Split along the file's own 519 section comments into per-surface files (admin, sidebar, scrollback, compose, …) imported in the current order from one `index.css`, using the #2136 byte-identical `dist/assets/index-*.css` criterion as the acceptance test so the split is provably behaviour-free.

### A5. `shottino.c` is a 23,790-line single translation unit that its tests `#include` whole
**Concern:** Extension & maintainability
**Severity:** MEDIUM
**Scope:** `frontends/shottino/shottino.c`, `frontends/shottino/tests/*.c`
**Problem:** `shottino.c` is **23,790 of 28,191** lines of shottino's top-level `.c` sources (84.4%, `wc -l frontends/shottino/*.c`) and its most-changed file all-time (207 commits) and since 2026-08-15 (10). **6 of 21** test files `#include "../shottino.c"` to reach its statics; `test_windows.c` alone is 5,509 lines. The C wire layer (`wire.c`, 947 lines) holds only about half the JSON reads (A3).
**Impact:** Every feature — rendering, commands, REST, reconnect, DCC — lands in one file; every test that needs one static recompiles and couples to the whole client; a new wire-consumer path means finding the right spot in a 23k-line file rather than a module.
**Recommendation:** Extract along the seams the file already names: REST client and boot (`GET /api/config`, `/networks`), event dispatch (the `WIRE_*` switch around `:8268`), the command table, rendering. Each module gets a header, and tests link against it instead of `#include`-ing the `.c`. Do the REST extraction first — it also closes A3's second copy.

### A6. 393 whole-module `vi.mock` factories make every exported symbol a hand-maintained test transcription
**Concern:** Extension & maintainability
**Severity:** MEDIUM
**Scope:** `cicchetto/src/__tests__/*` (365 files), `cicchetto/src/lib/api.ts`, `lib/windowStateSets.ts`
**Problem:** `grep -rhoE 'vi\.mock\("[^"]+", \(\) =>'` finds **393** synchronous factory mocks, which cannot call `importActual` and so each restate the mocked module's surface by hand (vs 35 factories taking `importOriginal` and 34 `vi.importActual` calls). Most-mocked: `lib/networks` 29, `lib/auth` 27, `lib/api` 25 (+17 async), `lib/selection` 22, `lib/socket` 21. Measured consequences: `isPresenceKind`, dead in production (0 importers), is hand-restated with the content-kind literal inline in **16** test files; and `lib/windowStateSets.ts` exists as a separate module *because* three suites replace `windowState.ts` wholesale, and importing a real constant would have forced each mock to restate the set (its header comment, #1402).
**Impact:** Adding or renaming an export consumed through a mocked module means editing an unbounded, ungrepped set of mock factories (inferred). Module layout gets bent around the mocks, and stale restated literals become test copies of closed sets with no gate.
**Recommendation:** Make `vi.mock(path, async (orig) => ({ ...(await orig()), <overrides> }))` the house pattern, and add a lint or grep gate rejecting a new synchronous factory for `lib/api`, `lib/networks`, `lib/auth`, `lib/selection` and `lib/socket`. Where import-time side effects force full replacement (the Solid module roots), move the side effect behind an explicit `init()` so the pure exports can be imported for real.

### A7. The LockWatch suite is quarantined out of CI entirely, and the flake is built into its design
**Concern:** Extension & maintainability
**Severity:** MEDIUM
**Scope:** `test/grappa/repo/lock_watch_test.exs`, `test/test_helper.exs:29`, `lib/grappa/repo/lock_watch.ex`
**Problem:** `@moduletag :flaky` (`lock_watch_test.exs:91`, `31770ec7`, 2026-09-07) plus `ExUnit.start(exclude: [:flaky])` removes all **38** tests (1,885 lines) from every CI run; issue #1767 has been open 15 days. The suite asserts against wall-clock budgets — `busy_timeout`, `@waiter_budget_ms`, and `Process.sleep(@film_interval_ms * N)` at 7 sites (`:1058-1204`) — so under CI scheduling jitter it is flaky by construction. This observer exists because of the #1420 and #1715 incidents; `lock_watch.ex` is 1,372 lines with 0 commits since the quarantine, and its remaining CI coverage is `lock_watch_report_test.exs` and `db_latency_test.exs`. `test_helper.exs:27` states "adding a second one is a decision", so the mechanism is ready for reuse.
**Impact:** The next change to `LockWatch` merges with its main suite unrun — on the module whose job is to see the production write-lock incidents.
**Recommendation:** Rebuild the timing tests around injected clocks and explicit barriers, as `Repo.LockWatch` already does for its ETS seam, so nothing sleeps against a budget. Until then, run `--include flaky` for this file as a separate non-required CI job so it reports on every PR and a regression shows up as a trend.

### A8. Decision narrative inside hot code files has grown faster than the code, and it is the text that conflicts
**Concern:** Extension & maintainability
**Severity:** MEDIUM
**Scope:** `lib/grappa/protocol.ex`, `lib/grappa/session/server.ex`, `lib/grappa/session/event_router.ex`, `config/*.exs`, `cicchetto/src/lib/socket.ts`
**Problem:** Comment-line share (`grep -cE '^\s*#'` over `wc -l`):

| File | Comment lines | Share |
|---|---|---|
| `protocol.ex` | 783 / 877 | **89%** (72 lines at base) |
| `config.exs` | 553 / 774 | **71%** |
| `config/test.exs` | 235 / 367 | 64% |
| `runtime.exs` | 480 / 793 | 60% |
| `server.ex` | 4,380 / 8,789 | **49%** |
| `event_router.ex` | 2,310 / 5,549 | 41% |
| `lib/` overall | 24,101 / 112,564 | 21% |

In `server.ex`, comment lines grew 3,323 → 4,380 (+32%) while code lines grew 3,907 → 4,409 (+13%). `socket.ts` carries a **206-line** comment preamble above the single `CLIENT_PROTOCOL_VERSION` constant. `protocol.ex` is a per-bump changelog, and its own collision notes (A2) record that the prose around site 1 is *why* it conflicts ("The prose around it diverges between branches"). CLAUDE.md names `docs/DESIGN_NOTES.md` as the decision log; in practice these files are a second one, updated in the same commits.
**Impact:** Merge conflicts on the hottest files are dominated by narrative, not code. A reader of a hot function wades through history to find current behaviour, and the same ruling is stated in two places that drift independently.
**Recommendation:** Adopt a rule: code comments state the current contract and invariant, and link the DESIGN_NOTES entry (`# see DESIGN_NOTES #2176`) for history. Apply it first to `protocol.ex` — cut it to the constant, a pointer, and optionally a generated table of versions and issues — then to the `socket.ts` preamble. Hold new growth with a soft gate, e.g. a CI warning when a diff adds more than N comment lines to a file on a named hot list.

### A9. `wireTypesAssert.ts` golden-shape pins are an unenforced registry
**Concern:** Extension & maintainability
**Severity:** LOW
**Scope:** `cicchetto/src/lib/wireTypesAssert.ts`
**Problem:** The file's maintenance rule is "Add a pin for every cic-facing type that has a wireTypes.ts counterpart", and nothing enforces it: **24** `_Assert_` pins exist against 132 schemas "reachable at runtime" (`schema_inventory.md`). The file changed in **11** commits in the window. By design (#1510) the pins are a hand-written third copy of each shape — the "inline golden shape" — so each wire change to a pinned type is a deliberate edit while an unpinned type fails open.
**Impact:** Which cic-facing types get a human checkpoint on shape change depends on who remembered to add a pin.
**Recommendation:** Derive the obligation: a test that lists the generated types imported from `wireTypes.ts` by non-test cic modules and requires a matching `_Assert_` entry, or an explicit exemption list with a reason each — the fail-closed-allowlist move `RouterScopeTest` made in #1353.

---

### Prior findings (2026-08-15, extension & maintainability)

| Prior | Title | Status | Evidence |
|---|---|---|---|
| A1 | Runtime-schema codegen stopped at 3/162 | PARTIAL | `schema_inventory.md`: 196 generated / 64 imported; 38 of 49 user-topic arms validated; `narrowChannelEvent` uses 0 generated schemas; hand `narrowScrollbackMessage` (`wireNarrow.ts:147`) vs `S_ScrollbackWireT` on REST (`:889`) — one shape, two narrowers |
| A2 | New scrollback kind needs a table recreate (CHECK duplicates `Ecto.Enum`) | OPEN | `kind_enum` CHECK still defined at `20260514071049:137`; none of the 14 migrations since touch it; `:failing` cost 0 recreates because `connection_state` has no CHECK; the recreate target has grown (a 403,907-row staging copy measured in `20260921020323`) |
| A3 | Window-state set restated in 6 places | FIXED | `windowState.ts:41` aliases the generated type; `NOT_JOINED_STATES` hoisted to `windowStateSets.ts` (#1402); only CLAUDE.md prose remains |
| A4 | `Session.Server` + test file as conflict epicentre | OPEN (worse) | 8,789 / 14,783 lines; `handle_info` 40→57, `handle_call` 66→73; state keys 82→82 (the prior "87" does not reproduce under a same-method count on both trees); 63 / 52 commits since 2026-08-15, the #1 and #2 code files; `event_router.ex` 4,401→5,549, its test 6,400→7,960 |
| A5 | One IRC verb = 23 files | OPEN | No declarative verb table; `Grappa.Session` facade 68→74 public `def`s; 40 `handle_in` arms; no new outbound verb to re-measure (`def send_` 41→41); #2116's numeric pair needed 4 sites (issue named 3) |
| A6 | Controller render split, no rule | OPEN (grown) | 11 view-rendering (7 render-only, 4 mixed) / 43 inline / 1 neither; inline literals — see the review's reconciled count; now decides wire-pin coverage (new A1) |
| A7 | Logger allowlist 47% of `config.exs` | OPEN (grown) | `config.exs:394–757` = 364 of 774 lines (47.0%), 112 atoms (was 106); "no Logger call carries it today" blocks 5→7, covering 8 atoms |
| A8 | `CONTENT_KIND_PROJECTION` held by prose | OPEN | No cross-language test; `api.test.ts:946` and `message_test.exs:22` each self-pin; `shouldNotifyTruthTable.json` covers notify only, 4 kinds |
| A9 | 4 env templates, 3 ungated | PARTIAL | `substrate_beam_knob_honesty_test.exs:57` pins FreeBSD/Linux knobs; `env_registry_drift_test.exs` covers `.env.example` only; `infra/packaging/grappa.env.example` in neither |
| A10 | 3 test placements; weaker e2e tsconfig | PARTIAL | 365/365 in `src/__tests__`; `e2e/tsconfig.json` has no `extends`; `noUncheckedIndexedAccess` off by documented measurement (813 errors) |
| A11 | `CLIENT_PROTOCOL.md` ungated | PARTIAL | `scripts/client-protocol-gate.sh` (2026-09-20) derives kinds from `wireTypes.ts` and fails when a kind has no entry, run in CI via `client_protocol_gate_test.bats` (`ci.yml:152`); **fields are not gated** |
| A12 | `isPresenceKind` dead; `ScrollbackPane` hand complement | OPEN | 0 production importers; `ScrollbackPane.tsx:1155` `PRESENCE_KINDS` still hand-written; restated in 16 test mocks |
| A13 | `dirty_xrefs` waivers | FIXED | 0 `dirty_xrefs:` declarations in `lib/` (3 hits are prose) |
| A14 | Adding a context is cheap (a positive note) | NOT RE-MEASURED | No action item |

New findings: CRITICAL 0, HIGH 3 (A1, A2, A3), MEDIUM 5 (A4–A8), LOW 1 (A9) — 9 total.
