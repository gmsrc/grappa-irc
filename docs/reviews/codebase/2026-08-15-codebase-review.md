# Codebase Review — 2026-08-15

**Base:** `main` @ `575e203a` (the 1.2.0 cut plus the #165 testnet unpin).
**Method:** 9 scope agents per `.claude/skills/review` (codebase mode), dispatched in parallel, each reading its scope plus `CLAUDE.md` and grepping `docs/DESIGN_NOTES.md` per topic. Read-only: no agent ran `mix`, `bun`, docker or any gate — the compile and stack lanes belonged to another worker for the duration.
**Previous review:** 2026-07-19 (27 days — past the 2-week gate).
**Scope note:** `docs/reviewing.md` lists 8 scopes; the skill in `.claude/skills/review` defines 9. The 9th, `consistency`, is included here — it reads families rather than directories and covers an axis none of the other eight can see. The two documents should be reconciled.

## Severity summary

| Scope | CRITICAL | HIGH | MEDIUM | LOW | Findings |
|-------|---------:|-----:|-------:|----:|---------:|
| irc/ | 0 | 1 | 3 | 11 | 15 |
| persistence/ | 0 | 3 | 7 | 8 | 18 |
| lifecycle/ | 0 | 1 | 9 | 8 | 18 |
| web/ | 0 | 1 | 7 | 8 | 16 |
| cicchetto/ | 0 | 1 | 7 | 7 | 15 |
| cross-module | 0 | 2 | 9 | 5 | 16 |
| docker/infra | 0 | 3 | 10 | 10 | 23 |
| cross-surface | 0 | 3 | 7 | 6 | 16 |
| consistency | 0 | 1 | 7 | 2 | 10 |
| **Total** | **0** | **16** | **66** | **65** | **147** |

Zero CRITICAL across 147 findings. The load-bearing invariants held under sweep, and four of the cross-module agent's eight axes came back measurably clean: **zero** real `\\` default arguments in `lib/`, **zero** runtime `Application.get_env` outside the documented boot seams, **one** `String.to_atom` (correct — it converts beam filenames, where `to_existing_atom` would be wrong), and Boundary closed by tooling (105 annotations, 0 of 48 context roots missing one, no escape hatches, violations failing the build). `@spec` coverage is effectively 100%; there are **zero** `IO.inspect`/`dbg` and **zero** TODO/FIXME/XXX in 88k lines of Elixir.

The findings cluster in three places. **Hand-maintained lists the docs describe as authoritative and no gate holds to that claim** — the migration-version rule, `LongLivedModules`, the POSIX file set, the bun digest, the `WORKTREE_VOLUMES` pins. **Half-finished migrations** — 159 of 162 generated runtime wire schemas unused while ~1,150 hand-narrower lines stand, the `--adm-*` token migration stopped at the resting state, `Grappa.Subject` adopted by three contexts of five, seven `Repo.transaction` calls not converted to `immediate_transaction`. And **documentation that has outlived its subject** — 51 live references to two functions #537 deleted, of which two now assert the opposite of what the code does.

## Triage — must-fix (all HIGH)

| # | Finding | Bucket |
|---|---------|--------|
| H1 | irc I-S1 — 477/476 never classified as join failures; the window stays `:pending` forever and cic shows a tab that never resolves | A join-state |
| H2 | persistence P-S1 — #532A/#576 defeated the #393 covering index on the unread-count aggregate; the query behind the 2026-07-25 prod incident is un-covered again | B sqlite perf |
| H3 | persistence P-S2 — the nick-rename chain runs in `Session.Server` with no `BusyRetry` and no transaction; a transient busy crashes the session mid-migration | C busy-retry |
| H4 | persistence P-S3 — 7 write transactions use deferred `Repo.transaction/1` against a documented rule; `TOTP.verify/3` is the #524 shape with no retry at all | C busy-retry |
| H5 | lifecycle L-S1 — `Backoff` counter unbounded and exponentiated before the cap; the raise lands before any delay is scheduled, so the restart spins | D session-lifecycle |
| H6 | web W-S1 — `MessagesController` 500s on `?before[]=1`; the catch-all exists one function away and was not applied to the other four params | E boundary-shape |
| H7 | cicchetto C-S1 — per-channel handlers capture `ownNick` by value; after a `/nick`, alerts follow the old nick, own-PART stops being detected, and the #200 handler leak returns | F client-identity |
| H8 | cross-module M-S1 — no mechanical gate for the migration-version rule CLAUDE.md marks 🔴; 40 of 86 stamps are hand-typed | G hand-lists |
| H9 | cross-module M-S2 — `Session.Server` and `SessionRevocationListener` subscribe to PubSub with no catch-all `handle_info`; an additive broadcast from another context kills every live session | H additive-contract |
| H10 | docker D-S1 — `LongLivedModules` misses 4 supervised stateful children, so a state-shape change on any of them classifies HOT on the jail | G hand-lists |
| H11 | docker D-S2 — two independent Docker deploy implementations for one substrate, already drifted in 7 measured ways | I infra-simplify |
| H12 | docker D-S3 — on the HOT path `scripts/deploy.sh` never sets `MIX_ENV`, so the theme seed can run against the dev DB on a prod box | I infra-simplify |
| H13 | cross-surface X-S1 — ~20 union arms exempt from the drift pins, and `isupport_changed` has already drifted | J wire-pins |
| H14 | cross-surface X-S2 — cic never sends `client_proto` and never reads `/api/config`, so the 426 refusal cannot fire against the reference client | J wire-pins |
| H15 | cross-surface X-S3 — the published carrier topic for `joined`/`join_failed`/`kicked` is wrong in CLAUDE.md, in the server comment, and in the client comment; the named helper does not exist | K doc-reality |
| H16 | consistency K-S1 — 51 references to `canonical_channel/1`/`canonical_nick/1`; two assert the OPPOSITE of the current fold, one of them in a published `@doc` | K doc-reality |

## Triage — gating MEDIUMs (architecture smell / maintainability / evolution risk)

- **A join-state:** irc I-S2 (WHOIS-leg correlation reads with a narrower fold than the write — rfc1459 write/read mismatch).
- **B sqlite perf:** persistence P-S4 (four dead `dm_with` indexes on the highest-write-rate table), P-S5 (`user_settings.data` read-modify-write loses concurrent writes to different keys).
- **C busy-retry:** persistence P-S7 (`BusyRetry` nested inside an open transaction, which the codebase elsewhere documents as forbidden), P-S8 (five session-driven and web-reachable writers missed by #523 B1 / #590 B2).
- **D session-lifecycle:** lifecycle L-S2 (`init/1` does DB reads against two documented contracts), L-S6 (`:server_reply` source union drifted from the Wire SSOT — `apply_effects/2` has no catch-all, so this class is a session-killer), L-S7 (`NetworkCircuit` open→closed without the paired telemetry).
- **E boundary-shape:** web W-S3 (admin `PUT /settings` silently accepts unknown keys, alone among the admin controllers), W-S7 (`AdminChannel.handle_info/2` has no catch-all while the same module argues the opposite posture for `handle_in`).
- **F client-identity:** consistency K-S2 (`muted_targets` joined the nick-keyed family and was never added to the #373 rename set), K-S4 (`ContextMenu` outside the single-ESC-authority stack — reproducible mobile double-close).
- **G hand-lists:** docker D-S4 (POSIX gate covers 5 of ~20), D-S5 (bun digest transcribed 4× with no equality gate), D-S8 (`integration.yml` path filter misses the files that define what the suite boots), D-S9/D-S10 (the docs claim pins the gates do not have).
- **H additive-contract:** cross-surface X-S14 (`web_session_severed` hard-drops on an unrecognised code, inverting unknown-is-never-fatal for a terminal event).
- **I infra-simplify:** docker D-S6 (`PORT` documented and honoured by nothing on the Docker substrate), D-S7 (`compose.oneshot.yaml` bypassed by every deploy-path oneshot — one of the two claims must be false), D-S11 (`scripts/db.sh` unusable from a worktree, and silently).
- **J wire-pins:** cross-surface X-S4 (the `meta` allowlist degrades to `Record<string, unknown>` silently), X-S8/X-S9 (two server-owned closed sets hand-mirrored with no gate), X-S10 (`/me` and `/auth/login` widen `kind` to `String.t()` outside the codegen glob).
- **K doc-reality:** persistence P-S10, irc I-S6, lifecycle L-S11 (the same `canonical_*` sweep, three more scopes), consistency K-S5 (the refresh-button extraction's own doc denies the eighth copy exists).
- **L fold consistency:** cross-module M-S8 (Elixir Unicode `downcase` needle vs SQLite ASCII `lower()` haystack in directory search — any non-ASCII uppercase query silently returns nothing).
- **M test integrity:** cross-module M-S9 (a web controller test writes `Session.Server`'s private state map), M-S11 (23 `async: false` files with no stated reason), M-S7 (six ungated destructive test-only functions while a seventh module gates its equivalents).
- **N theming:** cicchetto C-S2/C-S3 (`--muted` and `#c00` below WCAG AA on both shipped themes), C-S4 + consistency K-S6 (the `--adm-*` migration stopped at the resting state; 14 rules still hardcode hex).

LOW findings (65) are informational — dead code, stale pointers, hygiene. Sweep opportunistically or batch into the tech-debt issue.

**Dedup notes.** Four agents independently found the `canonical_channel/1` doc rot (irc I-S6, lifecycle L-S11, persistence P-S10, consistency K-S1) — one sweep, and K-S1 is the one that identifies the two semantically-inverted members. Two agents found the `Uploads.Reaper` tick ordering (cross-module M-S3, consistency K-S3) and the `Release.rollback/2` vault gap (lifecycle L-S15, persistence P-S12). The `#c00`/`#c80` hardcoding appears from two angles: cicchetto C-S4 on the admin controls, consistency K-S6 on the armed states — same fix, different instances. The PubSub topic literals appear as web W-S8 and cross-module M-S10. All kept: the overlap is the signal.

**Security.** Hardening items are tracked out of band and are deliberately absent from this document.

---

# Findings by scope

## Scope: irc/

### HIGH

#### I-S1. `477`/`476` are named as join-failure numerics in one list and missing from the other — the window stays `:pending` forever
**File:** `lib/grappa/session/event_router.ex:1739` (contradicted by `:326` and `:330`)
**Category:** non-exhaustive numeric set / stuck state
**Severity:** HIGH

The channel-param canonicalisation list explicitly enumerates "join-failure 403/405/471/473/474/475/476/477" (comment `:326`, guard `:330`), but the handler set one screen below is six codes: `@join_failure_numerics [471, 473, 474, 475, 403, 405]`. `NumericRouter.@delegated_numerics` mirrors the same six. So a JOIN rejected with **477 ERR_NEEDREGGEDNICK** (a `+R` registered-only channel) or 476 produces NO `{:join_failed, ch, reason, code}` effect. Verified consequences:

- `state.in_flight_joins` keeps the entry until the lazy 30 s sweep at the NEXT `record_in_flight_join/2` (`server.ex:6458`);
- `window_state[chan]` stays `:pending` PERMANENTLY — `WindowState.set_failed/4` is reachable only from the `{:join_failed, …}` arm (`server.ex:5615`), and nothing else sweeps `:pending`;
- cic shows a greyed tab that never resolves and never learns the reason or numeric.

The numeric TEXT still lands (scan route → `params[1]` is channel-shaped → `{:channel, chan}`), so the user reads the error in the channel window while the tab lies. Reachability is documented in-tree: DESIGN_NOTES 2026-07-23 (#347) says a `+R` channel "may 477" once the 0.5 s identify-defer fallback fires best-effort, and `server.ex:3256` repeats it ("a +R channel may 477 (473/475 route through the ChanServ-INVITE retry path)") — 477 is known reachable and known NOT covered by the invite path.

**Fix:** Add `476, 477` to `@join_failure_numerics` and to `NumericRouter.@delegated_numerics` in the same commit (the delegation contract this file states repeatedly). While there, audit the set against both bound ircds' `m_join` error exits with the #911 methodology rather than from memory — the 480/489 class is the same shape.

### MEDIUM

#### I-S2. WHOIS-leg correlation reads the accumulator with a narrower fold than the one that wrote it
**File:** `lib/grappa/session/numeric_router.ex:1053`
**Category:** casemapping write/read fold mismatch
**Severity:** MEDIUM

`whois_pending` keys are written network-aware — `normalize_nick(target, casemapping(state))` → `Identifier.canonical_target/2` (`event_router.ex:1187`, `:1303`, `:3824`) — but the #221 WHOIS-leg guard reads them back with the arity-1 ASCII fold: `key = Identifier.canonical_target(target)`.

On an `rfc1459` network (solanum/Libera — supported, and the e2e testnet's second node) a target containing `[ ] \ ~` keys the map as `foo{1}` while the router computes `foo[1]`: `MapSet.member?/2` misses, the numeric is not delegated, and it falls to the param scan that #221 exists to avoid — the exact "misrouted to a bogus `{:query, target}` window" symptom. CLAUDE.md's #537 rule is explicit that a folded WRITE forces a folded READ compare; the two documented rfc1459 carve-outs (DESIGN_NOTES 2026-07-30) do NOT cover this one. Distinct from `Presence` (`presence.ex:107/125/142`), which folds ASCII on both sides and so is merely the documented in-memory gap.

**Fix:** Carry the casemapping into `router_state()` (`new_router_state/4` is already the single constructor) and fold with `canonical_target/2` in `whois_leg?/3`, or have `Session.Server` hand `NumericRouter` an already-folded target. Pin with an rfc1459 unit case.

#### I-S3. The channel-sigil class is open-coded in six places while `CHANTYPES` is now parsed
**File:** `lib/grappa/session/event_router.ex:515`, `:2425`, `:2964`, `:3327`, `:3356`; `lib/grappa/session/numeric_router.ex:1105`; `lib/grappa/irc/identifier.ex:83`
**Category:** duplicated closed set / unused SSOT
**Severity:** MEDIUM

`#&!+` appears as a literal in six independent predicates: two inline `when` guards (channel-NOTICE `:515`, non-channel-NOTICE `:2425`), `channel_target?/1` (`:2964`), `channel_shaped?/1` (`:3327`), `normalize_channel/2`'s sigil guard (`:3356`), `NumericRouter.channel_prefix?/1` (`:1105`), and `Identifier.@channel_regex`. `channel_target?/1`'s own comment says it exists so both decisions "agree byte-for-byte" — true of two of the six. Meanwhile #1255 added `ISupport.chantypes/1` + `default_chantypes/0`, whose comment concedes "this is the literal the whole stack already open-codes": the parsed value has NO server-side consumer, it is only shipped to cic (`session/wire.ex:942`). A network that omits or adds a sigil cannot be honoured, and a change requires finding all six.

**Fix:** Keep the two `when`-guard sites (a guard cannot call a remote function) but derive the rest from `ISupport.chantypes/1`, and make the guards delegate to one macro or one shared attribute so the count is 1+guards, not 6. If per-network CHANTYPES is deliberately out of scope for routing, say so once in `ISupport` and delete the duplicate predicates in favour of `channel_target?/1`.

#### I-S4. The fake IRC server silently discards `feed/2` before the connection is accepted
**File:** `test/support/irc_server.ex:190`
**Category:** test-infra silent swallow
**Severity:** MEDIUM

`def handle_cast({:feed, _}, %{sock: nil} = state), do: {:noreply, state}`. The accept runs in a `spawn_link`'d helper and only reaches state via `{:accepted, sock}`, so `sock: nil` is a real window at the start of every test — and `{:tcp_closed, _}` nils it again. A test that feeds a scripted line into that window loses it entirely and then fails at an unrelated `wait_for_line/3` deadline 1–30 s later with no clue the feed was dropped. This is "no silent-swallow at boundaries" applied to the harness that exists to make cascade-vs-flake triage possible.

**Fix:** Buffer the pending feed and flush it on `{:accepted, sock}`, or make it a `call` returning `{:error, :not_connected}`. Either way the drop must be observable.

### LOW

#### I-S5. `verb()` closed set has drifted from its call sites
**File:** `lib/grappa/irc/client.ex:1037`
**Category:** stale closed-set type
**Severity:** LOW

`reject_invalid_line/1` is called with 26 distinct atoms; the `@typep verb` union lists 23 — missing `:notice` (`:369`), `:channel_modes` (`:716`), `:admin` (`:1000`). The point of the typep is that a new verb shows up as a type error; it currently does not.

**Fix:** Add the three, and consider deriving the union from the send-helper list.

#### I-S6. Docs across the subsystem still name `canonical_channel/1` / `canonical_nick/1`, deleted by #537
**File:** `lib/grappa/session/event_router.ex:259`, `:357`, `:3345`, `:3350`; `lib/grappa/irc/identity.ex:18`; `lib/grappa/session/presence.ex:27`
**Category:** stale documentation
**Severity:** LOW

`Identifier` exports only `canonical_target/1,2`. Historical phrasings are fine; these are present-tense and prescriptive — `event_router.ex:259` tells the reader the entry point's predicate "is sigil-aware (`Identifier.canonical_channel/1` only folds `#&!+`-prefixed strings)", `presence.ex:27` states keys "are ASCII-folded via `Identifier.canonical_nick/1`", `identity.ex:18` lists it among delegated primitives. `grep -rn "canonical_channel\|canonical_nick" lib` returns ~45 hits across 25 files. This is the failure mode `numeric_router.ex:249` documents about itself: "a wrong doc about a family it names BY NUMBER is the alibi that stops the next reader from checking — and it worked on three later passes".

**Fix:** One sweep, rewriting present-tense references to `canonical_target/1` (or `/2` where network-aware) and leaving only explicitly historical mentions.

#### I-S7. `split_mode_prefix/1` still carries the compile-time sigil table the #216 lift removed everywhere else
**File:** `lib/grappa/session/event_router.ex:3139` (sibling: `lib/grappa/irc/identifier.ex:656`)
**Category:** missed lift / member-key corruption on unbound ircds
**Severity:** LOW

353 RPL_NAMREPLY tokens are split with `when prefix in [?@, ?%, ?+]`, while the per-network sigil set is parsed into `ISupport.prefix` (`PREFIX=(ohv)@%+`) and read by both mode walkers. On a network advertising owner/admin sigils (`~`, `&`), the sigil stays glued to the nick and becomes the KEY in `state.members[channel]` — a ghost member, a wrong `meta.sender_prefix` snapshot, a corrupted `members_seeded` roster. Not reachable on the two bound ircds (bahamut `(ohv)@%+`, solanum `(ov)@+`), which is why it survived; it is the one table the Phase-5 lift missed.

**Fix:** Derive the accepted sigils from `Map.values(ISupport.prefix(isupport))` (the 353 clause has `state` in hand). `Identifier.@member_prefix_precedence` is the same literal but is a PRECEDENCE order mirrored with cic — leave it, or make the precedence a projection over the network set.

#### I-S8. `names_fold/3` grows the accumulator with the big list on the left
**File:** `lib/grappa/session/event_router.ex:4296`
**Category:** quadratic accumulation
**Severity:** LOW

`Map.put(accum, :names, existing ++ tokens)` copies `existing` on every 353 line. `auth_fsm.ex:591` documents exactly this trap for the CAP LS buffer and puts the small list on the left; here a 10k-member channel is ~200 lines against a growing 10k-element list. The comment at `:4282` claims "small N, no LIFO needed" — true for the /names modal, false for a big channel.

**Fix:** Prepend reversed chunks and reverse once in `drain_names_pending/2`, matching the `who_fold` / `whowas_append_entry` / `links_append_entry` shape used elsewhere in the same file.

#### I-S9. `ensure_crlf/1` can emit a stray `\r` and trims more than one terminator
**File:** `lib/grappa/irc/client.ex:1263`
**Category:** off-by-one / wrong condition
**Severity:** LOW

`String.trim_trailing(bin, "\n")` removes EVERY trailing `\n`, not one. `"FOO\r\n\n"` does not end with `"\r\n"`, so it takes the second branch, trims both newlines to `"FOO\r"`, and appends `"\r\n"` → `"FOO\r\r\n"`. Only reachable through the unguarded `send_line/2` escape hatch (the `send_*` helpers reject CR/LF), so no production caller hits it today — but this function's stated job is that no upstream caller can produce a malformed frame.

**Fix:** Strip a single trailing `\r?\n` and append `\r\n`.

#### I-S10. AuthFSM absorbs stray SASL numerics only after `:registered`
**File:** `lib/grappa/irc/auth_fsm.ex:463` and `:467`
**Category:** missing phase guard
**Severity:** LOW

The C1 note at `:415-430` says the `:registered` catch-all generalises the phase-pin "principle to the four other auth-relevant message classes", and the `AUTHENTICATE` clause was duly pinned to `:sasl_pending`. 903/904/905 were not: a stray 903 in `:pre_register` emits a `CAP END` into a negotiation that was never opened, and a stray 904/905 stops the Client with `{:sasl_failed, code}` → Backoff → respawn, even for a credential that never negotiated SASL. The comment claims the class is closed; it is closed only on one side of registration.

**Fix:** Pin 903 to `:sasl_pending` and 904/905 to the SASL phases, letting the existing catch-all absorb the rest.

#### I-S11. `wait_for_line/3` can be satisfied by a line that arrived before the barrier was set
**File:** `test/support/irc_server.ex:178`
**Category:** test barrier semantics
**Severity:** LOW

The eager pre-check scans the whole `state.sent` history in arrival order, so "the FIRST matching line wins" across the ENTIRE test, not since the call. A test asserting a second `JOIN #chan` (a rejoin, a reconnect, a retry) resolves instantly against the first and proves nothing.

**Fix:** Document the semantics on `wait_for_line/3` itself (currently only implied by an implementation comment), or add `wait_for_next_line/3` that registers the waiter without consulting the buffer, and use it for repeat-event assertions.

#### I-S12. `ISupport` logs an unmodelled CASEMAPPING by interpolation
**File:** `lib/grappa/session/isupport.ex:630`
**Category:** unstructured Logger metadata
**Severity:** LOW

`Logger.warning("unrecognised CASEMAPPING=#{inspect(other)} — treating as :ascii")`. Every other diagnostic in the subsystem uses the allowlisted structured-KV form (`client.ex:1064`, `:1205`, `:1403`), and the allowlist already carries `cap_value`, `network`, `reason`. Interpolating an upstream-controlled token into the body also makes the line ungreppable by key.

**Fix:** `Logger.warning("unrecognised CASEMAPPING — treating as :ascii", cap_value: inspect(other))`.

#### I-S13. Byte-vs-grapheme mixing in the #676 nick-cap ladder
**File:** `lib/grappa/irc/auth_fsm.ex:556`, `:572`; `lib/grappa/irc/identifier.ex:194`
**Category:** charset boundary
**Severity:** LOW

`NICKLEN` is a BYTE limit on the ircd, but the learned cap is `String.length(echoed)` and the truncation test compares `String.length/1` on both sides; `collision_fallback/3` then guards on `byte_size(suffix)` while slicing with `String.length(suffix)` — two units in one expression. Harmless while every candidate is ASCII (`@nick_regex` is byte-anchored, `@nick_suffix_alphabet` is `a-z0-9`), so latent rather than live — but `Identifier.truncate_nick/1` (`:158`) is fed a `User.name`, which is not obviously ASCII-bounded.

**Fix:** Use `byte_size/1` throughout the cap arithmetic, or state in one place why grapheme length is the right unit here.

#### I-S14. `FakeLag`'s spec forbids the zero-byte frame its docs promise to accept
**File:** `lib/grappa/irc/fake_lag.ex:183`
**Category:** spec contradicts contract
**Severity:** LOW

`record/3` guards `bytes >= 0` and documents that it accepts a zero-byte frame rather than guarding it out, because "instrumentation that can raise there would take a live IRC connection down over a diagnostic". It then calls `cost_ms/1`, whose spec is `pos_integer()`.

**Fix:** `@spec cost_ms(non_neg_integer()) :: pos_integer()`.

#### I-S15. 005 is parsed twice with two different merge rules
**File:** `lib/grappa/session/isupport.ex:107` vs `lib/grappa/session/server.ex:3534`
**Category:** duplicated parser
**Severity:** LOW

The `raw` typedoc states the design goal as "One 005, two readers, no second parse", while `MODES=` / `LINELEN=` are scanned by two separate `reduce_while` scanners in `Session.Server` — first-wins within a line, last-wins across lines, which its own comment at `:3540` admits is a DIFFERENT rule from `merge_isupport/2`'s unconditional last-wins. Both tokens are already archived verbatim in `ISupport.raw`.

**Fix:** Promote `linelen` and `modes_per_chunk` to typed `ISupport` fields with the standard `merge_token/2` + `put_limit/3` shape (they are ordinary numeric tokens, exactly like `NICKLEN`) and have `Session.Server` read them off the table. That also removes the third merge rule.
## Scope: persistence/

Read-only; no tests run and no `EXPLAIN QUERY PLAN` executed (no DB available from this lane) — every performance claim below is derived from reading the query builders against the DDL, and says so.

### HIGH

#### P-S1. #532A/#576 defeated the #393 covering index on `count_after_split/6` — the query behind the 2026-07-25 prod incident
**File:** `lib/grappa/scrollback.ex:634-667` (query), `:710-744` (`exclude_own_authored/3`), `priv/repo/migrations/20260725120000_add_messages_393_perf_covering_indexes.exs`
**Category:** index coverage / silent perf regression
**Severity:** HIGH

#393 (2026-07-25) shipped `(subject, network_id, channel, id, kind)` and `(subject, network_id, lower(COALESCE(dm_with, channel)), id, kind)` explicitly so the `count_after_split` GROUP BY aggregate becomes COVERING — the migration moduledoc records the measurement, "80ms/79ms over 11066 rows on `#linux`" → "5-7ms, ~15x" — and it DROPPED the older `(subject, network_id, channel, id)` composites as strict subsets.

Four and six days later #532 A (DESIGN_NOTES 2026-07-29) and #576 (2026-07-31) added `exclude_own_authored/3` to that same query. The new predicate reads two columns that are in NO index on `messages` — every migration was grepped, and neither `sender` nor `meta` appears in a single index declaration: `Identifier.nick_fold(m.sender) == ^folded` and `fragment("json_extract(?, '$.new_nick')", m.meta)`.

So the aggregate can no longer be satisfied from the index: SQLite seeks `(user_id, network_id, channel, id > ?)` and then does one table row-fetch PER post-cursor row to evaluate `lower(sender)` / `json_extract`. That is exactly the shape #393 measured as the incident. The most affected window is the one that matters: a channel whose read cursor is far behind (the cold-load `/me` seed and the per-channel join reply both route here via `WindowCounts.snapshot/7`). Neither the #532 nor the #576 DESIGN_NOTES entry mentions an index, a covering property, or an EXPLAIN. The DM arm has the same problem through the folded-COALESCE index, and `ReadCursor.bulk_unread_split/3`'s `own_authored_dynamic/2` is the same shape (outside this scope, same defect class).

**Fix:** Re-measure with `EXPLAIN QUERY PLAN` on a prod copy before changing anything. The likely shape is appending `sender` to both `..._channel_id_kind_index` families and adding `json_extract(meta,'$.new_nick')` as an indexed expression, or restructuring so the exclusion is not evaluated per row (count own-authored rows as a second seek on a `sender`-leading index and subtract). Whatever lands, pin the covering property with a test that reads `EXPLAIN QUERY PLAN` and asserts `COVERING INDEX` — the absence of such a pin is what let this through.

#### P-S2. The nick-rename migration chain runs in `Session.Server` with no `BusyRetry` and no transaction
**File:** `lib/grappa/session/server.ex:6111-6137` and `:6171-6186`; `lib/grappa/scrollback.ex:1260-1295`, `:1382-1403`, `:1492-1514`; `lib/grappa/query_windows.ex:287-324`
**Category:** transaction granularity / crash boundary
**Severity:** HIGH

`apply_effects/2` on `{:peer_nick_renamed, old, new}` executes, inline in the supervised `Session.Server`: `{:ok, migrated} = Scrollback.rename_dm_peer(...)`, `:ok = ReadCursor.rename_dm_peer(...)`, `:ok = QueryWindows.broadcast_windows_list(...)`. Three problems compound:

1. **No `BusyRetry`.** `QueryWindows.rename/4` (`Repo.exists?` ×2 then `update_all`/`delete_all`), `Scrollback.rename_dm_peer/4` (aggregate + two `update_all`), `rename_own_nick/4` and `rename_self_window/4` all call `Repo` bare. Under prod's WAL + `pool_size: 10` a transient `SQLITE_BUSY` RAISES — and here the raise crashes the session, disconnecting the user. That is the 2026-07-19 09:17 incident class that `Scrollback.with_pool_retry/1` exists to prevent (`scrollback.ex:63-71`), yet `persist_event/1` is protected and its five sibling write verbs in the same module are not. #523 B1 covered "every web-reachable write"; #590 B2 listed the background writers it migrated — this chain is in neither list, and neither entry mentions it.
2. **Not atomic across three tables.** A crash or busy between `Scrollback.rename_dm_peer` and `ReadCursor.rename_dm_peer` strands the history under the new nick with a cursor keyed to the old one — the exact "reads as fully unread" failure the comment at `:6122-6123` says the cursor move exists to prevent. No self-healing retry: the effect is consumed.
3. **Strict matches amplify it.** `{:ok, migrated} =` / `:ok =` turn any `{:error, _}` into a `MatchError` in the same long-lived process.

The trigger is a netsplit rejoin, where many peers rename at once — the write burst is correlated with the contention.

**Fix:** Wrap the chain in one `Repo.BusyRetry.run(fn -> Repo.immediate_transaction(fn -> … end) end)` (the `Visitors.create_anon/4` shape at `visitors.ex:215-219`), with the broadcast OUTSIDE the transaction so the "fully applied" barrier still holds and a retry cannot double-broadcast. Terminal on budget exhaustion should be the #590 background-DROP posture, not a crash.

#### P-S3. Seven write transactions use deferred `Repo.transaction/1` instead of the mandated `Repo.immediate_transaction/1`
**File:** `lib/grappa/accounts.ex:955`, `:1087`, `:1116`, `:1140`; `lib/grappa/accounts/webauthn.ex:381`; `lib/grappa/accounts/totp.ex:48`, `:56`. Contract: `lib/grappa/repo.ex:95-123`
**Category:** transaction mode / documented-contract violation
**Severity:** HIGH

`Repo.immediate_transaction/1`'s docstring is unambiguous: "Use this for every WRITE transaction. Keep `transaction/2` (deferred) for read-only transactions." It exists because of #524: a deferred transaction's read→write upgrade raises an IMMEDIATE `SQLITE_BUSY` that `busy_timeout` does not cover. Every `Repo.transaction/1` call in `lib/` is a write transaction and all seven are in Accounts; the four correct users (`visitors.ex:216`, `notify.ex:314`, `themes.ex:262`, `push.ex:197`) call `immediate_transaction`. This is the two-patterns split CLAUDE.md warns about.

The sharpest instance is `Accounts.TOTP.verify/3` (`totp.ex:56-64`) — the #524 shape exactly, a `Repo.get!(User, user_id)` READ followed by a conditional `update_all` WRITE inside one deferred transaction — and the only one of the seven with NO `BusyRetry` wrapper at all (`accounts.ex:1022` calls it bare). A busy there surfaces as an uncaught `Exqlite.Error` → 500 at the 2FA login door, not the 503 #518 promises. The other six write first today, so the upgrade does not fire — an accident of statement ordering, not a property; one added preflight `SELECT` arms the trap silently.

**Fix:** Convert all seven, and wrap `TOTP.verify/3` in `Repo.BusyRetry.run/1` at the `verify_second_factor/3` boundary (`accounts.ex:1020-1026`). Consider a Credo check or arch test forbidding `Repo.transaction` outside `Grappa.Repo` — the contract is currently comment-only.

### MEDIUM

#### P-S4. Four dead indexes on `messages`, the highest-write-rate table
**File:** `priv/repo/migrations/20260508132130_messages_dm_with_subject_composite_indexes.exs:55-56`; `priv/repo/migrations/20260722202612_add_messages_id_cursor_composite_indexes.exs:79-80`
**Category:** index coverage / write amplification
**Severity:** MEDIUM

`(user_id|visitor_id, network_id, dm_with, server_time)` and `(user_id|visitor_id, network_id, dm_with, id)`. `20260722202612`'s own moduledoc states their purpose: the `dm_with` id-twins are for symmetry "so the `dm_with=?` arm … is index-seekable". Three days later #393 DELETED that arm — `where_dm_peer/2` (`scrollback.ex:1127-1133`) collapsed the OR-disjunction into a single `lower(COALESCE(dm_with, channel)) = ?`. All of `lib/` was grepped: there is no bare `m.dm_with == ^…` predicate left; every reference is `nick_fold(dm_with)` (`scrollback.ex:1048`, `:1280`, `:1397`, `:1507`) or `nick_fold(COALESCE(dm_with, channel))` (`scrollback.ex:944`, `:1131`; `read_cursor.ex:322`, `:394`). A plain B-tree on the raw column cannot seek any of them. #393 applied exactly this reasoning when it dropped the sibling `..._channel_id_index` composites; it just did not extend it to the `dm_with` family. Every scrollback INSERT maintains four B-tree entries no read can use.

**Fix:** `EXPLAIN QUERY PLAN` the seven `messages` read shapes on a prod copy with the four dropped, confirm no plan regresses, then ship a drop migration. Fold the two `messages_archive_*_idx` from `20260522073826` into the same audit — DESIGN_NOTES 17317-17332 records their #372 staleness and a deliberate KEEP, so they are a documented deferral, not a new finding.

#### P-S5. `user_settings.data` read-modify-write loses concurrent writes to different keys
**File:** `lib/grappa/user_settings.ex:412`, `:556`, `:610-614`, `:712-714`, `:829`, `:890`, `:1081`, `:1171`; write choke point `:1188`
**Category:** concurrency / lost update
**Severity:** MEDIUM

All nine setters are `get_or_init` → `Map.put(settings.data, @key, value)` → changeset → persist, with no transaction, no `optimistic_lock`, and no conditional UPDATE. Two writers targeting DIFFERENT keys both read the same blob and both write a full replacement — last writer wins, the other key is silently dropped. Not hypothetical: `put_last_client_prefix64/2` is driven by `Vhosts.record_client_source/2` (`vhosts.ex:579`) on EVERY client connect, so a second tab connecting while the operator saves a settings-drawer toggle can eat the toggle; `set_highlight_patterns/2` is reachable from two WS handlers (`grappa_channel.ex:1340`, `:1355`) that can interleave. DESIGN_NOTES 17643-17646 states the read-modify-write discipline for the CLIENT; the same hazard on the server side is recorded nowhere.

**Fix:** Route all nine through one private `update_data(subject, fun)` running `get_or_init` + merge + `Repo.update` inside a single `Repo.immediate_transaction/1`, with the existing `BusyRetry` moved to wrap the whole transaction (the `create_anon` precedent). One helper also removes eight copies of the merge idiom.

#### P-S6. `validate_subject_xor/1` is copy-pasted into 12 schemas and has already drifted
**File:** `lib/grappa/uploads/upload.ex:135-145` (the divergent copy) vs `scrollback/message.ex:393`, `accounts/session.ex:253`, `read_cursor/cursor.ex:117`, `query_windows/window.ex:91`, `user_settings/settings.ex:122`, `networks/credential.ex:449`, `notify/entry.ex:104`, `push/subscription.ex:198`, `themes/theme.ex:89`, `vhosts/grant.ex:80`, `channel_directory/entry.ex:90`
**Category:** duplication / drift
**Severity:** MEDIUM

Bodies were normalised and hashed: 11 of 12 are byte-identical. The twelfth, `uploads/upload.ex`, emits `"one of user_id or visitor_id is required"` where the other eleven emit `"must set user_id or visitor_id"` — a WIRE-VISIBLE changeset error message that has already forked, in the one place a "Mirrors `Grappa.ReadCursor.Cursor.validate_subject_xor/1`" comment claims it has not. Each copy carries the same eight-line explanatory comment, so ~120 lines of duplicated prose travel with it. `Grappa.Subject` already owns `subject_where/2` and `put_subject_id/2` and is the obvious home.

**Fix:** `Grappa.Subject.validate_xor(changeset)`, delete the 12 copies, keep one docstring, and fix the uploads message in the same commit (it is the outlier, not the standard).

#### P-S7. `BusyRetry` nested INSIDE an open `immediate_transaction`, which the codebase elsewhere documents as forbidden
**File:** `lib/grappa/visitors.ex:215-219` + `:237` → `lib/grappa/user_settings.ex:339` and `:1188`
**Category:** retry composition
**Severity:** MEDIUM

`create_anon/4` correctly wraps the whole transaction from outside. But `provision_anon_row/5`'s third step (`visitors.ex:237`) calls `UserSettings.put_upload_ttl_seconds/2`, which internally runs TWO more `Repo.BusyRetry.run/1` loops — `get_or_init/1` (`user_settings.ex:339`) and `persist/1` (`:1188`) — inside the already-open transaction. `Grappa.Accounts`' own family contract (`accounts.ex:749-757`) names this as the thing not to do: "a nested retry would sleep while holding the open transaction's connection, extending the very contention it waits on, and would convert a raise the transaction needs into a return value." Both consequences apply.

There is also a shape trap in the error path: `provision_anon_row`'s `else` binds `{:error, changeset}`, but the inner retry can return `{:error, :db_unavailable}`, so the ATOM is passed to `Repo.rollback/1` under a variable named `changeset` (`visitors.ex:240`). It works only because `create_anon/4`'s spec admits both; any future `%Ecto.Changeset{}` match on the rollback value breaks.

**Fix:** Add a non-retrying `!`-variant (or an `:in_transaction` seam) to the `UserSettings` setters for in-transaction callers, mirroring `revoke_sessions_for_user!/1`. Rename the `else` binding to `reason`.

#### P-S8. Session-driven credential persisters and web-reachable scrollback deletes were missed by #523 B1 / #590 B2
**File:** `lib/grappa/networks/credentials.ex:264-285` (`update_last_joined_channels/3`), `:305-317` (`update_away/4`), `:186-201`, `:212-230`; `lib/grappa/scrollback.ex:1198-1225` (`delete_for_dm/3`), `:1536-1560` (`delete_for_channel/3`)
**Category:** error boundary / missing BusyRetry
**Severity:** MEDIUM

`update_last_joined_channels/3` fires on every self-JOIN / self-PART / self-KICK (its own docstring) and `update_away/4` on every away transition; both do `Repo.get_by` + `Repo.update` with no retry. The `Session.Server` call sites (`server.ex:5082-5098`, `:6943-6956`) handle a RETURNED `{:error, _}` with a warning — but a transient busy RAISES, and the raise escapes the persister closure into the GenServer. Bootstrap spawning N sessions × M autojoin channels is precisely the correlated write burst. `Scrollback.delete_for_dm/3` and `delete_for_channel/3` are reached from `ArchiveController.delete/2` — web-reachable writes, so per #523 B1's stated scope they should degrade to 503; today they 500. Neither DESIGN_NOTES entry lists these five or explains their omission (unlike `update_nick`, which B1 explicitly deferred).

**Fix:** Wrap each in `Repo.BusyRetry.run/1`, with the three-doors terminal split: background-DROP for the two persisters, `:db_unavailable` → 503 for the two deletes.

#### P-S9. The release CI migration gate counts files instead of comparing versions — the exact anti-pattern CLAUDE.md names
**File:** `.github/workflows/release.yml:204-209` and `:329-334`; no duplicate-version gate anywhere in `test/` or `scripts/`
**Category:** migration integrity
**Severity:** MEDIUM

CLAUDE.md, after the #1044/#1038 collision: "A deploy preflight must compare migration VERSIONS against `schema_migrations`, never count pending files — a pending count of zero is exactly what the silent regime produces." The only gate that exists counts: `find priv/repo/migrations -name '*.exs' | wc -l` against `SELECT count(*) FROM schema_migrations`. A count comparison passes whenever the cardinalities happen to match (a deleted file plus an added file; an orphan version from a rolled-back branch). `Grappa.Deploy.Preflight` classifies migrations by CONTENT (`preflight.ex:225-231`, `:480-491`) and never touches `schema_migrations`. Meanwhile the precondition is live: **40 of the 86** migrations carry hand-typed round stamps, and nothing in CI rejects a new one or detects a duplicate version.

**Fix:** Two one-liners. (a) Replace the count with a SET comparison of `SELECT version FROM schema_migrations` against the parsed filename versions, failing on asymmetry in either direction. (b) Add a bats/ExUnit check that `ls priv/repo/migrations | cut -c1-14 | sort | uniq -d` is empty, and optionally that a newly added stamp is not `……0000`.

#### P-S10. 51 references to `canonical_channel/1` / `canonical_nick/1`, functions #537 deleted
**File:** e.g. `lib/grappa/query_windows.ex:49` and `:361` (public `@doc`), `lib/grappa/scrollback.ex:676`, `:680`, `:1096`, `:1201-1206`, `lib/grappa/read_cursor.ex:127-128`, `:175`, `:266-267`, `lib/grappa/notify.ex:34`, `:71`, `lib/grappa/user_settings.ex:1449-1468`
**Category:** documentation rot
**Severity:** MEDIUM

`grep -rn "canonical_channel\|canonical_nick" lib/` returns 51 hits; `grep -rn "def canonical_channel\|def canonical_nick" lib/` returns zero. This matters more here than in most codebases: CLAUDE.md's framing is that "the codebase IS the instruction set" and every session starts with zero memory, so 51 comments describing a SIGIL-GATED fold that no longer exists is an active instruction to reimplement the #364/#525 over-fold. `query_windows.ex:361` is inside a public `@doc`, so it ships in ExDoc as a dangling reference. (Same class as I-S6 and L-S11 — one sweep covers all three scopes.)

**Fix:** Mechanical sweep to `canonical_target/1`, plus a Credo/grep gate on the two dead names.

### LOW

#### P-S11. dev/test PRAGMAs are not in lockstep with prod, despite comments claiming they are
**File:** `config/dev.exs:10-16`, `config/test.exs:18-23` vs `config/runtime.exs:176-191`
**Category:** environment fidelity
**Severity:** LOW

Both non-prod files carry "pin PRAGMAs in lockstep with `config/runtime.exs`" but pin only `synchronous` and `foreign_keys`; prod additionally pins `journal_mode: :wal`, `cache_size: -64_000`, `temp_store: :memory`. WAL is forced everywhere by `Repo.init/2` (`repo.ex:39-43`), so durability is covered — but the 64 MB page cache and in-memory temp store are not, so any local query-plan or timing observation is taken against a different engine configuration than prod.

**Fix:** Add the three keys to both files, or narrow the comment to what is actually pinned.

#### P-S12. `Grappa.Release.rollback/2` skips `start_vault!()` against its own moduledoc
**File:** `lib/grappa/release.ex:80-87` vs `:31-35`
**Category:** release path / Cloak
**Severity:** LOW

(Same finding as L-S15 from the lifecycle agent, independently reached.) The moduledoc says each entry point starts the Cloak vault; `rollback/2` does not. Harmless today because migrations use raw SQL, but a `down/0` touching an encrypted column through a schema would `:noproc` on the release substrates only.

**Fix:** Add `start_vault!()`.

#### P-S13. Stale user-facing changeset error on `dm_with`
**File:** `lib/grappa/scrollback/message.ex:432`
**Category:** correctness of an error message
**Severity:** LOW

The message reads "may only be set on :privmsg or :action rows", but `@dm_with_eligible_kinds` is `@content_kinds` = `[:privmsg, :notice, :action]` (`message.ex:202`) — `:notice` was added by the CP23 code-reload cluster and the string was not. A caller debugging a rejected `:notice` row is told the opposite of the rule.

**Fix:** Derive the message from `@dm_with_eligible_kinds` rather than restating it.

#### P-S14. Double `canonical_target/1` application plus stale rationale comments
**File:** `lib/grappa/scrollback.ex:1033` + `:1043`; `:1200-1206`
**Category:** dead code / misleading comment
**Severity:** LOW

`channel_or_dm_where/3` folds `channel` at `:1033` and again at `:1043`; `delete_for_dm/3` does it in two explicitly named steps. The fold is idempotent so there is no bug, but the accompanying comment still describes the deleted two-stage `canonical_channel/1`-then-`canonical_nick/1` pipeline the two calls are a residue of, so a reader concludes two different folds are being composed.

**Fix:** Collapse each to one call; delete the stale rationale.

#### P-S15. `destroy_visitor/1`'s "deliberately not a transaction" rationale is stale
**File:** `lib/grappa/visitors.ex:799-809`
**Category:** stale rationale
**Severity:** LOW

The comment justifies skipping atomicity because "re-home's leading SELECT would start a DEFERRED (read) sqlite transaction that then upgrades to a write on the DELETE — and that read→write upgrade throws SQLITE_BUSY". That is precisely what `Repo.immediate_transaction/1` was built to eliminate and what four other contexts already use. The idempotence argument that follows is sound and may still be the right call — but the STATED reason no longer holds, and it sits in the codebase as an argument against using the tool.

**Fix:** Adopt `immediate_transaction/1`, or rewrite the comment to rest on idempotence alone.

#### P-S16. `:utc_datetime` vs `:utc_datetime_usec` split across schemas
**File:** `lib/grappa/query_windows/window.ex:57`, `:59`; `lib/grappa/user_settings/settings.ex:90`; `lib/grappa/notify/entry.ex:57`; `lib/grappa/channel_directory/entry.ex:58` — vs 16 schemas on `:utc_datetime_usec`; project default `config/config.exs:5`
**Category:** consistency
**Severity:** LOW

Four schemas store second precision against a project-wide usec default. Nothing is broken (SQLite stores both as ISO-8601 TEXT and `QueryWindows.open/4` correctly truncates at `:168`), but `:utc_datetime` RAISES on a non-truncated `DateTime` cast, which makes it a trap: `fetch_existing/3`'s fallback changeset at `:517` already passes an untruncated `DateTime.utc_now()`, harmlessly only because that changeset is returned as an error. Same class: `networks/credential.ex:253`'s `connection_state_changed_at` is second-precision while the rest of that schema is usec.

**Fix:** Pick one and migrate all, or record the exception in DESIGN_NOTES.

#### P-S17. Redundant single-column FK indexes duplicating a partial-unique prefix
**File:** `priv/repo/migrations/20260628105147_create_network_featured_channels.exs:15-16`; also `20260711123000_xor_fk_network_credentials.exs:110-123`, `20260718140000_create_notify_entries.exs:47-58`, `20260515005115_xor_fk_query_windows.exs`
**Category:** write amplification
**Severity:** LOW

Clearest case: `unique_index([:network_id, :name])` followed immediately by `index([:network_id])`, a strict prefix. Same for the XOR-FK tables, where `index([:user_id], where: "user_id IS NOT NULL")` is a strict prefix of the partial unique `(user_id, network_id, lower(…)) WHERE user_id IS NOT NULL`. Low-write tables, so small cost — flagged as a coherent cleanup batch with P-S4. (`vhost_grants`' pair is NOT redundant: its unique index leads with `vhost_id`.)

#### P-S18. `RecoveryCodes.replace/2` documents atomicity it does not itself establish
**File:** `lib/grappa/accounts/recovery_codes.ex:70-86`
**Category:** contract accuracy
**Severity:** LOW

`@doc "Atomically replaces the stored recovery set…"` — the body is a bare `delete_all` then `insert_all`, no transaction. Correct today only because both callers (`totp.ex:158`, `webauthn.ex:386`) are inside one; the guarantee lives entirely in the callers, and the docstring invites a third that is not.

**Fix:** State the in-transaction precondition in the docstring (the `revoke_sessions_for_user!/1` `!`-convention would make it visible at the call site), or wrap it.
## Scope: lifecycle/

### HIGH

#### L-S1. `Backoff` failure counter is unbounded, and the wait is exponentiated before it is capped
**File:** `lib/grappa/session/backoff.ex:313-321` (consumed at `lib/grappa/session/server.ex:1441`)
**Category:** lifecycle / arithmetic / crash-loop
**Severity:** HIGH

`handle_call({:failure, key}, …)` (`backoff.ex:274-283`) increments `count` with no ceiling and the ETS row survives every `:transient` respawn. `compute_wait/1` does `raw = @base_ms * trunc(:math.pow(2, count - 1))` and only then `min(raw, @cap_ms)` — the cap is applied after the exponentiation, so the exponent tracks the raw failure count forever. On OTP the `math` BIFs raise `badarith` once the double result is unrepresentable (exponent ≥ 1024); below that, `raw` is an ever-growing bignum computed on every session start.

The counter clears only on `record_success/2`, which fires from the #100 `:connection_stable` timer — i.e. only after a 001 RPL_WELCOME that survives `connection_stable_ms` (`server.ex:3248-3251`). A network that never completes registration (decommissioned endpoint, long k-line, DNS blackhole) never resets it, and the terminal-failure escalations that would stop the loop are only 465 / permanent-904 / KILL (`server.ex:3408`, `:3430`, `:3480`) — a plain connect refusal is not one of them. At the 5-minute cap that is roughly 3.5 days of sustained failure to reach the overflow exponent.

Why it matters beyond arithmetic: the raise happens in `handle_continue({:start_client, _}, state)`, i.e. BEFORE any delay is scheduled. The session crashes instantly, `terminate/2` bumps the counter again (`server.ex:1695`), and the `:transient` restart re-enters the same crash with zero pacing — the full-CPU restart spin that the `max_restarts: 10_000, max_seconds: 60` comment in `application.ex:335-351` describes, which on exhaustion takes `Grappa.SessionSupervisor` down and every other session with it.

Not measured on a running BEAM (read-only review, no `erl` on the host): the overflow threshold is stated from the OTP `math` contract. The unbounded-counter half is directly readable from the code.

**Fix:** Clamp the exponent, not the product — cap `count` at the smallest value where `@base_ms * 2^(count-1) >= @cap_ms` when writing the ETS row, or compute `min(@cap_ms, @base_ms <<< min(count - 1, 30))`. Clamping at write also keeps `failure_count/2` (read by `SessionPlan`'s server-ring walk, `networks/session_plan.ex:188`) from growing without bound.

### MEDIUM

#### L-S2. `Session.Server.init/1` performs DB reads, contradicting two documented contracts
**File:** `lib/grappa/session/server.ex:1083-1093`; contracts at `lib/grappa/session.ex:41-44` and `server.ex:1057-1062`
**Category:** invariant drift / blocking init
**Severity:** MEDIUM

`init/1` invokes the injected `refresh_plan` closure, which (`networks/session_plan.ex:185-198` → `resolve_attempt/2` at `:77-91`) runs `Credentials.get_credential_by_ids/2`, `Repo.preload(network: :servers)` and `Accounts.get_user!/1` — three SQLite round-trips inside `init/1`, i.e. inside the caller's blocking `DynamicSupervisor.start_child/2`.

Two live docs are now false: `Grappa.Session`'s moduledoc ("the Server's `init/1` is therefore a pure data consumer (no `Repo`, no `Networks`, no `Accounts`, no `Visitors` reads)" — the A2 cycle-inversion contract) and `server.ex:1057` ("`init/1` is intentionally non-blocking"). The upstream-socket half of the latter still holds; the DB half does not, and Bootstrap's spawn loop is serialised on N × 3 queries.

The closure indirection preserves the Boundary graph, so this is not a Boundary violation — it is a contract the code outgrew and the docs did not follow.

**Fix:** Move the re-resolve into `handle_continue({:start_client, _}, _)` (it only needs to happen before the Client spawns, and the Backoff branch already defers there), or amend both docs to state the real contract. Prefer the former — it restores the O(1)-per-session boot the comment promises.

#### L-S3. Every credential's session plan is resolved twice on every boot
**File:** `lib/grappa/bootstrap.ex:353` and `lib/grappa/session/server.ex:1085`
**Category:** duplicated work / consistency
**Severity:** MEDIUM

`Bootstrap.spawn_one/2` calls `SessionPlan.resolve(credential)` (preload + `get_user!` + `pick_server!`), threads the plan through `SpawnOrchestrator.spawn/4` into `Session.start_session/3`, and the first thing `init/1` does is call `refresh_plan`, which re-reads the credential, re-preloads, re-fetches the user, re-picks the server and merges over the plan just built.

The zombie-respawn rationale for `refresh_plan` (the 2026-05-27 `kazam02` incident) is about the supervisor's frozen child spec ON RESPAWN. On the Bootstrap path the cached opts were built microseconds earlier, so the re-resolve buys nothing and costs a full plan resolution per credential at every boot — plus a divergence: the attempt ordinal differs (`resolve/1` pins 0, `refresh_plan` reads `Backoff.failure_count/2`), so the server Bootstrap picked can differ from the one the session dials.

**Fix:** Make the re-resolve conditional on being a respawn — have `Session.start_session/3` mark the plan as freshly resolved and have `init/1` skip `refresh_plan` on that first pass. The supervisor's cached child spec never carries the marker, so every restart still re-resolves.

#### L-S4. `Bootstrap.run/0` queries the visitor set and every visitor's credentials twice
**File:** `lib/grappa/bootstrap.ex:212`, `:225`, `:246`, `:632-635`, `:398`
**Category:** duplicated work / snapshot consistency
**Severity:** MEDIUM

`run/0` binds `visitors = Visitors.list_active()` at `:212` and uses it at `:246`; in between, `validate_credential_servers!/1` calls `Visitors.list_active()` again (`:633`) and then `Credentials.list_visitor_credentials/1` once per visitor (`:634`) — the same per-visitor query `spawn_visitor/2` repeats at `:398`. Two list queries plus 2N credential queries where N and 2 would do, and the two snapshots can disagree if the Reaper sweeps between them (the validate pass could raise on a network belonging to a visitor the spawn pass no longer sees).

**Fix:** Fetch the visitor credentials once in `run/0` and pass the materialised `[{visitor, credentials}]` into both `validate_credential_servers!/1` and `spawn_visitors/1`.

#### L-S5. `Bootstrap.classify_outcome/3`'s `@spec` cannot express an outcome it handles
**File:** `lib/grappa/bootstrap.ex:504-508` (clause at `:528`)
**Category:** missing/incorrect spec
**Severity:** MEDIUM

The spec accepts `{:ok, atom(), pid()} | {:error, term()}`, but `{:ok, :ignored}` — a documented `SpawnOrchestrator.spawn_outcome()` member (`spawn_orchestrator.ex:253`) with its own clause at `:528` and its own counter (`subject_row_gone`) — is not in the input type, so that arm is unreachable per the contract. The spec also re-spells the orchestrator's published union by hand instead of referencing it, which is how the member went missing.

**Fix:** `@spec classify_outcome(Grappa.SpawnOrchestrator.spawn_outcome(), keyword(), Result.t()) :: Result.t()`.

#### L-S6. `EventRouter.effect()`'s `:server_reply` source union has drifted from the Wire SSOT
**File:** `lib/grappa/session/event_router.ex:209` vs `lib/grappa/session/wire.ex:383-390`
**Category:** published type drift
**Severity:** MEDIUM

The effect type declares `source :: :info | :version | :motd`, but `event_router.ex:2301` emits `{:server_reply, :admin, …}` (#992). `Grappa.Session.Wire` already owns the closed set as `@server_reply_sources [:info, :version, :motd, :admin]`, and its moduledoc (`wire.ex:378-382`) records that a previous mis-spelling of exactly this set produced "a `FunctionClauseError` inside `apply_effects/2` and took the whole `Session.Server` down with it. A closed set gets ONE spelling." `apply_effects/2` has no catch-all (last arm `{:own_nick_renamed, …}` at `server.ex:6171`), so this drift class is a session-killer. `server.ex:5540`'s comment carries the same omission.

**Fix:** Replace the inline union with `Grappa.Session.Wire.server_reply_source()` and update the comment.

#### L-S7. `NetworkCircuit` can transition open→closed without emitting `circuit_close`
**File:** `lib/grappa/admission/network_circuit.ex:275-283`
**Category:** telemetry correctness
**Severity:** MEDIUM

The `{:failure, _}` cast's last clause handles "state is `:open` but the cooldown already elapsed and no `:cooldown_expire` cast was observed" by calling `handle_closed_failure(network_id, 0, now, now)`, writing a fresh `:closed` row with no `Telemetry.circuit_close/2`. Both `Telemetry`'s moduledoc (`telemetry.ex:15`, "emitted once per open→closed transition") and `NetworkCircuit`'s own contract promise a paired event, so a consumer counting transitions (the Phase-5 PromEx use and the M-11 `AdminEvents` sink) sees an `:open` with no matching `:close` and then a second `:open` — the exact skew the `{:success, _}` handler avoids at `:287-305`.

**Fix:** Emit `Telemetry.circuit_close(network_id, :cooldown_expired)` on that arm before delegating.

#### L-S8. `Admission.check_capacity/1` reads the same `Network` row twice
**File:** `lib/grappa/admission.ex:224` / `:237` and `:368`
**Category:** duplicated work
**Severity:** MEDIUM

`check_network_total/2` does `Repo.get(Network, network_id)` for the concurrency cap; on success `check_ip_cap/2` → `effective_max_per_ip/1` reads the same row again for `max_per_ip`. This runs on every login, every `PATCH /networks/:id {connected}` and every bootstrapped row.

**Fix:** Load the network once at the top of `check_capacity/1` and pass the struct (or `nil`) to both checks — both already handle `nil`.

#### L-S9. `Session.Server` state is an 83-key bare map, and the module is 7,230 lines
**File:** `lib/grappa/session/server.ex:1179-1366` (state literal), `@type t` at `:~640-956`
**Category:** oversized GenServer state / god module
**Severity:** MEDIUM

83 keys in the `do_init/1` literal and 83 in `@type t` — in sync, which is good, but a lot for "what I need to do my next message" (CLAUDE.md). None of it is durable state that belongs in Ecto; the finding is organisation, not misplacement. The decomposition trajectory is established and correct (`WindowState` cluster #6, `AwayState` #7, `Broadcaster`/`Persistor`/`SpawnOrchestrator` #8) and simply stopped early. The obvious remaining bundle is half-extracted already: `whois_pending` / `who_pending` / `names_pending` / `whowas_pending` / `list_mode_pending` / `links_pending` / `info_pending` / `version_pending` / `motd_pending` / `admin_pending` / `labels_pending` + `labels_pending_at` (12 keys) share one lifecycle and two helpers (`prime_pending/3`, `sweep_stale/3`, `server.ex:4884-4910`).

Secondary: the state is a plain map, not a struct, so `Map.put(state, :typo, …)` adds silently (the `%{state | …}` form is safe). Combined with the pervasive `Map.get(state, :key, default)` hot-reload-safety pattern (#216), a key that genuinely goes missing degrades quietly instead of crashing. Deliberate and documented per-site — worth re-confirming rather than inheriting.

**Fix:** Continue the cluster-#6 pattern with a `Grappa.Session.Pending` bundle (12 keys → 1, and the TTL sweep gets a home).

#### L-S10. `Bootstrap.Result` documents five counters and carries six
**File:** `lib/grappa/bootstrap.ex:167` and `:77-98`
**Category:** doc drift (operator-dashboard contract)
**Severity:** MEDIUM

The moduledoc says "Five-counter accumulator" and lists `spawned`, `already_running`, `capacity_rejected`, `network_failed`, `plan_failed`. `subject_row_gone` (`:179`, `:187`, logged at `:339` and `:384`) is a sixth, appears in both summary lines, and has its own semantic (`:ignore` from `init/1` — the subject's DB row is gone).

**Fix:** Add it to both lists and to the "Operator dashboard semantics" paragraph at `:99-104`.

### LOW

#### L-S11. Doc references to `canonical_channel/1` and `canonical_nick/1`, which #537 deleted
**File:** `lib/grappa/session/part_cleanup.ex:45`, `ghost_recovery.ex:106`, `presence.ex:27`, `event_router.ex:259`
**Category:** stale docs
**Severity:** LOW

`Grappa.IRC.Identifier` exports only `canonical_target/1` and `/2`. The four sites name deleted functions while the code beside them correctly calls `canonical_target/1`. `part_cleanup.ex:45` is the most misleading: it states the module's canonicalisation contract in terms of the deleted sigil-gated function, which had DIFFERENT semantics (it folded only `#&!+`-prefixed strings). Repo-wide class — ~20 more sites outside this scope (`read_cursor.ex`, `query_windows.ex`, `notify.ex`, `scrollback.ex`, `user_settings.ex`, `channel_directory.ex`, `presence_filter.ex`, `archive_controller.ex`).

**Fix:** Sweep the class in one commit, but read each site: the old names had different fold semantics, so this is not a blind rename.

#### L-S12. Comment asserts `:network_id` is not in the Logger metadata allowlist; it is
**File:** `lib/grappa/session.ex:526-532`
**Category:** stale comment
**Severity:** LOW

The comment justifies inlining subject/network into the message body because "`:subject` and `:network_id` are NOT in the Logger metadata allowlist". `:network_id` IS in the allowlist (`config/config.exs`, between `:subject_kind` and `:liveness_idle_ms`); `:subject` is genuinely absent (`:subject_kind` is the allowlisted spelling). Half-right comments get either copied or distrusted.

**Fix:** Narrow the claim to `:subject`, and consider promoting `network_id` out of the interpolated body at `:536`.

#### L-S13. `send_part/4`'s doc points at `send_join/4` for a "cast rationale" that `send_join/4` argues against
**File:** `lib/grappa/session.ex:863-864`
**Category:** stale doc
**Severity:** LOW

"Cast (see `send_join/4` for the rationale)" — but `send_join/4` (`:780-802`) is a synchronous CALL whose docstring is a five-paragraph argument for why it was converted away from a cast (the `window_pending` broadcast stranded behind the mailbox under CI load, timing out `cp15-b6-kicked.spec.ts`). The pointer delivers the opposite of what it promises. Substantively: PART's window-state transition rides `cast_session/3` (`:879`), so the eager `PartCleanup` wipe and the `channels_changed` broadcast are not observable when the REST call returns — the same asymmetry that made JOIN a call.

**Fix:** State PART's own rationale; if there isn't one, the symmetry argument applies and PART should become a call.

#### L-S14. CLAUDE.md's supervision-tree diagram omits a child whose placement is documented as load-bearing
**File:** `CLAUDE.md` (Architecture diagram) vs `lib/grappa/application.ex:357-371`
**Category:** doc drift
**Severity:** LOW

`Grappa.Net.SourceAliasManager` is absent from the diagram, yet `application.ex:357-369` carries a 14-line comment explaining its slot is deliberate in both directions (the boot reconcile must follow the public surface; #543 INC-6 sessions call `acquire/1` on their connect path). CLAUDE.md says child order is load-bearing and points readers at the diagram first. Secondary: the diagram places `Grappa.Accounts.WebAuthnChallengeStore` after `PtrCache`, the code starts it between `FailureWindow` and `TokenBucket` (`application.ex:306`) — harmless, but it undercuts "the diagram is the map".

**Fix:** Add the `SourceAliasManager` row with its one-line why; align the WebAuthn row.

#### L-S15. `Release.rollback/2` skips `start_vault!/0`; `Release.migrate/0`'s doc claims it stops the BEAM
**File:** `lib/grappa/release.ex:80-87` and `:53-58`
**Category:** inconsistency / stale doc
**Severity:** LOW

`migrate/0`, `seed_themes/0` and `cli/1` all call `start_vault!/0` before touching the Repo, and `:158-171` explains why (Cloak's Ecto types call the Vault GenServer at schema load/dump; a release `eval` starts neither). `rollback/2` omits it, so a down-migration touching any encrypted-column schema fails with `:noproc` on the two release substrates only. Separately, `migrate/0`'s doc says "Stops the BEAM cleanly on success or any error" — it returns `:ok` or raises; only `abort/1` (`:147-151`) halts.

**Fix:** Add `start_vault!()` to `rollback/2`; correct the `migrate/0` doc.

#### L-S16. Dead identity mapping in `Admission.count_live_sessions/2`
**File:** `lib/grappa/admission.ex:258-262`
**Category:** dead code
**Severity:** LOW

`case subject_kind do :visitor -> :visitor; :user -> :user end` maps each atom to itself. It does act as a totality guard, but that guard already exists upstream in `subject_kind_for_flow/1` (`:194-200`, no catch-all), and `live_counts_for_network/1` passes the literals directly.

**Fix:** Use `subject_kind` directly, or keep it and say in a comment that it is a deliberate totality guard.

#### L-S17. Two stale statements in the admission docs
**File:** `lib/grappa/admission.ex:377` and `lib/grappa/admission/telemetry.ex:80-81`
**Category:** stale docs
**Severity:** LOW

`admission.ex:377` still describes the network-binding join as "visitor.network_slug = network's slug"; the #211 phase-7 note 18 lines below explains that column was dropped and the join goes through `network_credentials` (which the code does at `:401-413`) — the stale sentence sits ABOVE its own correction. `telemetry.ex:80-81` documents `flow` as "e.g. `:user`, `:visitor`"; neither exists in `Admission.flow/0` (`:64-71`), whose members are `:login_fresh | :login_existing | :bootstrap_user | :bootstrap_visitor | :patch_network_connect | :visitor_reconnect | :admin_credential_bind`.

**Fix:** Delete the superseded sentence; replace the telemetry examples with real flow atoms.

#### L-S18. Two `WindowState` mutators rebuild the struct with a full literal
**File:** `lib/grappa/session/window_state.ex:174-182` and `:246-254`
**Category:** latent maintenance hazard
**Severity:** LOW

`set_joined/2` and `set_parted/2` construct a fresh `%__MODULE__{…}` rather than updating the passed struct, so any field added later is silently reset to its default by these two. Known — `invited_by/2`'s doc at `:340-342` names it — but the warning lives on a READER function, three definitions from the two mutators that carry the risk.

**Fix:** Convert to `%{ws | …}` updates (behaviour-identical today, structurally safe tomorrow), or move the warning onto the mutators.
## Scope: web/

### HIGH

#### W-S1. `MessagesController` 500s on list- or map-shaped pagination query params
**File:** `lib/grappa_web/controllers/messages_controller.ex:477` (`parse_int/1`), `:490` (`parse_limit/1`), reached from `:450` and `:150`
**Category:** payload-shape crash / boundary validation
**Severity:** HIGH

`parse_int/1` is defined only for `is_binary(s)`; `parse_limit/1` only for `nil` and `is_binary(s)`. `Plug.Conn.Query` decodes `?before[]=1` to `%{"before" => ["1"]}` and `?limit[a]=1` to a map, so `GET .../messages?before[]=1` (or `after[]`, `around[]`, `limit[]`) reaches these with a list and raises `FunctionClauseError` → a 500 with a stacktrace, bypassing `FallbackController`, on a route whose documented contract is "present and unparseable = 400".

The class was already found and fixed one function away: `parse_after/1:475` carries an explicit catch-all whose comment says "any non-string shape Plug can hand us (`?after[]=1` parses to a LIST): 400 … Without the catch-all the list case is a FunctionClauseError". The sibling controllers guard it too (`DirectoryController.parse_limit/1:114`, `DirectoryController.string_param/2:98`, `ChannelsController.part_reason/1:210`). Only `index/2`'s three cursors and its `limit` were left unfixed.

**Fix:** Add `defp parse_int(_), do: {:error, :bad_request}` and `defp parse_limit(_), do: {:error, :bad_request}`. Both inherit the existing 400 contract.

### MEDIUM

#### W-S2. `GrappaChannel.join/3` does duplicated DB work plus a blocking `GenServer.call` on the transport-serialised join path
**File:** `lib/grappa_web/channels/grappa_channel.ex:250` + `:258`, helpers at `:329-350` and `:385-429`
**Category:** performance / duplicated work
**Severity:** MEDIUM

The moduledoc (step 4, `:31-34`) states the rule — "`join/3` must be fast (Phoenix blocks the client until it returns)" — which is why the snapshot is deferred to `:after_join`. But `join/3` then runs synchronously, before returning: `canonicalize_topic/1` → `topic_casemapping/2` → `resolve_subject/1` (an `Accounts.get_user_by_name!` query) + `Networks.get_network_by_slug/1` + `Session.casemapping/2` (a blocking `GenServer.call` into the same `Session.Server` mailbox that drains upstream IRC traffic); then `join_reply/1` → `resolve_subject/1` AGAIN, `get_network_by_slug/1` AGAIN, then `ReadCursor.get/3`, `UserSettings.get_highlight_patterns/1`, `Resolver.hidden?/4` and `WindowCounts.snapshot/7`.

`Phoenix.Channel.Server.join/4` blocks the transport process until the channel replies, so N per-channel joins on one socket serialise. A user with 30 windows pays 30× (2 duplicate user lookups + 2 duplicate network lookups + 1 session call + the counts fold) before the socket is usable.

**Fix:** Resolve `subject` and `network` ONCE in `join/3` and thread them into both `canonicalize_topic/1` and `join_reply/1` (−2 queries per join outright). Then decide deliberately whether the `WindowCounts` seed belongs in the join reply or in the existing `:after_join` push — the reply shape is additive-only, so moving it is a client-visible decision; the duplicated resolution is waste either way.

#### W-S3. Admin `PUT /settings` silently accepts unknown body keys, alone among the admin controllers
**File:** `lib/grappa_web/controllers/admin/settings_controller.ex:206-209`, `:304-309`
**Category:** silent-swallow at a boundary / consistency
**Severity:** MEDIUM

An unrecognised key under `upload` or `addressing` is logged at warning and the action returns 200 with the full settings view — indistinguishable from a successful write. The moduledoc promises that any invalid value collapses to 422 `invalid_setting` with the offending dotted key, which covers bad VALUES but not bad KEYS; an operator who types `image_per_file_cap` instead of `image_per_file_cap_bytes` watches a save succeed and change nothing.

Every sibling admin controller does the opposite — `Admin.NetworksController.create_attrs/1` / `settings_attrs/1`, `Admin.ServersController.server_attrs/2`, `Admin.CredentialsController.update_attrs/1` / `create_attrs/1`, `Admin.FeaturedChannelsController.channel_attrs/1`, `Admin.UsersController.*_attrs/1`, `Admin.VhostsController.vhost_attrs/1` all compute `extra = Map.keys(params) -- allowed` and return `{:error, :bad_request}`. CLAUDE.md's "no silent-swallow at boundaries" and "same problem, same solution" pull the same way.

**Fix:** Reject unknown keys in both subtrees with `{:error, {:invalid_setting, "upload.<key>"}}` (or plain `:bad_request`, matching the siblings) and drop the two warning helpers.

#### W-S4. `NetworksController.update/2` `@spec` names an unreachable error and omits three reachable ones
**File:** `lib/grappa_web/controllers/networks_controller.ex:147-149`
**Category:** `@spec` drift
**Severity:** MEDIUM

The spec is `{:error, :bad_request | :forbidden | :not_found | :not_connected}`. `:forbidden` has no producer on this path (`parse_connection_state/1` and `parse_reason/1` yield `:bad_request`, `fetch_credential/2` yields `:not_found`, `Networks.disconnect/2` is specced `{:ok, Credential.t()} | {:error, :not_connected}`). Missing: `:resolve_failed` (`:440`/`:459`), every `Grappa.Admission.error()` (`:ip_cap_exceeded`, `:user_cap_exceeded`, `:visitor_cap_exceeded`, `{:network_circuit_open, _}`, captcha errors) and `{:start_failed, term()}` — all reachable through `NetworkSpawn.orchestrate/4:415`, and all with `FallbackController` clauses precisely because they arrive here.

**Fix:** `{:error, :bad_request | :not_found | :not_connected | :resolve_failed | Grappa.Admission.error() | {:start_failed, term()}}`, minus `:forbidden`.

#### W-S5. `AuthController.login/2` `@spec` omits `:nick_in_use`
**File:** `lib/grappa_web/controllers/auth_controller.ex:103-123` vs `:778-779`
**Category:** `@spec` drift
**Severity:** MEDIUM

`visitor_error_response(_, _, _, :nick_in_use)` returns `{:error, :nick_in_use}` on a 433 during visitor registration, but the union lists neither it nor anything covering it (`Grappa.Admission.error()` is `capacity_error() | Captcha.error()`, `lib/grappa/admission.ex:80-86`). The atom has a `FallbackController` clause (`:745`) and an `ErrorTokens` member — only the spec is out of step.

**Fix:** Add `| :nick_in_use`.

#### W-S6. `UploadsController.create/2` `@spec` says `{:error, atom()}` but the action returns tuples
**File:** `lib/grappa_web/controllers/uploads_controller.ex:166`
**Category:** `@spec` drift
**Severity:** MEDIUM

`check_per_file_cap/2:358` returns `{:error, {:file_too_large, cap}}` and `Uploads.create/3` can return `{:error, {:metadata_strip, _}}` — both tuple-tagged, both with dedicated `FallbackController` clauses (`:169`, `:182`). `atom()` admits neither.

**Fix:** `Plug.Conn.t() | {:error, atom() | {:file_too_large, pos_integer()} | {:metadata_strip, String.t()}}`.

#### W-S7. `AdminChannel.handle_info/2` has no catch-all, contradicting the module's own stated posture
**File:** `lib/grappa_web/channels/admin_channel.ex:77-97` (clauses), `:99-105` (the `handle_in/3` catch-all and its rationale)
**Category:** channel robustness / consistency
**Severity:** MEDIUM

Phoenix defines no default `handle_info/2`; `Phoenix.Channel.Server` dispatches whenever the channel exports it. `AdminChannel` does, so any message matching none of its three clauses (`:after_join`, `:overview_tick`, `%Broadcast{topic: "grappa:session_log", event: "event"}`) raises `FunctionClauseError` and kills the operator console's pid. Exhaustive today only by luck: `Grappa.PubSub.broadcast_event/2` hardcodes the event name (`lib/grappa/pubsub.ex:91`) and `lib/grappa/session_log.ex:294` is the only publisher on that topic. A second publisher, a different event name, or any stray `send/2` takes the console down — the exact failure the module's own comment at `:99-103` refuses to allow for `handle_in`. Note `GrappaChannel` documents the opposite choice at `:469-471`; the finding is that `AdminChannel` argues one posture and implements the other.

**Fix:** Add a logging catch-all returning `{:noreply, socket}`, or write the crash-on-purpose rationale into the moduledoc.

#### W-S8. `AdminChannel` pins two PubSub topics as string literals while `Grappa.PubSub.Topic` is the declared SSOT
**File:** `lib/grappa_web/channels/admin_channel.ex:59` and `:92` (vs the correct `Topic.session_log()` at `:65`)
**Category:** SSOT drift
**Severity:** MEDIUM

`join("grappa:admin:events", …)` and the `%Broadcast{topic: "grappa:session_log", …}` match are literals while the subscribe two lines below goes through `Topic.session_log/0`. Renaming either function would leave the join head unreachable and the re-push clause silently unmatched, with nothing failing to compile. (`user_socket.ex:103`'s `channel "grappa:admin:events"` genuinely needs a literal — macro argument — so it is not the same defect.)

**Fix:** `@admin_topic Topic.admin_events()` / `@session_log_topic Topic.session_log()` module attributes (compile-time, so still valid in a pattern).

### LOW

#### W-S9. `GrappaChannel` moduledoc still claims the socket hardcodes `user_name` as `"vjt"`
**File:** `lib/grappa_web/channels/grappa_channel.ex:171-174`
**Category:** stale documentation
**Severity:** LOW

`UserSocket.assign_subject/2` has derived `user_name` from the authenticated session since sub-task 2i (`user_socket.ex:403-450`), and `authorize/2:1824-1831` is load-bearing today. A reader trusting the paragraph concludes cross-user authz is inert.

**Fix:** Delete the paragraph.

#### W-S10. Tautological `if` in `Admin.UsersController.create_attrs/1`
**File:** `lib/grappa_web/controllers/admin/users_controller.ex:244`
**Category:** dead code
**Severity:** LOW

`if extra == [], do: {:error, :bad_request}, else: {:error, :bad_request}` — both branches identical, so the condition is dead. Leftover from a shape that presumably distinguished "unknown key" from "missing required field".

**Fix:** Collapse it, or split the two rejections into distinct tags if that was the intent.

#### W-S11. `ThemesController.render_theme/4` re-fetches a row it was just handed, under a strict match
**File:** `lib/grappa_web/controllers/themes_controller.ex:184-187`, callers at `:97`, `:107`, `:172-178`, `:159`
**Category:** redundant query / MatchError risk
**Severity:** LOW

`create/2`, `update/2`, `copy/2`, `publish/2`, `unpublish/2` all hold the `%Theme{}` already but pass only `theme.id`, and `render_theme/4` re-reads with `{:ok, theme} = Themes.get_theme(id)` — one extra query per theme write, and a strict match that becomes a `MatchError` → 500 (bypassing `FallbackController`) if the row is deleted in between.

**Fix:** Pass the struct through.

#### W-S12. Two collect-or-bail traversals use `Enum.reduce_while/3` where CLAUDE.md prescribes the recursive shape
**File:** `lib/grappa_web/controllers/networks_controller.ex:477-486`, `lib/grappa_web/controllers/admin/settings_controller.ex:144-156`
**Category:** codified convention
**Severity:** LOW

Both are pure collect-or-bail with no state carried across iterations (the settings one discards its accumulator entirely: `fn {k, v}, _ -> …`), which is exactly the case the rule names.

**Fix:** Rewrite as the documented three-clause recursion, or record in DESIGN_NOTES why these two are exceptions.

#### W-S13. Three sibling read endpoints disagree on what a malformed `?limit=` means
**File:** `messages_controller.ex:490-495` (400), `directory_controller.ex:106-114` (silently clamps to 100), `admin/session_log_controller.ex:418-425` (silently falls back to 200)
**Category:** consistency
**Severity:** LOW

`MessagesController`'s moduledoc argues the 400 explicitly ("forgiving the typo would mask client bugs"); the other two forgive it. A client author reading one door learns the wrong rule for the others.

**Fix:** Pick one posture for the REST surface and state it once — `GrappaWeb.Validation` is the natural home for a shared `parse_limit/2`.

#### W-S14. `NetworksJSON.index/1` `@doc` describes 3-tuples; the spec and the code use 4-tuples
**File:** `lib/grappa_web/controllers/networks_json.ex:28`
**Category:** documentation drift
**Severity:** LOW

"both are `{network, nick, credential}` triples" — the `@spec` below and both clauses destructure `{network, nick, cred, connection}`; `Session.connection_info() | nil` was added (#474 B) without updating the prose.

**Fix:** Say "4-tuples carrying the live connection info".

#### W-S15. `ReadCursorController.create/2` strict-matches the fire-and-forget task spawn
**File:** `lib/grappa_web/controllers/read_cursor_controller.ex:89-92`
**Category:** error handling
**Severity:** LOW

`{:ok, _} = Task.Supervisor.start_child(Grappa.TaskSupervisor, …)` on the request path of a hot write. `Grappa.TaskSupervisor` runs with `max_children: :infinity`, so it cannot fire today — but the comment sells the fan-out as "supervised fire-and-forget" and "eventually-consistent", and the strict match makes a future `max_children` a 500 on a cursor write that already committed.

**Fix:** `case`/`_ =` with a `Logger.warning` on `{:error, _}`.

#### W-S16. `MembersController.index/2` `@spec` is narrower than its own catch-all arm
**File:** `lib/grappa_web/controllers/members_controller.ex:42-52`
**Category:** `@spec` drift
**Severity:** LOW

The spec says `{:error, :no_session}`; the body's `{:error, _} = err -> err` propagates whatever `Session.list_members/3` returns, which per the boundary's typedoc includes `{:error, :timeout}` (the saturated-mailbox shape `GrappaChannel` handles at `:813-818`).

**Fix:** Widen to `{:error, :no_session | :timeout}`.
## Scope: cicchetto/

**Framing note from the agent, kept because it bounds the findings:** the wire types AND their runtime schemas are code-generated from the server typespecs and gated in CI (`scripts/check.sh:32`, `.github/workflows/ci.yml:78` run `mix grappa.gen_wire_types --check`), so hand-diffing the 29 `*wire.ex` modules against `wireTypes.ts` was deliberately skipped — that drift class cannot ship. `tsconfig.json` runs full `strict` + `noUncheckedIndexedAccess` + `noImplicitReturns`; there are zero `@ts-ignore` and zero non-test `as any` in the tree. The findings concentrate where machines are not watching: closure-captured reactive values, the hand-written residue at boundaries the codegen does not reach, ARIA, and CSS.

### HIGH

#### C-S1. Per-channel WS handlers capture `ownNick` by value and are never re-installed after a nick change
**File:** `cicchetto/src/lib/subscribe.ts:389` (signature), `:914`, `:979`, `:1031` (call sites), `:871`/`:937` (guarding effects)
**Category:** solid-reactivity / correctness
**Severity:** HIGH

`installChannelHandler(phx, slug, name, key, ownNick)` closes over `ownNick` as a SNAPSHOT taken when the topic was first joined, and every install loop is guarded by `if (joined.has(key)) continue;` — so once a channel topic is joined the handler is never rebuilt. `own_nick_changed` calls `mutateNetworkNick` (`userTopic.ts:1210`), which patches `networks()` and re-runs all four join effects, but the `joined` guard short-circuits every already-joined CHANNEL key. Only the DM listener recovers, and only because the new own nick produces a new `channelKey` — by accident of keying, not by design.

Three live consequences after any `/nick` or NickServ ghost recovery:

1. **The beep/title alert follows the OLD nick.** `routeMessage` calls `shouldNotify(message, slug, ownNick, …)` (`:360`); `pushTriggers.shouldNotify` uses it for both the `own_row` test (`pushTriggers.ts:82`) and the highlight match, while the server's push uses the live nick. A line mentioning the new nick pushes to the phone and stays silent in the tab; a line mentioning the retired nick does the reverse — the client/server divergence #868 exists to eliminate, reintroduced through a stale closure.
2. **Own-PART is no longer detected.** `const ownPart = message.kind === "part" && nickEquals(message.sender, ownNick)` (`:538`) is false, so `setParted(key)` never fires (the window-state entry lingers) AND the `joined.get(key)?.leave()` teardown at `:611` never runs — the #200 Channel/handler leak returns for any channel parted after a rename.
3. **Own presence events bump unread.** `isOwnPresenceEvent(message, ownNick)` (`:311`) stops matching our own JOIN/PART/MODE echoes, so they pass the gate that exists to stop the operator badging themselves.

Also at `:567`, our own SECOND nick change looks like a peer rename to the stale closure (`!nickEquals(message.sender, ownNick)` is true), which can drive `renameScrollbackKey` / `followQueryNick` on our own identity — cic originating a rename CLAUDE.md says it must not mirror.

DESIGN_NOTES was grepped for `installChannelHandler` / `ownNick` closure discussion; the only hit (`:40540`) is about ISUPPORT multiplicity and does not cover this.

**Fix:** Pass an ACCESSOR rather than a value — `installChannelHandler(phx, slug, name, key, () => ownNickForNetwork(net, u))` — and call it inside the handler body. Do NOT fix by rejoining on nick change: leaving and re-joining N channel topics on every `/nick` is heavier than the problem and would race the JOIN echo the way #200's revert did.

### MEDIUM

#### C-S2. `--muted` is ~4.0:1 on both shipped themes — below WCAG AA for the 140 places it paints text
**File:** `cicchetto/src/themes/default.css:355` (`irssi-dark --muted: #707070`), `:393` (`mirc-light --muted: #7f7f7f`), representative use `:2940`
**Category:** a11y / contrast
**Severity:** MEDIUM

Computed: `#707070` on `#0a0a0a` = **4.00:1**; `#7f7f7f` on `#ffffff` = **4.01:1**. AA requires 4.5:1 below 18.66px bold / 24px regular. `--muted` is referenced **140 times** and is the standard secondary-text token — scrollback timestamps at the 14px root, modal close glyphs, form hints, empty-state copy, upload filenames. None reach the large-text exemption. Both themes land at the same ratio, which suggests the value was picked by eye; there is no WCAG/contrast entry anywhere in DESIGN_NOTES.

**Fix:** Raise both tokens past 4.5:1 — `#7d7d7d` on `#0a0a0a` gives 4.6:1, `#767676` on `#ffffff` gives 4.54:1. One token edit per theme, no per-site churn. The nick palettes were already picked against a stated ratio (`:365` "~6:1+", `:402` "~5:1+"); `--muted` is the one colour token with no such statement.

#### C-S3. `#c00` on the delete-account / confirm surfaces: ~3.4:1 on the dark theme, and blind to custom themes
**File:** `cicchetto/src/themes/default.css:4371-4372`, `:4419`, `:4435`, `:4452`, `:4457-4459`, `:4524-4526`
**Category:** a11y / theming
**Severity:** MEDIUM

`#c00` on `#0a0a0a` is **3.36:1** — below AA for the 0.85rem body copy it paints (`.delete-account-warning:4452`, `.delete-account-error:4435`). It is also a literal, so `lib/customTheme.ts`'s inline `--bg`/`--fg` cannot move it: the gallery layers user vars over these blocks and this red silently wins — the exact failure the `--adm-*` header at `:266-274` was written to end. These are the highest-consequence confirmations in the app. The FILLED variants (`:4457-4459`, `:4524-4526`) are fine (`#fff` on `#c00` = 5.9:1); the outlined/`color`-only ones fail.

**Fix:** Point all six at `var(--adm-danger)` / `var(--adm-danger-bg)` (already at `:303-304`, theme-derived). If the drawer/modal surfaces should not depend on the admin namespace, promote the pair to `--danger` / `--danger-bg` and alias `--adm-danger` to it.

#### C-S4. The `--adm-*` migration is half-done: `#c00` / `#c80` / `#0a0` survive on six admin controls the token block claims to have replaced
**File:** `cicchetto/src/themes/default.css:4920-4921`, `:4990-4991`, `:4995-4996`, `:5041`, `:5063-5064`, `:5068-5069`
**Category:** css / theming, half-migration
**Severity:** MEDIUM

The token header at `:272-274` states outright that it "replaces the hardcoded `#c00` / `#0a0` / `#c80` that used to live in the admin CSS block below and broke under `mirc-light`", and the tombstone at `:5055-5064` repeats it. The literals are still there on live controls: `.delete-btn.confirming` `#c00` (`:4920`), `.disconnect-btn.confirming` `#c80` (`:4990`), `.terminate-btn.confirming` `#c00` (`:4995`), `.introspection-degraded-warning` `#c80` (`:5041`), `.reset-circuit-btn.confirming` `#c80` (`:5063`), `.force-reap-btn.confirming` `#c80` (`:5068`) — all emitted dynamically via `InlineConfirmButton`'s `extraClass={`${kind}-btn`}` (`AdminSessionsTab.tsx:556`).

Worse, the escape is patched PER INSTANCE: `:5036-5042` re-declares `.adm-table .delete-btn` / `.adm-table .terminate-btn` with `var(--adm-danger)` at equal (0,2,0) specificity, so the token wins only INSIDE `.adm-table` — the same button outside a table, or in the `.confirming` state that actually shows the red, still resolves to the literal. Textbook "per-instance override re-declaring the same escape from a shared base", against CLAUDE.md's "total consistency or nothing".

**Fix:** Replace the six literal pairs with `var(--adm-danger)` / `var(--adm-warn)` and delete the two per-instance overrides at `:5036-5042`, which become redundant once the base uses tokens.

#### C-S5. `role="tablist"` in the mobile window switcher with no `aria-selected` on any tab
**File:** `cicchetto/src/BottomBar.tsx:137` (tablist), `:149`, `:181`, `:222` (tabs)
**Category:** a11y
**Severity:** MEDIUM

All three `role="tab"` buttons carry selected state only through `classList={{ selected: … }}`. `aria-selected` is a REQUIRED attribute of `role="tab"`; without it a screen-reader user gets a list of tabs with no indication of which window is open — on the primary mobile navigation surface. Not a missing convention but an internal inconsistency: `admin/AdminNav.tsx:65` renders `role="tab"` with `aria-selected={props.current === tab.key}`. Secondary: the `<CloseButton>` rendered as a sibling of each tab (`:194`, `:230`) is a non-tab child of a `tablist`, violating the role's required-owned-elements rule.

**Fix:** Add `aria-selected={isSelected(...)}` to all three tabs (the predicate already exists for `classList`). For the close buttons, either wrap each tab+close pair in a `role="presentation"` container or drop `tablist`/`tab` for `role="navigation"` + `aria-current="page"` — which describes this widget more honestly, since there are no `tabpanel`s here.

#### C-S6. Deploy-skew tolerance for `old_nick` is implemented on the WS door and not on the REST door — the merged list renders `was undefined`
**File:** `cicchetto/src/AdminSessionLogTab.tsx:224`, with `cicchetto/src/lib/api.ts:1902` vs `cicchetto/src/lib/wireNarrow.ts:650-653`
**Category:** wire-boundary / correctness
**Severity:** MEDIUM

`narrowSessionLogEntry` carries an explicit, well-argued defence (`wireNarrow.ts:640-649`): `old_nick` is required server-side but was added after the shape shipped, and cic deploys independently (`deploy-m42.sh --cic`), so a cic ahead of its server must default the field to `null` rather than drop every row. `adminListSessionLog` (`api.ts:1902`) fetches the SAME rows over REST with a bare `as SessionLogWireListResult` and no such default. `AdminSessionLogTab` merges both sources into one list (`sessionLog.ts:26-28`) and renders `ev.old_nick !== null ? \`was ${ev.old_nick}\` : ""`. Against an older server the REST rows arrive `undefined`, `undefined !== null` is true, and the row renders the literal string `was undefined` while the WS rows in the same list render correctly.

**Fix:** Apply the same default in `adminListSessionLog` / `adminListSessionLogSessions` (`api.ts:1902`, `:1923`), or change the render predicate to a truthiness test. General rule worth extracting: a nullable-field tolerance is a property of the FIELD, not of the transport, so it belongs next to the type, not next to one reader.

#### C-S7. `narrowModesEntry` accepts any `params` value while the generated schema validates them
**File:** `cicchetto/src/lib/wireNarrow.ts:140-151`
**Category:** typescript-strictness / wire-boundary
**Severity:** MEDIUM

`modes` elements are checked; `params` VALUES are not — the object is asserted whole (`r.params as Record<string, string | null>`). The generated schema for the same server type is stricter: `S_SessionWireChannelModesWire = { o: { modes: {a:"s"}, params: { r: { u: ["s","z"] } } } }` (`wireSchema.ts:915-917`). The hand-written arm is weaker than the machine-written one beside it, and a non-string mode parameter (a key limit arriving as a JSON number) flows into `ModesEntry.params` typed as `string | null` and reaches the `/mode` modal.

**Fix:** Route the arm through `validate(S_SessionWireChannelModesWire, …)` the way `narrowAdminOverview` and `narrowAdminEvent` already do — exactly the mechanical part #429 set out to delete, and one of the arms it did not reach.

#### C-S8. Two tap targets below the file's own declared 44px floor, one of them the primary mobile navigation
**File:** `cicchetto/src/themes/default.css:7632` (`.bottom-bar`), `:3489-3490` (`.audio-mini-player-*`), `:7849` (`.bottom-bar-close`)
**Category:** a11y / iOS tap targets
**Severity:** MEDIUM

`html, body { font-size: var(--font-size) }` (`:477-484`) sets the ROOT to 14px, so `1rem = 14px`. The file knows this and says so at `:186` and `:193` — which is why `--tap-min: 44px` and `--chrome-tap-min: 48px` are declared in absolute px. Three rules ignore it: `.bottom-bar { min-height: 3rem }` = **42px**, with an inline comment claiming "thumb-tap friendly (~48dp Material / 44px Apple HIG)" — and `:7830-7836` establishes that every tab's hit area IS the bar height (`align-items: stretch`), so the whole mobile window switcher is a 42px strip; `.audio-mini-player-toggle/-close/-download { min-width/min-height: 2.5rem }` = **35px** transport controls; `.bottom-bar-close { min-width: 32px }` = the per-tab close ×, 32×42px. Explicitly EXCLUDED: `.names-modal-nick { min-height: 28px }` (`:8144`) is recorded at `:8135-8138` as a deliberate density call by vjt under #143.

**Fix:** `.bottom-bar` → `min-height: var(--tap-min)` and delete the now-true-by-construction comment; `.audio-mini-player-*` → `var(--tap-min)`; `.bottom-bar-close` → `min-width: var(--tap-min)`. Using the token rather than a fresh literal is what stops the next `Nrem` from re-deriving the same 2px error.

### LOW

#### C-S9. ~40 lines of dead CSS — selectors matching no markup, static or dynamic
**File:** `cicchetto/src/themes/default.css:4185`, `:4192`, `:4196`, `:4201`, `:4209`, `:4213`, `:4850`, `:4871`, `:4880`, `:4889`, `:4896`, `:5041`, `:6134`, `:6195`, `:6253`, `:6946`, `:7748`
**Category:** css / dead code
**Severity:** LOW

Every rule head (1128) was cross-referenced against all 587 TS/TSX sources and each miss hand-checked for template construction (`` `adm-badge--${tone}` ``, `` `${kind}-btn` ``, `` `event-${ev.event}` ``, `` `toast-${tone}` ``, `` `who-modal-flag-tag-${chip.cssMod}` ``, `` `next-active-btn-${variant}` `` — all live, correctly excluded). What remains matches nothing: the `.settings-diag-*` family, the `.admin-visitor*` family, `.introspection-degraded-warning`, `.adm-table-truncate`, `.adm-log-kind`, and `.bottom-bar-tab.bottom-bar-tab-invited`. The last is DOCUMENTED dead — `BottomBar.tsx:203-210` records that #902 removed the invited row, and the CSS comment at `:7739-7744` still describes the removed markup as present. This file is generally excellent at leaving tombstones (`:4353`, `:4915`, `:4993`, `:5000`, `:5057`); these outlived their markup without getting one.

**Fix:** Delete. Where a rule is kept as a test hook, say so the way `:4915-4922` does.

#### C-S10. `.media-viewer-spinner` is the only infinite animation with no `prefers-reduced-motion` escape
**File:** `cicchetto/src/themes/default.css:12160`
**Category:** a11y / motion
**Severity:** LOW

Six `@media (prefers-reduced-motion: reduce)` blocks (`:1203`, `:5866`, `:8591`, `:9602`, `:10877`, `:11166`) cover 21 of the 22 `animation:` declarations — including both sibling spinners, `.login-spinner` and `.compose-send-spinner`, in the same block at `:1203-1209`. `.media-viewer-spinner` (`animation: media-viewer-spin 0.8s linear infinite`) is the omission, and it renders over video content where a persistent rotation is most likely to bother a motion-sensitive user.

**Fix:** Add it to the `:1203` block alongside the two spinners it is a copy of.

#### C-S11. `.peer-away-banner-close` re-declared with three declarations that never apply
**File:** `cicchetto/src/themes/default.css:10178` vs `:10503`
**Category:** css
**Severity:** LOW

`:10178` sets `font-size: 1rem` and `padding: 0 0.3rem`; the shared close-button base at `:10503` (grouped with `.whois-card-close`, `.whowas-card-close`, `.lusers-card-close`) later sets `font-size: 1.5rem` and `padding: 0` at equal specificity, so the earlier pair is dead. Only `margin-left: auto` and the colour survive — which `:10499` even documents.

**Fix:** Strip the two overridden declarations. Minor, but this is how a shared base quietly stops being the source of truth.

#### C-S12. `narrowAdminOverview`'s doc comment mis-states the server type it defends
**File:** `cicchetto/src/lib/wireNarrow.ts:625`
**Category:** docs
**Severity:** LOW

The comment reads "the typespec already says `integer() | nil`"; `Grappa.AdminOverview.Wire` declares `loadavg: float() | nil`. No behavioural bug — `gen_wire_types.ex:1028` deliberately maps `:float` to the `"i"` node and `wireValidate.ts:147` implements `"i"` as `typeof raw === "number"`, so `0.52` validates — but the comment is the only place a reader learns WHY the schema is right, and it names the wrong type. The `"i"` mnemonic reading as "integer" is what makes the sentence plausible.

**Fix:** Correct the comment to `float() | nil`, and add a one-line note on `WireNode`'s `"i"` in `wireValidate.ts:47` that it means "JSON number", not integer.

#### C-S13. `swatchColors` asserts unvalidated payload values as strings
**File:** `cicchetto/src/lib/themeGallery.ts:33`
**Category:** typescript-strictness
**Severity:** LOW

`const colors = payload.colors as Record<string, string | undefined>` then `SWATCH_KEYS.map((k) => colors[k] ?? "transparent")`. `ThemesWireT.payload` is `Record<string, unknown>` (server `map()` → pass-through node, `wireSchema.ts:1372`), so `colors` is genuinely unknown-shaped. The `??` fallback rescues MISSING keys but not WRONG-TYPED ones: a numeric or object value passes through typed as `string` and the `string[]` contract is a lie. The comment above claims "a server-sanitized payload always carries every key" — which addresses presence, not type.

**Fix:** `.map((k) => (typeof colors[k] === "string" ? colors[k] : "transparent"))`.

#### C-S14. `biome.json` `$schema` pinned one patch behind the installed Biome
**File:** `cicchetto/biome.json:2` vs `cicchetto/package.json`
**Category:** tooling
**Severity:** LOW

`schemas/2.5.6/schema.json` while `@biomejs/biome` is pinned exactly at `2.5.7`. Harmless today, but the schema is what gives editors completion and validation for this config, so a drifted pin quietly stops describing the tool that runs.

**Fix:** Bump with the dependency; `biome migrate` does both.

#### C-S15. The DM-listener Channel for a retired own nick is never left
**File:** `cicchetto/src/lib/subscribe.ts:1093-1105`
**Category:** resource leak
**Severity:** LOW

On `own_nick_changed` the DM-listener effect re-runs, computes a NEW `channelKey(net.slug, newNick)`, misses the `joined` guard, and joins the new topic. The old own-nick entry stays in `joined` forever with a live `phx.on("event")` handler — the same class the `joined`-Map-of-Channels design at `:136-142` was introduced to fix, on the one axis (nick rotation, not token rotation) it does not cover. Bounded by the number of nick changes in a session; on an always-on bouncer client that is not much of a bound.

**Fix:** In the DM-listener effect, leave and delete any `joined` entry for this network whose name is not the current own nick before joining the new key. Falls out naturally from C-S1 if "which nick does this network's DM listener speak for" moves into a small per-network record instead of being encoded in the key.

### Notes the agent recorded as CHECKED AND DELIBERATELY NOT FLAGGED
The `maximum-scale=1, user-scalable=no` viewport lock (`index.html:7`) is DESIGN_NOTES:2781 iOS-1 with the media-viewer pinch-zoom carve-out at `:10246` (#213); `.names-modal-nick`'s 28px row (#143, vjt); the REST-trusts-the-server posture in `api.ts`; the `"i"`-means-number schema node; and `linkify`'s scheme allowlist (`linkify.ts:205`), checked specifically and correct.

**Skill-file correction:** `cicchetto/public/{manifest.json,sw.js}` — listed in the review skill's scope — DO NOT EXIST and have not for some time. The manifest is generated by `VitePWA` from the inline `manifest:` block in `vite.config.ts:130-180` (`id`, `start_url`, `display`, `theme_color`, `background_color`, icons via the shared `PWA_ICONS` SSOT, and the #1103 `share_target` all present and correct) and the service worker is compiled from `src/service-worker.ts` in `injectManifest` mode. `index.html` correctly carries NO hand-written manifest link — the plugin injects it.
## Scope: cross-module (server-wide pattern sweep)

Four of the eight swept axes came back **clean**, with the commands recorded in COVERAGE below — that is a result, not filler.

### HIGH

#### M-S1. Zero mechanical enforcement of the migration-version rule CLAUDE.md marks 🔴
**File:** `priv/repo/migrations/` (86 files); no gate in `scripts/`, `test/` or `.github/` · **Severity:** HIGH

Measured: duplicate versions today **0**; hand-typed round stamps **40 of 86** (46.5%) — the run from `20260717120000` to `20260811130000` is 24 consecutive files, every one round-typed, and only the last two on main are generator output. `grep -rn 'gen.migration\|duplicate.*version' scripts/ test/ .github/` → no matches. `Preflight.contract_migrations/2` (`lib/grappa/deploy/preflight.ex:480`) filters CHANGED GIT PATHS, not versions vs `schema_migrations`, so it cannot see the silent regime either; `HotReload.pending_migration_files/1` (`hot_reload.ex:170`) would die on `[path] = Path.wildcard(...)`, but only on the hot path and only while the version is still pending. The rule is obeyed by convention only, and the next hand-typed stamp reintroduces the hazard with no signal.
**Fix:** A ~10-line `async: true` test asserting `versions == Enum.uniq(versions)` over the parsed filenames. Optionally `refute String.ends_with?(version, "0000")` for newly added files only (the 40 historical ones need an allowlist, or gate uniqueness alone).

#### M-S2. `Session.Server` subscribes to two PubSub topics and has no catch-all `handle_info/2`
**File:** `lib/grappa/session/server.ex:1383`, `:1392` (subscribes), `:3734` (last clause); second instance `lib/grappa_web/session_revocation_listener.ex:39`, `:44` · **Severity:** HIGH

Measured: 40 `handle_info` clauses, **0 catch-all**. It subscribes to `Topic.ws_presence(subject_label)` and `Topic.user_settings(subject_label)` — the latter described in-file as "the settings bridge", a surface expected to grow. Every payload is matched today, but CLAUDE.md's additive-only contract says new event types may appear at ANY time: the moment `Grappa.UserSettings` broadcasts a second tuple, every `Session.Server` for that subject takes a `FunctionClauseError`, the supervisor restarts it, and the user's IRC connection drops — caused by an unrelated context, with no compile error and no test coupling. Its sibling already has the fix: `lib/grappa/irc/client.ex:1219-1222` ends with a catch-all logging `unexpected: inspect(msg)`, and `:unexpected` is already in the Logger allowlist. The LOWER-stakes process is protected; the higher-stakes one is not. `SessionRevocationListener` has exactly one clause and no catch-all, and it is the process that turns bearer death into WS teardown.
**Fix:** Copy the `IRC.Client` catch-all verbatim into both. This is not widening a catch to swallow more — it is loud, it logs, and it protects a supervised process from an additive change made elsewhere.

### MEDIUM

#### M-S3. `Uploads.Reaper` schedules the next tick AFTER the sweep — the one that does, and the slowest
**File:** `lib/grappa/uploads/reaper.ex:171-182` vs `lib/grappa/visitors/reaper.ex:189-198` and `lib/grappa/accounts/reaper.ex:108-112` · **Severity:** MEDIUM
Two of three schedule before the sweep and both say so deliberately — `visitors` cites REV-J M9 ("interval-fixed, not `interval + sweep_duration`"), `accounts` says "keeping the shape identical across the three reapers avoids surprise", which is factually wrong about the set. It matters most here: `Uploads.Reaper.sweep/2` (`:89-115`) iterates EVERY expired upload doing per-row `File.rm/1` + soft-delete + `AdminEvents.record/1`, unbounded, while the other two are bulk queries. Under backlog the cadence silently degrades.
**Fix:** Move `schedule_tick/1` to the first statement of `handle_info(:tick, …)`. Deeper: the three modules differ only in sweep body, interval field and log line — a shared `Grappa.PeriodicSweeper` collapses 535 lines to one scaffold plus three bodies. (Same finding as the consistency agent's C-S3.)

#### M-S4. 14 Logger call sites interpolate a `key=value` pair whose key is already allowlisted
**File:** representative `lib/grappa/operator.ex:734`; 14 sites · **Severity:** MEDIUM
Measured across all 207 `Logger.*` calls with a balanced-paren scan against the 106-key allowlist (`config/config.exs:326-633`): 44 interpolate, 24 pass no metadata at all, **14** interpolate an allowlisted key — `operator.ex:542/581/590/638/734/829` (6, none with any metadata), `networks.ex:929`, `visitors/login.ex:596`, `session/server.ex:3439/3446/3415/3489`, `session.ex:466/533`. The right shape is one directory over: `visitors/reaper.ex:110` does `Logger.error("reaper delete failed", visitor_id: v.id, error: inspect(reason))` while its sibling `visitors/login.ex:596` interpolates the same identifiers into prose. Why it matters: `format: "$time $metadata[$level] $message\n"` makes an allowlisted key greppable across every line carrying it; a value baked into prose is not, so an operator grepping `network_id=` gets an arbitrary subset.
**Fix:** Move the k=v pairs into the metadata kwlist — mechanical for all 14. Interpolated counts and durations are fine and are not in this set.

#### M-S5. `Repo.insert_all/2` bypasses the `Entry` changeset for upstream-supplied `/LIST` data
**File:** `lib/grappa/channel_directory.ex:106` · **Severity:** MEDIUM
`ingest/3` hand-builds row maps and calls `Repo.insert_all(Entry, entries)`. `name` and `topic` come straight off the wire (`Session.Server.parse_list_entry/1`, `server.ex:6600-6608`, passes the 322 params through untouched); only `user_count` is sanitised. Bypassing `Entry.changeset/2` skips exactly the guards the schema moduledoc advertises (`channel_directory/entry.ex:18-21`): the schema-level `validate_subject_xor/1` and the `check_constraint/3` that turns DB violations into changeset errors — so an XOR violation surfaces as a raw `Exqlite.Error` from a `Session.Server` callback. There are exactly two `insert_all` sites in `lib/`; the other (`accounts/recovery_codes.ex:84`) inserts server-generated values and is fine.
**Fix:** Run the batch through `Entry.changeset/2` and insert the validated changes, or accept the per-row cost in a transaction (batch is 200, cadence is one `/LIST`). At minimum apply the XOR + length validation before the bulk write.

#### M-S6. `rescue _` + `catch _, _` belt-and-braces around a network call, with no log
**File:** `lib/grappa/themes/image_fetcher/req.ex:82-88`; second instance `lib/grappa/version/git_probe.ex:148-157` · **Severity:** MEDIUM
The only two bare `catch _, _` clauses in `lib/` (of 5 total; the other 3 are precisely typed on `:exit` reasons). The in-file comment says the no-raise contract is "belt-and-braces here" — verbatim the pattern CLAUDE.md names: "a safety net that catches an impossible exception silently absorbs the next class of bug." `catch _, _` also swallows `:exit` and `:throw`, including an exit propagated from a linked process, and nothing is logged: a genuine defect in `connect_options/1` presents to the user forever as "fetch failed" with zero operator signal, while the sibling funnel at `uploads/metadata_strip.ex:283` is documented as "the operator MUST see every rejected upload".
**Fix:** Narrow to the reachable exception classes and `Logger.warning` before returning the token. For `git_probe`, drop the `catch` and keep `rescue ErlangError` (the `:enoent` case is real).

#### M-S7. Six destructive test-only functions ungated on production context modules while a seventh module gates its equivalents
**File:** `lib/grappa/notify.ex:283`, `query_windows.ex:386`, `read_cursor.ex:582`, `user_settings.ex:426`, `uploads.ex:388`, `push.ex:298` vs `lib/grappa/ws_presence.ex:422`, `:441`, `:462` · **Severity:** MEDIUM
`WSPresence` gates every test-only function behind `if Mix.env() in [:dev, :test]` with an `else` that raises in prod, three times. Six sibling contexts expose the same class — a per-subject `delete_all`/`clear_all`, each `@doc`'d as "intended for `Grappa.TestSupport.SubjectReset` only" — with no gate. **Reachability, stated honestly: not remotely reachable in production** (`TestSupport.*` is compile-gated, the routes are compile-gated, `grappa_web.ex:72` adds them to Boundary deps conditionally). So this is consistency, not exposure — but it is the two-patterns case, and the next author copies whichever is closer.
**Fix:** Apply the `WSPresence` shape to the six; it is already written three times.

#### M-S8. Elixir Unicode `String.downcase/1` on the needle vs SQLite ASCII `lower()` on the haystack in directory search
**File:** `lib/grappa/channel_directory.ex:197` and `:202` · **Severity:** MEDIUM
`like = "%#{String.downcase(q)}%"` compared against `like(fragment("lower(?)", e.name), ^like)`. `String.downcase/1` is full Unicode; stock SQLite's `lower()` (no ICU) folds ASCII only. Searching `CAFÉ` builds `%café%` while the stored `#CAFÉ` lowers to `#cafÉ` — no match, for a channel that plainly matches; any non-ASCII uppercase letter in a query silently returns nothing. The team knows the general hazard: `channel_directory/wire.ex:41`, the SIBLING module in the same context, carries "a bare `String.downcase` would Unicode-over-fold non-ASCII (#364/#525)". Contrast `accounts.ex:311`, which keeps both sides in SQL and is symmetric.
**Fix:** Move the needle into SQL (`fragment("lower(?)", ^q)`, the `accounts.ex` shape) or fold it with `Identifier.canonical_target/1` / `fold_ascii/1`, the byte-pinned SSOT.

#### M-S9. Web-layer tests write directly into `Session.Server`'s private state map
**File:** `test/grappa_web/controllers/channels_controller_test.exs:691-693`; 51 `:sys.replace_state` calls across 12 files · **Severity:** MEDIUM
Measured: `:sys.get_state` 72, `:sys.replace_state` 51 (29 in `server_test.exs`, 5 here, 4 in `admin_events_test.exs`, 3 in `grappa_channel_test.exs`). Most of the `server_test.exs` uses seed a precondition through a PRODUCTION helper — defensible. `inject_members/2` is not: a WEB CONTROLLER test hand-constructs `Session.Server`'s private `:members` representation, so (a) a change to that representation breaks controller tests for an unrelated reason and (b) the test can build a members map production can never produce. CLAUDE.md names `Grappa.IRCServer` as the seam, and the same file already drives it.
**Fix:** Seed members by having the fake `IRCServer` emit the 353/366 NAMES pair — which also exercises `members_seeded`, currently skipped entirely.

#### M-S10. Four PubSub topic literals in executable code outside `Grappa.PubSub.Topic`
**File:** `lib/grappa_web/channels/user_socket.ex:102-103`; `lib/grappa_web/channels/admin_channel.ex:59`, `:92` · **Severity:** MEDIUM
11 `"grappa:` hits in `lib/`, of which 4 are executable. `test/grappa/pubsub/topic_test.exs:112` pins `Topic.admin_events()`, so a rename breaks THAT test — but nothing links these four literals to the SSOT, and the natural two-file edit (SSOT + pin) leaves all four silently stale: the channel route stops matching, the join clause stops firing, no compile error. (Overlaps W-S8 from the web agent.)
**Fix:** Module attributes resolved at compile time (`@topic Topic.admin_events()`) are usable in a head. The wildcard at `user_socket.ex:102` genuinely needs a literal — pin it instead by asserting `Topic.user("x")` starts with the routed prefix.

#### M-S11. 23 `async: false` server test files with no stated reason
**File:** representative `test/grappa/scrollback/wire_test.exs`; 23 files · **Severity:** MEDIUM
315 test files: **183 `async: true`, 138 `async: false`, 0 implicit** — the explicit-posture discipline is total. Most `async: false` are justified in-file (sqlite write contention under `max_cases:2`, process-global `Logger.metadata`). Scanning every one for any explanatory keyword leaves 23 with nothing; the four `grappa/migrations/*` ones are structurally required and just need the note. `scrollback/wire_test.exs` is the most suspicious — `Scrollback.Wire` is a pure struct→map converter and the file asserts only wire shape, so it looks like it inherited `async: false` from `scrollback_test.exs` by proximity.
**Fix:** One comment line per file, or flip to `async: true` where no reason exists. Cheapest first pass: `scrollback/wire_test.exs`, `push/sender_test.exs`, `net/source_alias_test.exs`.

### LOW

#### M-S12. A test substitutes source-text greps for the behavioural assertion, and says so
**File:** `test/grappa/session/server_test.exs:11989-11996` · **Severity:** LOW
`assert source =~ "event-router reply dropped"` and `refute Regex.match?(~r/:ok = .*\.send_/, source)`. A source pin is not a witness of the guard: the first passes if the string appears in a COMMENT and breaks on a log reword that changes no behaviour. Six test files read source; three are legitimate drift-detectors complementing behavioural tests (`version_single_source_test.exs:59-61` is the #652 guard CLAUDE.md mandates, `release_cli_install_test.exs:75`, `remote_ip_from_proxy_test.exs:300-303`). This is the only one REPLACING a behavioural test.
**Fix:** The file already exercises the identical helper via the AWAY tests; extend one to assert the log line with `ExUnit.CaptureLog` and drop the grep.

#### M-S13. `Enum.reduce_while/3` used for pure collect-or-bail
**File:** `lib/grappa_web/controllers/networks_controller.ex:477-486` · **Severity:** LOW
1 of 5 `reduce_while` sites in `lib/` is the banned shape; the other four (`admin/settings_controller.ex:150`, `push/badge_count.ex:155`, `session/server.ex:6848`, `:6869`) are genuine fold-with-early-exit and correct. Good ratio; flagged for completeness. (Overlaps W-S12.)
**Fix:** The three-clause recursive form, or — simpler here, the list being a fixed 3-tuple — a `with` over three `Map.fetch/2`.

#### M-S14. `length/1` on the accumulating buffer where the count is already in state
**File:** `lib/grappa/session/server.ex:6625-6633` · **Severity:** LOW
`if length(appended.buffer) >= state.directory_ingest_batch` runs on every 322 row; with `ingest_batch: 200` that is ~20,100 list-cell traversals per flushed batch. The state already carries `count` on the line above and the buffer resets at each flush, so `rem(appended.count, batch) == 0` is exactly equivalent. CLAUDE.md's "don't duplicate state that already exists — derive it" applies literally.
**Fix:** `rem(appended.count, state.directory_ingest_batch) == 0`.

#### M-S15. Two `*Wire` functions take `t()` and return bare `map()`
**File:** `lib/grappa/networks/credentials/admin_wire.ex:250`, `:273` · **Severity:** LOW
The only two specs in any of the 29 `*wire*.ex` modules returning bare `map()`. The moduledoc at `:266-272` gives a real reason not to name a PUBLIC type (codegen publishes every public `@type` in a `*Wire` module to `wireTypes.ts`, so naming one ships cic a type for a payload the wire never carries) — that covers the ARGUMENT, not the return.
**Fix:** A `@typep with_action :: %{...}` — private, so codegen cannot pick it up — gives Dialyzer the return shape at zero wire cost. Confirm `gen_wire_types` reads only public types first.

#### M-S16. `Session.Server` state carries 87 fields, six an identical `nil | map()` per numeric verb
**File:** `lib/grappa/session/server.ex` (7,230 lines; `@type t` at `:855`ff) · **Severity:** LOW *(trajectory, not action this cycle)*
124 `def` / 219 `defp`, 66 `handle_call`, 40 `handle_info`, 87 state fields; next largest module is `event_router.ex` at 4,401, and this one file is 39% of the 18,321-line `session/` tree. Two clusters are mechanically collapsible: six byte-identical `nil | map()` singleton-numeric fields (`lusers_pending`, `links_pending`, `info_pending`, `version_pending`, `motd_pending`, `admin_pending`) → one `singleton_pending :: %{verb => map()}`; and eight nullable injected-function fields. Credit where due: the DI nil-handling is honest — `rotate_stored_password/2` (`:4464-4468`) guards with `is_function/2` and returns `{{:error, :no_committer}, []}` rather than silently skipping the write.
**Fix:** The six-field collapse is self-contained. A split of numeric-response accumulation out of `Session.Server` is a design conversation, not a review item.

### Axes swept CLEAN, with the commands
- **`\\` default args:** `grep -rn -F ' \\ ' lib --include='*.ex'` → 11 hits, **all inside docstrings** (casemapping prose). **Zero real default arguments in `lib/`.**
- **`Application.*_env`:** 106 hits → 34 call sites, every one in `config/`, `application.ex start/2`, a `boot/0` `:persistent_term` seam (each read individually), or a mix task before `ensure_all_started`. One documented exception noted, not flagged: `lib/grappa_web/endpoint.ex:282-294` lazily inits from `fetch_env!` into `:persistent_term` on first request; the moduledoc declares it the boundary site.
- **`String.to_atom`:** 4 hits, 3 in comments; the one code site (`hot_reload.ex:199`) converts beam filenames from the app's own ebin, where `to_existing_atom` would be WRONG (a newly deployed module has no existing atom). Also checked `binary_to_atom`, `List.to_atom`, `Module.concat`, `binary_to_term`.
- **Boundary:** 105 `use Boundary`, **0 of 48 context roots missing an annotation**, no escape hatches (`check: false`, `dep_transitions`, `classify_to` → 0), and `lib/grappa/**` references `GrappaWeb.` only from `application.ex`. `mix.exs:33` puts `:boundary` in `compilers` and `ci.check` runs `--warnings-as-errors` first, so this axis is closed by tooling.
- **`@spec` coverage:** 1,439 public fn/arity pairs; the 62 apparent misses are multi-line-spec parser artifacts (two sampled, both false positives). Effectively 100%.
- **Migration idempotency:** `create_if_not_exists` in 3 files — two only MENTION it in comments explaining why they use plain `create`; the one real use (`20260725120000`) is justified in a 20-line moduledoc.
- **PubSub raw broadcasts:** only 3 `Phoenix.PubSub.broadcast/3` sites, all on server↔server topics with no Channel fastlane subscriber, all sending raw tuples — correct, and `user_settings.ex:735-737` documents why. The JSON-encodability invariant holds.
- **Hygiene:** **0** `IO.inspect`/`dbg(`, **0** TODO/FIXME/XXX in 88k lines. 3 `Process.sleep` sites, all justified.
## Scope: docker / infra

Agent's framing: the substrate is unusually well-engineered — `infra/lib/` genuinely collapsed three deploy scripts into one algorithm, 30 bats suites cover the deploy decision logic, and `Preflight`'s path classification is thorough and per-substrate. The findings cluster in ONE place: **hand-maintained lists that the docs describe as authoritative and that no gate holds to that claim.** The project already articulated the rule for itself in `scripts/shellcheck.sh` ("a hand list is not a gate — it is a snapshot"); four more hand lists have since accumulated.

### HIGH

#### D-S1. `LongLivedModules` enumerates 9 of the supervised stateful set — 4 measured omissions, nothing gates the list
**File:** `lib/grappa/hot_reload/long_lived_modules.ex:92`
**Severity:** HIGH · **Category:** deploy-preflight correctness / hand-list drift

`Preflight` reads `LongLivedModules.all/0` to decide whether a state-shape change forces COLD, and the moduledoc says "CLAUDE.md cites this module by name as the authoritative enumeration so the script and the docs cannot drift." Measured against `application.ex`, four supervised children carrying exactly the state shapes the extractor reads are absent: `Grappa.Accounts.Reaper` (`accounts/reaper.ex:64`, `defstruct [:interval_ms]`), `Grappa.DbLatency` (`db_latency.ex:123`), `Grappa.SessionLog` (`session_log.ex:82`), `Grappa.Net.PtrCache` (`net/ptr_cache.ex:142`, bare 6-field `init/1` map). `Accounts.Reaper` is the sharpest: direct sibling of `Visitors.Reaper` (`application.ex:383`) and `Uploads.Reaper` (`:396`), both listed, same `interval_ms` struct — not the moduledoc's "judgement call" escape clause, which only covers pure-ETS `{:ok, %{}}` modules.

Consequence: a `defstruct` field-add to any of the four classifies HOT on `:jail`. The moduledoc's own words — "silent crash, deferred to the next message" — then apply, and `deploy_common.sh`'s reload-honesty check cannot see it because `:code.load_file/1` returns `{:module, _}` happily. Blast radius smaller than `Session.Server` (a `:permanent` child crashes and self-heals, at the cost of accumulated telemetry and a crash-loop risk against `max_restarts`), but it is the class the preflight exists to refuse. Root cause: `test/grappa/application_supervision_tree_test.exs:33` pins every supervised child against the CLAUDE.md tree, so a new GenServer IS caught by one gate and silently skipped by this one; `grep -rln LongLivedModules test/` returns only `preflight_test.exs`, which tests the extractor, never the membership.

**Fix:** Extend `application_supervision_tree_test.exs` with a second assertion — every top-level child defining a `defstruct` or returning a non-empty map literal from `init/1` must appear in `LongLivedModules.all/0` or in an explicit commented `@exempt` list. Then add the four. The test already enumerates the children; marginal cost is one assertion.

#### D-S2. Two independent Docker source-substrate deploy implementations — the #503 drift class, one layer down
**File:** `scripts/deploy.sh:52-183` vs `infra/docker/deploy.sh:627-720`
**Severity:** HIGH · **Category:** duplication / simplification

`infra/lib/deploy_common.sh:2-8` states the rule the extraction encodes: an algorithm more than one substrate must get right lives in `infra/lib/`, and a substrate contributes only the 20% that differs. But these are not two substrates — they are one (compose, from a checkout, `Preflight.cli(…, "docker")`, same `container_name: grappa`, same host) with two full hook sets, several byte-identical (`substrate_commit_exists`, `substrate_changed_files`, `substrate_write_marker`). Drift is already live: `.env` precondition (dies vs none), `MIX_ENV` floor (`${MIX_ENV:-prod}` vs none), `git pull` failure message, box-ownership guard (absent vs `assert_box_ownership`), pre-#485 `.env` migration (absent vs `migrate_publish_env`), `--no-pull` (absent vs present), empty-array expansion (`"${A[@]}"` vs the bash-3.2-safe form). `scripts/quickstart{,-update,-stop}.sh` were already collapsed into thin `exec` forwarders onto this same driver (#503); `scripts/deploy.sh` is the one left behind.

**Fix:** Make `scripts/deploy.sh` a forwarder to `infra/docker/deploy.sh update "$@"` (the shape `quickstart-update.sh:8` uses), or extract the compose hook set into a sourced `infra/docker/compose_hooks.sh` both consume — the second keeps `scripts/deploy.sh`'s `require_main_checkout` first-step contract.

#### D-S3. On the HOT path `scripts/deploy.sh` never establishes `MIX_ENV`, so the theme seed can run against the DEV database on a prod box
**File:** `scripts/deploy.sh:97-104` and `:155-161`
**Severity:** HIGH · **Category:** deploy correctness

`substrate_build` short-circuits on hot (`[ "$MODE" = cold ] || return 0`, `:97`) BEFORE the `.env` check and `MIX_ENV=${MIX_ENV:-prod}; export MIX_ENV` at `:103-104`. `deploy_common.sh:414` then calls `_deploy_hot` → `_deploy_seed` → `substrate_seed` (`:155`), a fresh `docker compose --profile prod run --rm grappa mix grappa.seed_themes`. With no shell `MIX_ENV`, compose falls back to `.env`, and `.env.example:14` ships **`MIX_ENV=dev`** uncommented; `compose.yaml:49-50` then resolves `MIX_ENV: dev` and `DATABASE_PATH: /app/runtime/grappa_dev.db`.

The trap is the die message itself: it names exactly three keys to fill and never mentions `MIX_ENV`, so an operator following it verbatim gets a box where COLD deploys run prod (the `:103` export wins) and HOT deploys seed dev — asymmetric, silent, and hot is the documented normal case. `infra/docker/deploy.sh` does not have this bug because `cmd_install` writes `set_env MIX_ENV prod` (`:285`); `scripts/deploy.sh` has no installer. #440 elevated seeding from a capability to "a correctness property" precisely so a substrate could not silently skip it; this substrate silently redirects it.

**Fix:** Hoist the `.env` check and the `MIX_ENV` export out of `substrate_build` to the top of the script, before `deploy_main` (also subsumed by D-S2). Separately, comment out or annotate `MIX_ENV=dev` in `.env.example:14` — the drift test forces the key to be PRESENT, not to be pre-set to the wrong value.

### MEDIUM

#### D-S4. The POSIX gate covers 5 of ~20 `sh`-dialect files and misses 2 of the 3 shared libs the docs call POSIX
**File:** `.github/workflows/ci.yml:176-180` · **Severity:** MEDIUM

`docs/OPERATIONS.md:2792` says three POSIX-sh files under `infra/lib/` are strict POSIX so the jail's `/bin/sh` can run them; the `dash -n` step parses one. `infra/lib/beam_wait.sh` and `infra/lib/cic_dist.sh` — both `# shellcheck shell=sh` on line 1, both sourced by `#!/bin/sh` jail consumers — are unchecked, as are the twelve `infra/freebsd/jail_*.sh` rails and `infra/packaging/version.sh`. The step's comment defends the hand list ("the honest derivation for it is a separate piece of work"), fair for the general question but not for two files in the same directory with the same line-1 declaration. Note `scripts/shellcheck.sh` already lints these in `sh` dialect where SC3xxx reports POSIX violations, so the `dash -n` list is largely redundant as well as incomplete.
**Fix:** Derive it the way `shellcheck.sh:52-63` already derives its set (`#!/bin/sh` shebang OR `# shellcheck shell=sh` line 1) and feed that to `dash -n`. Twelve lines, reusing an existing function.

#### D-S5. The `oven/bun` digest is transcribed four times with no equality gate
**File:** `compose.yaml:121`, `scripts/bun.sh:25`, `.github/workflows/ci.yml:348`, `cicchetto/e2e/compose.yaml:527` · **Severity:** MEDIUM

All four read `sha256:e10577f0…e5c4` today. `test/infra/base_image_digest_pin_test.bats` asserts each reference carries `@sha256:` and is well-formed — never that they are equal. `ci.yml:341` states the invariant in prose, the shape #441 rejected. Concrete failure mode: `scripts/bun.sh:29` and `compose.yaml:126` bind the SAME host cache (`runtime/bun-cache`), and `OPERATIONS.md:929` records why that matters. A bump touching three of four leaves the fourth on an older bun, and the only symptom is a lockfile/cache disagreement in CI.
**Fix:** Third bats case — extract every `oven/bun:1@sha256:` token across tracked build files and assert `sort -u | wc -l == 1`.

#### D-S6. `PORT` is documented and forwarded but honoured by no Docker-side consumer
**File:** `compose.yaml:98`, `.env.example:106`, `Dockerfile:50`, `compose.yaml:101`, `scripts/healthcheck.sh:13`, `scripts/deploy.sh:114`/`:172`, `scripts/deploy-cic.sh:57` · **Severity:** MEDIUM

`.env.example:105-106` presents `PORT` as an ordinary knob with no caveat and `compose.yaml:97-99` gives it a literal default specifically so the override is not a silent no-op (#369 X1) — but every Docker consumer hardcodes 4000: the container side of the publish (`compose.yaml:33`), both healthchecks, the three probes, and the `/admin/reload` + `/admin/cic-bundle-changed` POSTs. Set `PORT=4001` and the container is healthy-but-reported-unhealthy, `depends_on: service_healthy` on `shottino-ircd` (`:173`) hangs forever, and every deploy fails at the reload POST. Contrast: `Dockerfile.release:192` uses `${PORT:-4000}` and `infra/linux/deploy.sh:172` / `install.sh:248` use `${PORT}` — the two Docker-free substrates got this right. #369 X1's drift gate proves propagation into compose, not usability by the substrate.
**Fix:** Cheapest honest option is to mark `PORT` Docker-unsupported in `.env.example` and the compose comment. Otherwise thread it: `"${GRAPPA_PUBLISH:-127.0.0.1:4000}:${PORT:-4000}"` plus a `GRAPPA_PORT`-aware helper in `_lib.sh` the four probe/POST sites call.

#### D-S7. `compose.oneshot.yaml` is layered by `in_oneshot()` and bypassed by every raw `compose run` in the deploy scripts
**File:** `scripts/_lib.sh:254-258` vs `scripts/deploy.sh:88`, `:133`, `:144`, `:152`, `:160`; `scripts/deploy-cic.sh:48` · **Severity:** MEDIUM

`compose.oneshot.yaml:5-6` and `_lib.sh:249-252` both state the hazard (a oneshot inheriting `container_name: grappa` and the host port-publishes collides with the long-lived copy) and `_lib.sh` calls a misplaced `-f` "a one-character-edit hazard". Yet six `docker compose … run --rm` invocations across the two deploy scripts do not layer it and run against a live `grappa` container by design; `infra/docker/deploy.sh` does the same. Both claims cannot be true: either the collision is real and six deploy-path oneshots are a latent `Address already in use`, or Compose v2's `run` already ignores `container_name` and drops unpublished ports, in which case only `healthcheck: disable: true` earns its keep.
**Fix:** Settle which, then either route the six through `in_oneshot` (they gain `CACHE_ENV`/`CACHE_VOLUMES`, which they currently silently lack under `GRAPPA_CACHE_ID`) or trim the file to the healthcheck override and delete the hazard prose.

#### D-S8. `integration.yml`'s path filter misses `bin/start.sh`, `.dockerignore` and `VERSION` — all of which define what the suite boots
**File:** `.github/workflows/integration.yml:52-67`, `:70-85` · **Severity:** MEDIUM

The filter's own rule (`:23`) puts the root `Dockerfile` and `compose.yaml` in scope because "they define the images the suite boots". By that rule three more belong: `bin/start.sh` (the image `CMD`, `Dockerfile:53`; already docker-COLD in `preflight.ex:442`), `.dockerignore` (the build context; `preflight.ex:441`), and `VERSION` / `infra/packaging/version.sh` (`testnet.sh:32` and `integration.sh:39` both call it and export the result; `compose.yaml:144` notes "Empty makes vite fail loud"). #715 fixed the JS half of this filter; the image half was not swept.
**Fix:** Add the four to both `paths:` blocks. Longer term the duplicated 15-line block should be a YAML anchor — push and PR lists are transcribed twice and can drift from each other.

#### D-S9. `OPERATIONS.md` claims base images are digest-pinned; the gate it names covers `oven/bun` and `nginx:alpine` only
**File:** `docs/OPERATIONS.md:2354-2362`, `Dockerfile:10`, `test/infra/base_image_digest_pin_test.bats:29` · **Severity:** MEDIUM

The runbook says the bats suite "fails the build if any real image reference in a tracked build file loses its `@sha256:`"; the test's grep is `-E 'oven/bun:|nginx:alpine'`. The primary base — `Dockerfile:10`, `FROM elixir:1.19-otp-28-alpine` — is unpinned and unguarded, as is `alpine:3.24` in the release runtime stage. For `alpine:3.24` that is deliberate and argued (`OPERATIONS.md:2403`: a FLOOR, proven by `assert-abi-lockstep.sh`); for the Elixir base it is argued nowhere, and it is what makes the Elixir patch level float.
**Fix:** Pin the Elixir base by digest and widen the grep to `elixir:`, or amend the doc to say which families are pinned and why the toolchain base floats. The doc currently over-claims a gate's scope, which is worse than either.

#### D-S10. Elixir/OTP is pinned in three places; the runbook says CI reads `.tool-versions`
**File:** `.tool-versions:1-2`, `ci.yml:15-16`, `release.yml:134-135`, `Dockerfile:10`, `docs/OPERATIONS.md:3401-3410` · **Severity:** MEDIUM

`OPERATIONS.md:3403` argues correctly that a distro's Erlang packaging cannot be trusted and that `infra/linux/install_toolchain.sh` runs a bare `asdf install` so "the pin CI runs is the pin installed here, with no second hand-maintained pin to drift", naming CI as "`erlef/setup-beam`, reading the same file." CI does not read that file: both workflows hardcode `1.19.5` / `28.5`, and the Dockerfile pins a floating minor tag. Four carriers, three hand-maintained, and the sentence that says otherwise is the one a future editor will trust.
**Fix:** `erlef/setup-beam` supports `version-file: .tool-versions` — use it in both workflows and delete the `env:` pins.

#### D-S11. `scripts/db.sh` re-implements `detect_mix_env` and cannot run from a worktree
**File:** `scripts/db.sh:15`, `scripts/_lib.sh:221-223` · **Severity:** MEDIUM

`_lib.sh:220` declares `detect_mix_env` the single source of truth; `db.sh:15` instead does `env="$(in_container printenv MIX_ENV 2>/dev/null || echo dev)"`. That drops the `tr -d '\r'` normalisation (a `\r` silently produces `db_path_for_env "dev\r"` and a nonexistent path), and `in_container` (`_lib.sh:235`) hard-dies from a worktree — with the `die` swallowed by `2>/dev/null`, so it silently reports `dev` and fails on the NEXT `in_container` call. CLAUDE.md names `scripts/db.sh` as a first-resort investigation tool, and every code change happens in a worktree by rule.
**Fix:** Use `detect_mix_env` and route the sqlite invocation through `in_container_or_oneshot`. Also quote `$MODE_ARG` (`db.sh:24`/`:26`) — currently an unquoted expansion relying on word-splitting-to-nothing.

#### D-S12. `scripts/gen-backgrounds.py` requires a host Python + numpy + PIL + Debian font paths, against "the container IS the runtime"
**File:** `scripts/gen-backgrounds.py:16-24` · **Severity:** MEDIUM

Not dead — `lib/grappa/themes/builtin_backgrounds.ex:37`/`:70` cite it as the generator of committed backgrounds 09..14 and `cicchetto/e2e/tests/issue294-builtin-bg-picker.spec.ts:54` counts on its output. But it is the only artifact generator with no container, no declared dependencies and hardcoded absolute host paths (`/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf`), absent from `OPERATIONS.md` entirely. Its docstring's whole argument is that the contrast constraint is "MEASURED, not hoped for" — a measurement nobody can reproduce is back to hoped-for.
**Fix:** Give it a pinned oneshot (`scripts/backgrounds.sh` on `python:3.x-slim`, mirroring how `bun.sh` and `shellcheck.sh` containerise their tools), or record in `OPERATIONS.md` that regeneration is a manual Debian-host step and pin the package set. Make the font paths env-overridable either way.

#### D-S13. The Docker `/healthz` probe is transcribed four times with a documented no-drift requirement and no gate
**File:** `Dockerfile:50`, `compose.yaml:101`, `scripts/healthcheck.sh:13`, `scripts/deploy.sh:172` · **Severity:** MEDIUM

`OPERATIONS.md:657` says of two of them "the two copies must not drift apart". There are four, and they already differ in retry count (`Dockerfile:49` `--retries=3` vs `compose.yaml:107` `retries: 5`) — harmless because compose's definition wins, which raises the question of why the `Dockerfile` `HEALTHCHECK` exists: it is dead for every compose-driven path and reachable only via a bare `docker run` of the toolchain image, which is not a supported shape. `infra/docker/deploy.sh` adds four more probe transcriptions on the release side.
**Fix:** Drop the `Dockerfile` `HEALTHCHECK`, and have `substrate_healthcheck` call `scripts/healthcheck.sh` instead of re-typing the curl.

### LOW

#### D-S14. The `quickstart*.sh` shims say "kept for one release"; three minor releases have passed
**File:** `scripts/quickstart.sh:2`, `quickstart-update.sh:2`, `quickstart-stop.sh:2` · **Severity:** LOW
`VERSION` reads 1.2.0; #503 landed at `97ac22b6`, well before. They cost three files, a bats suite, three entries in `shellcheck.sh`'s derived set, and a runbook paragraph. `infra/docker/deploy.sh`'s bare form is strictly better.
**Fix:** Delete all of it in one commit, or replace "one release" with the actual removal version so the note is checkable.

#### D-S15. The documented bash floor is wrong in its stated reason and the codebase disagrees with itself
**File:** `docs/OPERATIONS.md:333-336`, `scripts/_lib.sh:47`, `scripts/shellcheck.sh:63`, `infra/docker/deploy.sh:729` · **Severity:** LOW
The runbook says scripts use `declare -ag` ("associative-global arrays") which macOS bash 3.2 rejects. `-a` is INDEXED (`-A` is associative and appears nowhere); `-g` is a no-op at the top level of a sourced file, which is where every `declare -ag` sits. The genuinely bash-4-only constructs are `mapfile` (`shellcheck.sh:63`, `infra/cloud/check-drift.sh:150`/`:156`/`:163`), and the real floor is **4.4**, not "4+": `_lib.sh:257` expands `"${WORKTREE_VOLUMES[@]}"` under the `set -u` it imposes at `:25`, an unbound-variable error on an empty array in bash 4.0–4.3. Meanwhile `infra/docker/deploy.sh:729` is the single site using the bash-3.2-safe form, with a comment saying so.
**Fix:** Correct the paragraph to name `mapfile` and state 4.4; pick one posture for empty-array expansion repo-wide.

#### D-S16. `export COMPOSE_ARGS` is a no-op
**File:** `scripts/_lib.sh:51` · **Severity:** LOW
Bash cannot export arrays. Consumers get it because they SOURCE `_lib.sh`. It reads as a cross-process contract and is not one; `WORKTREE_VOLUMES`, `CACHE_VOLUMES` and `CACHE_ENV` are correctly left unexported, which makes the exception look load-bearing.
**Fix:** Delete the line or replace it with a comment.

#### D-S17. `REPO_ROOT` means two opposite things depending on the file
**File:** `scripts/_lib.sh:39` vs `scripts/shellcheck.sh:37`, `scripts/quickstart.sh:7` · **Severity:** LOW
`_lib.sh` defines it as the MAIN repo via `--git-common-dir`, deliberately, so caches are shared — CLAUDE.md flags this in red. The others define the same name as the current worktree. Both locally correct; a reader carrying one meaning into the other file reads it backwards, and they diverge only in a worktree, which is where all development happens.
**Fix:** Rename the non-`_lib.sh` occurrences to `SELF_ROOT`/`SRC_ROOT` with a one-line why.

#### D-S18. The `WORKTREE_VOLUMES` drift-pin list is a hand list with a documented "remember to add it" process and no gate
**File:** `scripts/_lib.sh:94-107`, `docs/OPERATIONS.md:456-473` · **Severity:** LOW
The runbook mandates that adding a drift-pin test reading a root-level file means adding its `-v` override in the same change; the failure mode is that a worktree oneshot reads MAIN's copy, so a correct fix cannot go green before merge (`OPERATIONS.md:467` records exactly that happening to #1086). Five entries exist, each added after being missed once. `grep -rln WORKTREE_VOLUMES test/` finds only comments.
**Fix:** A test that greps `test/**/*_test.exs` for root-level `File.read!`/`Path.expand` literals and asserts a matching `-v` line. Lower-effort alternative: bind the repo root read-only in `in_oneshot` and drop the per-file list.

#### D-S19. `compose.yaml` mounts `./runtime` twice
**File:** `compose.yaml:45-47` · **Severity:** LOW
`- ./:/app` then `- ./runtime:/app/runtime` — the same host directory, already reachable through the first, with no rationale in DESIGN_NOTES or OPERATIONS. Nothing in `_lib.sh`'s worktree overrides replaces `./:/app`, so the nested mount can never differ.
**Fix:** Drop line 47 and fold its comment into line 45's, or state the hedge explicitly.

#### D-S20. `deploy-m42.sh`'s push guard passes on a diverged main, and silently drops extra flags
**File:** `scripts/deploy-m42.sh:83-92`, `:53-77` · **Severity:** LOW
The guard dies only when `origin/main` is an ancestor of local `main`; if the two have DIVERGED, `merge-base --is-ancestor` is false and the script proceeds, deploying `origin/main` — not the tree the operator is looking at, which the stated purpose (`:10`) covers. And the mode `case` matches `${1:-}` only, so `--force-cold --defer-restart` silently discards the second flag, which the jail's `deploy.sh` does support. Minor: `:130` writes the marker with a bare redirect while every `substrate_write_marker` does `mkdir -p runtime` first.
**Fix:** Add an `else` arm for divergence and `[ $# -le 1 ] || die "unexpected extra arguments: $*"`.

#### D-S21. Only the e2e job has a `timeout-minutes`
**File:** `.github/workflows/ci.yml:19`, `:214`, `:279`, `:338`; `release.yml:144` et al. · **Severity:** LOW
`integration.yml:104` sets 45 minutes with a good comment; every job in `ci.yml` and `release.yml` runs on the 360-minute default. The `test` job is a long serial chain, and a hang in any step burns six runner-hours before anyone sees it.
**Fix:** 30 on `test` and `dialyzer`, 10 on `shottino` and `cicchetto`, sized values per release job.

#### D-S22. `testnet.sh probe` uses a bare `docker exec <hardcoded-name>`
**File:** `scripts/testnet.sh:112` · **Severity:** LOW
Every sibling verb uses `docker compose exec/ps/logs` after `cd "$E2E_DIR"`. `OPERATIONS.md:679` records the general lesson from `deploy-cic.sh` ("a bare `docker exec grappa` assumed `container_name: grappa` literally and broke under compose overrides"). Works today because the e2e stack pins its names.
**Fix:** `docker compose exec -T nginx-test sh -c '…'` inside the existing `cd`.

#### D-S23. `OPERATIONS.md`'s script catalog omits three `scripts/` files, and carries a committed authoring artifact
**File:** `docs/OPERATIONS.md:273-298`, `:338-343` · **Severity:** LOW
The file's second sentence mandates keeping the catalog in sync. Three scripts appear nowhere in `OPERATIONS.md` or `TESTING.md`: `scripts/design-notes-gate.sh` (a CI gate, `ci.yml:161`, and part of the `check.sh` → `bats.sh` chain), `scripts/gen-backgrounds.py` (D-S12), `scripts/zfs_baseline.exs`. Separately, `:338-343` is a leftover HTML comment addressed to whoever was editing the file ("#1159 — prose to APPEND to docs/OPERATIONS.md … Append AFTER the existing 'Bash 4+ required.' paragraph") — a task instruction committed into the runbook and executed months ago.
**Fix:** Add the three to the catalog (`design-notes-gate.sh` also warrants a line in `TESTING.md`); delete `:338-343`.

### Explicitly checked and found to be a non-issue
`timeout(1)` on darwin: `grep -rn '\btimeout '` over `scripts/`, `infra/` and `bin/` returns nothing — every wait is a hand-rolled `until`/`while` with its own counter (`deploy_common.sh:254`, `release-image.sh:51`, `smoke-release-image.sh:93`, `deploy-m42.sh:113`). No portability exposure.
## Scope: cross-surface (server ↔ cicchetto)

Headline from the agent: the generated mirror (`mix grappa.gen_wire_types` → `wireTypes.ts` + `wireSchema.ts`, gated by `--check` in `scripts/check.sh:32` and `.github/workflows/ci.yml:78`) has genuinely closed the classic drift class. Every finding sits in a region the codegen or the `_Assert_*` pins do NOT cover. No camelCase key exists anywhere on the wire; verb names, event kinds and error tokens all reconcile.

### HIGH

#### X-S1. ~20 discriminated-union arms are exempt from the drift pins, and one has already drifted
**File:** server `lib/grappa/session/wire.ex:150`; generated `cicchetto/src/lib/wireTypes.ts:937`; hand-roll `cicchetto/src/lib/api.ts:740` and `:1071`; exemption `cicchetto/src/lib/wireTypesAssert.ts:145-149`
**Severity:** HIGH · **Category:** wire-shape drift / duplicated structure

`wireTypesAssert.ts:145-149` exempts `WireUserEvent`, `WireChannelEvent`, `WireAdminEvent`, `MeResponse` and `Network` from the `Equal<>` pins, promising their per-arm payloads are pinned below. Not exhaustively: `_Assert_*` exists for ~18 arms but NOT for `isupport_changed`, `members_seeded`, `channel_created`, `channel_modes_changed`, `topic_changed`, `own_nick_changed`, `umode_changed`, `supported_umodes_changed`, `session_identity_changed`, `mentions_bundle`, `peer_away`, `invite_ack`, `channels_changed`, `directory_progress`/`_complete`/`_failed`, `recover_progress`, `recover_result`, `web_session_severed`, `banlist_bundle`, `server_reply`, `names_reply`, `who_reply`, `whois_bundle`, `whowas_bundle`, `lusers_bundle`.

Live drift found in the largest payload on the wire: server `isupport_changed_payload.frame_budget_base :: integer()` (never nil — `LineSplit.frame_budget_base(linelen)` at `wire.ex:947`), generated `…: number`, but the hand-written arms declare `number | null` with a comment claiming "null when the server published no budget", which is false against this server. Currently safe (client wider than server), but it proves the exemption region is unguarded. `WireSessionEvent` (`wireTypes.ts:1306`), the generated union that would make the hand-roll redundant, has ZERO importers.

**Fix:** One `_Assert_*` per unpinned arm using the existing pattern at `wireTypesAssert.ts:275-283`. Expect `isupport_changed` to fail immediately; fix on the cic side (drop `| null`, the stale comment, and the `?? null` fallback at `wireNarrow.ts:246`). Longer term alias each arm to its generated counterpart so the hand-roll cannot exist.

#### X-S2. cicchetto never negotiates the protocol version, and never reads `/api/config`
**File:** server `lib/grappa_web/controllers/config_controller.ex:44-54`, `lib/grappa/protocol.ex:64,71`, `lib/grappa_web/channels/grappa_channel.ex:376-383`; client `cicchetto/src/lib/socket.ts:83-88` (`socketEndpoint`), `:329-351` (`joinUser`)
**Severity:** HIGH · **Category:** protocol-version seam

`grep -rn 'protocol_version|client_proto|min_protocol'` over all of `cicchetto/` returns exactly one hit, a prose comment (`socket.ts:742`). `socketEndpoint` builds `wss://host/socket` with no `?client_proto=`, so the server treats cic as *current*; `onJoinOk` receives the join reply carrying `protocol_version` and does nothing with it; nothing fetches `/api/config`, so `min_protocol_version` and `push_content_encoding` are never observed. This matters more for cic than for a generic client: it is a service-worker-cached PWA, i.e. exactly the client that can be arbitrarily stale against a freshly deployed BEAM, and `--cic`-only vs server-only deploys are normal here. The 426 refusal exists to catch that, and cic has opted out by omission. It is also the reference implementation third-party authors read. `push_content_encoding` has the same shape: `CLIENT_PROTOCOL.md:44-60` tells clients to check it before blaming their decryptor; `service-worker.ts` / `lib/pushPayload.ts` never do.

**Fix:** Append `client_proto=<N>` to `socketEndpoint`'s URL from a cic-side constant; consume the join reply's `protocol_version` in `onJoinOk` (log/banner on mismatch); add a boot-time `GET /api/config` in `bootFetch.ts` so `min_protocol_version` is checked before the socket opens and `push_content_encoding` gates the push-permission UX.

#### X-S3. The published carrier topic for `joined` / `join_failed` / `kicked` is wrong on all three surfaces
**File:** behaviour `lib/grappa/session/server.ex:6541-6544` (`broadcast_window_state/2` → `Broadcaster.to_user`), call sites `:5566`, `:5651`, `:5757`; stale comment `:5752-5755`; `CLAUDE.md` window-state invariant; client comment `cicchetto/src/lib/api.ts:1195-1199`
**Severity:** HIGH · **Category:** event/topic divergence

`broadcast_window_state/2` does one thing: `Broadcaster.to_user(state, payload)` (`broadcaster.ex:66-68` → `Topic.user/1`). Live `joined`/`join_failed`/`kicked` therefore ride the USER topic only; the per-channel topic sees them exclusively as the cold-subscribe snapshot `push/3` from `push_window_state_if_known/4` (`grappa_channel.ex:1641-1649`), a per-socket push, not a broadcast. Three published statements contradict that: CLAUDE.md's invariant ("transitions emit typed events on the per-channel topic (`joined | join_failed | kicked | members_seeded`)" — only `members_seeded` is actually per-channel, alongside `topic_changed` and `channel_modes_changed`); `server.ex:5752-5755`, inside the `:kicked` arm, naming the per-channel topic while calling the user-topic helper two lines later; and `api.ts:1195-1199`, describing a "dual-broadcast … via `Session.Server.broadcast_window_state_dual/3`" — `grep -rn 'broadcast_window_state_dual' lib/` returns NOTHING. cic works because `userTopic.ts:1484-1496` and `subscribe.ts:490-496` dispatch these kinds into the same idempotent setters. A third-party client that follows CLAUDE.md subscribes per-channel and never observes a live join or kick.

**Fix:** Correct the CLAUDE.md invariant, the `server.ex:5752` comment and the `api.ts:1195` comment to state the real model — live transitions on the user topic, per-channel gets only the join-time snapshot. Add the split to `CLIENT_PROTOCOL.md` §4: it is a topic-selection fact a client author cannot derive.

### MEDIUM

#### X-S4. The scrollback `meta` key allowlist is a closed set server-side and `Record<string, unknown>` on the wire mirror
**File:** `lib/grappa/scrollback/meta.ex:176-202` (`@type t`), `:204` (`@known_keys`, 22 keys); generated `cicchetto/src/lib/wireTypes.ts:64`; codegen `lib/mix/tasks/grappa/gen_wire_types.ex:567-576`, `:670-672`; consumers `cicchetto/src/ScrollbackPane.tsx:646-651`, `:757`, `:808`, `:840`, `:960` · **Severity:** MEDIUM

Because the key AST is a UNION of atoms rather than a single atom, `atom_keyed_field?/1` returns false and `strip_map/1` takes the `:open_map` branch → `Record<string, unknown>`. The codegen's moduledoc flags that outcome as "WARNING — defeats codegen purpose" for bare `map()`; the union-keyed form reaches the same place silently, without even the `IO.warn` at `:671`. Consequence: three fields `CLIENT_PROTOCOL.md` §5a/§5b publishes as contract (`meta.ctcp_target`, `meta.notice_target`, `meta.statusmsg`) plus `raw_verb`/`raw_sender`/`raw_params`/`sender_prefix`/`numeric` have no typed mirror; `ScrollbackPane.tsx` reaches them through ad-hoc `typeof x === "string"` guards, and renaming a meta key is a silent client regression.
**Fix:** Teach `strip_map/1` a third case — when every field is `map_field_assoc` with an atom-UNION key, emit `Partial<Record<"target" | "new_nick" | …, unknown>>`. Pins the key names without pretending to know per-kind value shapes, which the `Meta` typedoc deliberately declines to encode.

#### X-S5. One `rate_limited` token, four retry-hint shapes, two units — and the client consumes neither documented one
**File:** `lib/grappa_web/plugs/request_budget.ex:64-69`; `lib/grappa_web/controllers/fallback_controller.ex:266-271`; `lib/grappa_web/channels/grappa_channel.ex:505`; `docs/CLIENT_PROTOCOL.md:327-330`; `cicchetto/src/lib/api.ts:1516-1520` · **Severity:** MEDIUM

Four emitters: the RequestBudget plug (`{error, retry_after_ms}` + `Retry-After` seconds), `FallbackController {:rate_limited, n}` (`{error}` + header), bare `:rate_limited` (`{error}`, no header), and the WS door (`{error, retry_after_ms}`, no header possible). `readError` reads ONLY the header and stores `info.retry_after` in seconds; `grep -rn 'retry_after_ms' cicchetto/` returns zero. So on the WS door, where the only hint is `retry_after_ms`, cic gets no pacing hint at all; on the REST budget door it uses coarse header seconds while a precise millisecond value sits unread. `CLIENT_PROTOCOL.md:330` tells clients to back off for at least `retry_after_ms` on both doors, which the reference client does on neither.
**Fix:** Have `readError` prefer `body.retry_after_ms`, normalise to one `info.retry_after_ms` (deriving from the header only as fallback), have `channelPushError` surface the same key, make `FallbackController` emit `retry_after_ms` in the body so all four agree, and update the compose backoff to read the unified field.

#### X-S6. `windowClose` drops server-owned window state optimistically, on a fire-and-forget DELETE that can reject
**File:** `cicchetto/src/lib/windowClose.ts:62-70`; `cicchetto/src/lib/api.ts:2488-2503` · **Severity:** MEDIUM

`void postPart(...)` then `forceParted(channelKey(...))` unconditionally. `postPart` is `async` and THROWS on any non-2xx, and the call is `void`-ed with no `.catch`, so a failing DELETE produces an unhandled rejection AND drops the local `windowStateByChannel` key. That is the #511 bug the surrounding 40-line comment says this code exists to prevent: the row vanishes locally, the server keeps `window_states[ch]`, and the cold-subscribe snapshot resurrects it on the next reload. The comment's token guard covers only the no-token case, not a 429 from the #630 budget, `not_connected`, `not_found`, or a transport failure. Its own sibling `disconnectNetwork` (`:159-161`) DOES attach a `.catch`.
**Fix:** `void postPart(...).then(() => forceParted(key)).catch(…)`, or keep the optimistic drop but re-assert the key on rejection so the mirror re-converges to server truth.

#### X-S7. `RecoverStep` / `RecoverStatus` / `RecoverOutcome` / `RecoverResultReason` are hand-restated copies of generated consts
**File:** hand-roll `cicchetto/src/lib/api.ts:951-957`; generated `cicchetto/src/lib/wireTypes.ts:1268-1297`; server `lib/grappa/session/wire.ex:833-846` · **Severity:** MEDIUM

All four already exist as `SESSION_WIRE_RECOVER_{STEP,STATUS,OUTCOME,REASON}` + derived types; values match today. Same three-parallel-structures problem #411 D6b collapsed for error tokens, left standing here — and `api.ts` already single-sources `ConnectionState`, `ServicesFlavor`, `ServerReplySource` and `MessageKind` this way (`api.ts:263` etc.), so this is a half-migration. (The `reason: string | null` widening on the `recover_result` arm is a separate, deliberate, documented additive tolerance — leave it.)
**Fix:** `export type RecoverStep = SessionWireRecoverStep;` and the three siblings; `recoverProgress.ts` then derives its runtime allowlist from the const instead of a literal check.

#### X-S8. The `window_state` closed set has a server SSOT that never reaches the wire mirror
**File:** `lib/grappa/session/window_state.ex:70`; `cicchetto/src/lib/windowState.ts:32` · **Severity:** MEDIUM

`window_state/0` is `:pending | :invited | :joined | :failed | :kicked | :parked`; `windowState.ts:32` restates it verbatim. `window_state.ex` is not `*wire.ex`, so codegen never sees it. CLAUDE.md says adding a state is a server change cic just mirrors — but the mirror is a hand copy with no gate, so the server can add a state, cic's union will not widen, `tsc` will not fail, and the new state lands in `windowStateByChannel` typed as something it isn't.
**Fix:** Add `@type window_state :: WindowState.window_state()` (or a thin re-export) to `Grappa.Session.Wire` so codegen emits `SESSION_WIRE_WINDOW_STATE`, then alias it client-side. Also gives `pseudoChannels.ts:63`'s narrower subset something to `Exclude<>` from rather than re-list.

#### X-S9. The theme token vocabulary — a server-owned closed set — is restated by hand in `themesApi.ts`
**File:** `lib/grappa/themes/token_model.ex:34-44`, `lib/grappa/themes/builtin_backgrounds.ex:55`; `cicchetto/src/lib/themesApi.ts:25-52`, `:61`, `:63-79`, `:83-88` · **Severity:** MEDIUM

Four vocabularies hand-mirrored (`ThemeFontFamily` ↔ `@font_families`, `ThemeColorKey` ↔ `@base_color_keys ++ @nick_color_keys`, `ThemeBackgroundSize` ↔ `@size_modes`, `BuiltinBackground` ↔ `BuiltinBackgrounds.t`), each with a "mirror of …" comment and nothing enforcing it. Two secondary notes: `TokenColors = Record<ThemeColorKey, string>` uses a PATTERN template literal for the nick slots, which TS degrades to an index signature, so a payload missing `nick_5` type-checks while the server sanitiser requires all 27; and `GET /themes/backgrounds` (`themes_controller.ex:145`) serialises `BuiltinBackgrounds.t` with no generated counterpart at all.
**Fix:** Expose these as `@type`s on `Grappa.Themes.Wire` (which IS under the glob) so codegen emits the consts and a `ThemesWireBuiltinBackground`, then alias in `themesApi.ts`. Also gives `customTheme.ts` a runtime allowlist derived from server truth.

#### X-S10. `/me` and `/auth/login` widen their `kind` discriminator to `String.t()` and sit outside the codegen glob
**File:** `lib/grappa_web/controllers/me_json.ex:97`, `:108`; `lib/grappa_web/controllers/auth_json.ex:26`, `:28`; `cicchetto/src/lib/api.ts:312-385`, `:150-157` · **Severity:** MEDIUM

Both envelopes are discriminated unions whose discriminator is `String.t()` rather than `:user | :visitor` — precisely the widening `Scrollback.Wire`'s S14 note calls out as defeating codegen, unfixed here. Worse, both modules live under `lib/grappa_web/controllers/`, outside `@wire_glob`, so even a corrected atom union would not be emitted. Result: `MeResponse` and `Subject` are large, entirely unpinned hand-mirrors of the two envelopes every session boot depends on, and `wireTypesAssert.ts:145-149` names `MeResponse` in the exemption list explicitly.
**Fix:** Narrow both `@type`s to `kind: :user | :visitor`; then either move the shapes into `Grappa.Accounts.Wire` / `Grappa.Visitors.Wire` (which already own `user_to_json/1` and `visitor_to_json/2`) or widen `@extra_globs` at `gen_wire_types.ex:99` the way it already reaches `error_tokens.ex`. Then add `_Assert_MeResponse` / `_Assert_Subject`.

### LOW

#### X-S11. `/me` fields the server always sends are typed optional client-side, for test-mock reasons
**File:** `lib/grappa_web/controllers/me_json.ex:96-118` vs `cicchetto/src/lib/api.ts:332-345`, `:372-380` · **Severity:** LOW
`read_cursors`, `unread_counts`, `badge_count`, `home_data` are required keys in both server arms and `?:` client-side, with the comment stating the reason is that test mocks predating the field should not need touching. That is production types shaped by test fixtures. Cost: every consumer branches on `undefined` for something that can never be undefined, which hides a genuine absence if one occurs.
**Fix:** Make the four required and fix the fixtures (a shared `makeMe()` helper absorbs the churn once).

#### X-S12. `CLIENT_PROTOCOL.md` §4 states the wrong fold for topic channel segments
**File:** `docs/CLIENT_PROTOCOL.md:185-186` vs `lib/grappa/pubsub/topic.ex:105` · **Severity:** LOW
The doc says channel segments are "case-folded under rfc1459 server-side". Per the #525 posture the fold is plain byte-level ASCII (`A-Z` only); `[ ] \ ~` are untouched and `#chan[1]`/`#chan{1}` stay distinct. rfc1459 enters only as an ingress normalisation on networks that advertise it, never as the topic fold. A third-party client implementing §4 literally will fold `[]\~` and mis-key its topics on every bahamut network — i.e. all of prod. (Related, server-internal: `topic.ex:84-85`'s moduledoc still names the `canonical_channel/1` that #537 collapsed.)
**Fix:** Reword to "ASCII-folded (`A-Z` only)" and anchor on `Identifier.canonical_target/1`.

#### X-S13. `casemapping` is published to the client and has zero consumers
**File:** `lib/grappa/session/wire.ex:145`; `cicchetto/src/lib/isupport.ts:58`, `:153`; `cicchetto/src/lib/wireNarrow.ts:234` · **Severity:** LOW
#1255 shipped it "so a divergence on an rfc1459 network is at least KNOWABLE client-side"; nothing reads it. `channelKey.ts:61-63`'s `canonicalChannel` remains an unconditional ASCII fold, so on an rfc1459 network the server normalises `{}|^` ↔ `[]\~` at ingress and cic does not — a national-char channel or DM key diverges and the window silently never renders, with the field that would let cic DETECT that sitting inert. CLAUDE.md scopes the rfc1459 national-char gaps as known and out of scope, but it enumerates SERVER-side instances; the client key fold is a distinct instance and the one with a user-visible failure.
**Fix:** Give the field a consumer (at minimum a diag warning when `casemapping !== "ascii"`), or record in DESIGN_NOTES that it is deliberately inert seed data.

#### X-S14. `web_session_severed` hard-drops on an unrecognised `code`, inverting unknown-is-never-fatal for a terminal event
**File:** `lib/grappa/rate_limit/wire.ex:25-27`; `cicchetto/src/lib/userTopic.ts:1012-1017` · **Severity:** LOW
The narrower rejects the whole payload unless `code === "rate_limit_flood"` and returns a hardcoded literal rather than the received value. The event's ACTION (latch the flood flag, clear local auth, drop to login) is independent of the code — the code only selects copy. So an additively-added sever reason would leave the client sitting on a dead shell with a revoked bearer, waiting for the WS reconnect-failure path, which is what the #630 comment says must not happen. Note the deliberate opposite choice two arms up: `recover_result.reason` is widened to `string | null` precisely so an additive token cannot drop a terminal event.
**Fix:** Accept any string `code`, act unconditionally, fall back to generic copy — the `friendlyChannelError` posture the sibling arm already documents.

#### X-S15. `GrappaWeb.ErrorTokens` moduledoc says D6b is unwired; it shipped
**File:** `lib/grappa_web/error_tokens.ex:56-64` vs `lib/mix/tasks/grappa/gen_wire_types.ex:93-99`, `cicchetto/src/lib/friendlyApiError.ts:3`, `friendlyChannelError.ts:2` · **Severity:** LOW
The "## Downstream (D6b, not yet wired)" section describes shipped work as future: `@extra_globs` reaches the module, the three token consts are emitted at `wireTypes.ts:1486-1590`, and both `friendly*Error.ts` derive their union AND their runtime `Set` from them. A reader will conclude the client mirror is hand-kept and may build a second one.
**Fix:** Replace the section with the shipped topology, pointing at the two consumers.

#### X-S16. Inventory — wire surfaces still outside the codegen mirror
**Severity:** LOW (triage aid)
`GET /api/config` (`config_controller.ex:44-54`) → no client mirror (X-S2); `POST /auth/login` envelopes (`auth_controller.ex:466`, `:531-538`; `auth_json.ex`) → `api.ts:159-183` (X-S10); `GET /me` (`me_json.ex`) → `api.ts:312-385` (X-S10, X-S11); Web Push payload (`lib/grappa/push/payload.ex:76-82`) → `lib/pushPayload.ts:27-62`, **agrees today**; `/me/totp*` (`totp_controller.ex:14,46,76,95`) → hand-roll; `/me/passkeys*` (`passkey_controller.ex:31,114,150`) → hand-roll; `GET /themes/backgrounds` (`themes_controller.ex:145`) → `themesApi.ts:83-88` (X-S9); channel push REPLIES (`grappa_channel.ex:1305`, `:1341`) → `socket.ts:878-904`. The push payload and the watchlist replies currently agree; they are listed so triage knows which pairs are held together by review rather than by a gate.
**Fix:** These split into "move under `lib/grappa/<ctx>/wire.ex`" (themes backgrounds, push payload) and "widen `@extra_globs`" (`config_controller`, `auth_json`, `me_json`). The channel replies need a small `Session.Wire` addition per verb.
## Scope: consistency (sibling divergence, stale premises, silent narrowing — within one side)

### HIGH

#### K-S1. 51 live references to `canonical_channel/1` / `canonical_nick/1`, and two of them now state the OPPOSITE of what the code does
**File:** 51 comment/doc lines across 24 files in `lib/` (+11 in `test/`); no definition exists — `Identifier` exports only `canonical_target/1` (`lib/grappa/irc/identifier.ex:312-315`) and `/2` (`:427-428`). The **semantically wrong** members: 🔴 `lib/grappa/pubsub/topic.ex:82-95` (public `@doc`, ExDoc-visible), 🔴 `lib/grappa/read_cursor/cursor.ex:97-98`, `lib/grappa/session/event_router.ex:258-259`, `:3345-3347`, plus `query_windows.ex:361`, `notify.ex:71`, `channel_directory/wire.ex:40`, `networks/featured_channel.ex:10`, `session/presence.ex:27`, `session/part_cleanup.ex:42`, `session/server.ex:471`, `session/ghost_recovery.ex:106`, `networks/credentials.ex:995`, `scrollback.ex:1096`, `:1201`, `:1539`, `channel_directory.ex:16`
**Severity:** HIGH · **Category:** stale premise / semantic contradiction

~10 members are correctly historical ("the former", "pre-#537", "REPLACES") and should stay. Two are not merely a wrong name — they assert the OLD SEMANTICS, which were the opposite of today's. `topic.ex:84-87` tells the reader the `channel_name` segment is canonicalised "via `canonical_channel/1` (sigil-aware — **nicks for DM windows pass through unchanged**)", while the body two lines down calls `canonical_target(channel_name)`, which folds `A-Z` unconditionally — a DM topic segment IS folded. Anyone building a subscriber or the Phase-6 facade off this doc constructs `grappa:user:…/channel:Guest87449` and never receives a frame. `read_cursor/cursor.ex:97-98` says the fold "is a no-op for a DM-peer nick" as the justification for #532-D — true of the dead function, false of the one the same block calls at `:108`. `event_router.ex:3345-3347` claims the sigil-gate is "the single source of truth" inside `Identifier`; it is now a local guard clause at `:3357-3359`, and the comment three lines below (`:3350`, "SIGIL-GATED **like the old** `canonical_channel/1`") is correct — so the block contradicts itself.

**Fix:** One sweep: (a) rewrite the ~13 semantic-assertion sites to name `canonical_target/1` and state today's behaviour, starting with the published `topic.ex` `@doc`; (b) leave the historical contrasts alone; (c) add `grep -rn 'canonical_channel/1\|canonical_nick/1' lib | grep -v 'pre-#537\|the former\|REPLACES'` to `scripts/check.sh` so the next collapse cannot leave 51 orphans. (Same class as I-S6, L-S11, P-S10 — one commit covers all four scopes.)

### MEDIUM

#### K-S2. `muted_targets` joined the nick-keyed-store family (#1038) but was never added to the peer-NICK migration set (#373)
**File:** the set — `lib/grappa/session/server.ex:6111-6147` (`QueryWindows.rename/4`, `Scrollback.rename_dm_peer/4`, `ReadCursor.rename_dm_peer/4`, barrier broadcast) and `cicchetto/src/lib/subscribe.ts:583-593`; the diverging member — `lib/grappa/user_settings.ex:143`, `:1315`, `:1364`, `:1482-1507` (`grep -rn "rename" lib/grappa/user_settings.ex` → **0 hits**); key derivation `cicchetto/src/lib/conversationMute.ts:52`, `:66`; consumers `pushTriggers.ts:98`, `:128`, `activeWindows.ts:122`, `WindowBadges.tsx:92`, `RailActions.tsx:640-642`, `SettingsDrawer.tsx:612` · **Severity:** MEDIUM

The mute key was network-blind until 2026-08-08. #1038 rebuilt it on `channelKey(networkSlug, target)` where, for a DM, `target` is THE PEER NICK — making `muted_targets` a nick-keyed per-conversation store. `conversationMute.ts:46-48` makes the family claim itself: "the mute was the last per-conversation store not keyed like `scrollback` / `selection` / `subscribe`". All three named siblings migrate on a peer rename; the mute does not. Concretely: mute `guest`, they `/nick Guest2` — the server renames the window, the DM scrollback and the cursor, `windowMuteKey` computes `"<slug> guest2"`, misses the stored `"<slug> guest"`, and the peer starts notifying again with no UI event saying why; the orphan also renders forever in `SettingsDrawer.muteCandidates` as a mute for a conversation that no longer exists. The #373 entry (`DESIGN_NOTES:15945-15951`) enumerates its out-of-scope boundaries and `muted_targets` is not among them — it could not be, it postdates the entry by two weeks. Its closing lesson: "Enumerate every store of the moved identity, migrate each."
**Fix:** Add a `UserSettings.rename_muted_target/4` to the `:renamed` arm at `server.ex:6118-6127`, before the barrier broadcast, and to the `:own_nick_renamed` self-window arm. It is a JSON-map re-key, so it needs its own read-modify-write with the same fold-collision merge the other three do. Extend CLAUDE.md's "a NEW nick-keyed store MUST be added to this migration set" list so the count is enumerable.

#### K-S3. Three sibling reapers, two schedule the tick before the sweep; the one that does not is the slow one, and a comment claims all three agree
**File:** `lib/grappa/visitors/reaper.ex:188-219`, `lib/grappa/accounts/reaper.ex:107-123` vs 🔴 `lib/grappa/uploads/reaper.ex:170-184` · **Severity:** MEDIUM
Independently reached by the cross-module agent (M-S3). `Visitors` was fixed by REV-J M9 with the rationale spelled out ("a slow Cloak decrypt or a backlog of expired rows … could realistically take seconds, drifting the wall-clock cadence"); `Accounts` copied the fixed shape and its comment claims "keeping the shape identical across the three reapers avoids surprise" — a STALE PREMISE, since `Uploads` still has the pre-fix ordering, and `Uploads.sweep/2` (`:89-115`) is the slowest of the three by construction (per-row `File.rm` + soft-delete + `AdminEvents.record`, unbounded). `grep -n "schedule_tick\|interval-fixed\|REV-J M9" docs/DESIGN_NOTES.md` → 0 hits, so the divergence is unblessed.
**Fix:** Move `schedule_tick` to the top of `handle_info(:tick, …)`; then either delete the now-true-again claim or extract the shape — all three bodies are `schedule → sweep → log-and-record-if-nonzero`.

#### K-S4. `ContextMenu` is the only dismissable overlay outside the single-ESC-authority stack, and the double-close is reproducible on mobile
**File:** authority `cicchetto/src/lib/keybindings.ts:73-76`; stack `cicchetto/src/lib/overlayScrollLock.ts:195-200`, `:250-292`, `:318-336`; conforming 22 `createOverlayLock` + 3 `createOverlayEscape`; 🔴 `cicchetto/src/ContextMenu.tsx:65-72` (its own `document.addEventListener("keydown")`); hosts `UserContextMenu.tsx:153`, `MessageContextMenu.tsx:63`; collision partner `Shell.tsx:256-259` + `:398-401`; trigger `MembersPane.tsx:130-133` → `:205` · **Severity:** MEDIUM
`DESIGN_NOTES:12129-12200` (#232) states the invariant as "ONE global listener, the sole ESC authority" and names this exact failure: "a SECOND global listener would double-close (Esc on a modal opened FROM the drawer would close both at once)." The migration deleted MediaViewerModal's private listener for that reason. Context menus were never enumerated in #232's twelve. On a phone `MembersPane` IS the members drawer (refcount at `Shell.tsx:256`, deliberately not in the ESC stack): long-press a nick → `UserContextMenu` opens → one Escape closes the menu via its own listener AND the keybindings listener finds an empty ESC stack, falls through to `closeDrawer()`, and closes the members drawer underneath.
**Fix:** Replace the private listener with `createOverlayEscape(() => true, () => props.onClose())` — the menu only mounts when open and covers nothing, so the ESC-only variant is right, same call shape as the three cards. Also gives it correct LIFO precedence against any modal opened over it later.

#### K-S5. `AdminSettingsTab` is the eighth, hand-rolled copy of the refresh button — and `AdminToolbar`'s doc asserts it has no refresh at all
**File:** shared def `cicchetto/src/admin/AdminToolbar.tsx:39-51` + the stale claim at `:5-7`; slot registry `admin/refreshSlot.ts:78-81`, rendered at `admin/AdminCard.tsx:38-47` and `RailActions.tsx:540`; conforming `AdminVhostsTab.tsx:285`+`:375`, `AdminSessionsTab.tsx:293`+`:380`, `AdminSessionLogTab.tsx:73`+`:99`, `AdminUsersTab.tsx:212`+`:321`; documented exception `AdminNetworksTab.tsx:611-625`; 🔴 `AdminSettingsTab.tsx:120` + raw `<button>` at `:179-188` · **Severity:** MEDIUM
The doc says the extraction "absorbs the 7 byte-identical copies (the 8th, **Settings, has no refresh action** and is unaffected)". Settings acquired one after that sentence was written. Three consequences, all confined to this member: (1) a11y — `AdminRefreshButton` emits `aria-label` + `aria-busy`; the copy has neither, so its accessible name is the literal text, which swaps to "loading…" mid-fetch and a screen reader announces a state change as a control rename; (2) placement — every other tab's refresh lands in the rail's ☰ actions on mobile and the card head on desktop, so the operator's ☰→refresh path silently fails on exactly one tab; (3) a third copy of `class="adm-btn adm-refresh-btn"`, which `default.css:5138` already records as having had byte-identical copies once.
**Fix:** `useRefreshSlot({onRefresh, busy: loading, label: "refresh settings", testId: …})` and set `hostsRefresh` on the settings card, as the four conforming tabs do. Correct the moduledoc.

#### K-S6. Every armed (`.confirming`) state hardcodes hex; every at-rest sibling twenty lines away uses the theme tokens
**File:** `cicchetto/src/themes/default.css:4919-4922`, `:4938-4941`, `:4989-4992`, `:4994-4997`, `:5036-5039`, `:5062-5065`, `:5067-5070`, `:8035-8038` (8 rules, 15 declarations) vs the migrated at-rest twins at `:5006-5009`, `:5023-5026`, `:5028-5032`; tokens at `:293-304` with a dark override at `:338-345` · **Severity:** MEDIUM
The comment at `:5049-5053` names the reason the at-rest tints were migrated: "the four hardcoded colours in that block … are exactly the reason the circuit state and the reap toast used to ignore the active theme." The migration stopped at the resting state, so the deliberate three-step ladder the same block documents (amber park → outlined red delete → filled red terminate, `:5013-5022`) is drawn from two unrelated colour systems under `mirc-light` or any operator custom theme, and the escalation stops reading as one. (Overlaps C-S4 from the cicchetto agent, which found the same class on the admin controls.)
**Fix:** `#c00 → var(--adm-danger)`, `#c80 → var(--adm-warn)`, `#0a0 → var(--adm-ok)` across the eight rules. All three tokens exist with dark/light variants.

#### K-S7. The identity picker locks during an identity apply but not during a password save — same hazard, guarded on one member of the pair
**File:** shared target `cicchetto/src/SettingsDrawer.tsx:253-256`; picker `:1231-1240` with the rationale at `:1226-1228`; guarded member `:1213-1305` (save `:325-345`, flag `:262`); 🔴 unguarded member `:1307-1366` (save `:346-369`, flag `:284`) · **Severity:** MEDIUM
The picker's comment states the hazard: "Lock the target while an apply is in flight — the save captured a specific network; switching mid-reconnect would surface its result banner under the wrong row." `onSavePassword` has identical structure — captures `net` at `:350`, awaits a network-bouncing `updateNetworkPassword` at `:361`, sets `passwordSaved` at `:363` — but `passwordSaving()` is not in the `disabled` expression. Switch the picker during that await and "Password saved." renders while the selector reads a different network, on a card that (`:1307-1313`) shows no network name of its own and inherits its target implicitly from the card above. It is also the more dangerous half to mislabel: it writes the credential secret, and the operator cannot read back which network received it.
**Fix:** `disabled={identitySaving() || passwordSaving()}` at `:1234`. Consider rendering the target slug in the password card's heading.

#### K-S8. Fifteen inline `slug → Network` linear scans survive beside the memoized `networkBySlug` extracted to replace them
**File:** canonical `cicchetto/src/lib/networks.ts:235-243`; 15 sites in 9 files — `ArchiveModal.tsx:131`, `BanlistModal.tsx:70`, `ModeModal.tsx:126`, `WhoModal.tsx:210`, `NamesModal.tsx:75`, `SettingsDrawer.tsx:257`/`:295`/`:308`, 🔴 `MembersPane.tsx:104` (uses the memo at `:122`), 🔴 `ScrollbackPane.tsx:1334`/`:1341` (uses it at `:570`), 🔴 `lib/subscribe.ts:582`/`:895`/`:965`/`:1016` (uses it at `:221`) · **Severity:** MEDIUM
The three marked files are the tell: within one file both spellings live, so this is not an older layer awaiting migration — it is the divergence propagating into new code because whichever pattern was closest got copied. Semantics are identical, so this is consistency plus an O(N)-per-read cost, but it is 15 places to find the next time the lookup grows a rule (a soft-deleted or visitor-disabled network excluded from resolution), and the memo is the one that would get the rule.
**Fix:** Replace all 15; add a lint or `check.sh` grep so a sixteenth cannot appear.

### LOW

#### K-S9. `readCursor.ts` is the last unexplained hand-rolled identity-reset arm after `identityScopedStore` absorbed the pattern
**File:** factory `cicchetto/src/lib/identityScopedStore.ts:6-24`; 40 conforming members; 🔴 `cicchetto/src/lib/readCursor.ts:326-339`; documented exception `cicchetto/src/lib/subscribe.ts:129-133`, `:150-159` · **Severity:** LOW
Functionally correct (it does clear on rotation and logout), but its own comment points at five siblings — `scrollback`, `selection`, `members`, `mentions`, `compose` — that have all since moved onto the factory, so it is a copy of a pattern nobody else runs, and it is the shape a reader will imitate. `subscribe.ts` earned its exception in writing; this one has none.
**Fix:** `identityScopedStore((onIdentityChange) => { …; onIdentityChange(clearReadCursors); … })`, and drop the "mirrors" list.

#### K-S10. Comment pointers to files and counts that have moved on
**File:** `cicchetto/src/lib/pasteRoute.ts:187` + `src/__tests__/pasteRoute.test.ts:275` (name `paste-ime-flood-guard.spec.ts`; the file is `e2e/tests/issue1250-ime-paste-flood-guard.spec.ts`); `src/__tests__/wireValidate.test.ts:6` (names `wireNarrowAdminCorpus.test.ts`; the neighbours are `wireNarrow.test.ts` / `wireAdminBoundary.test.ts`); 🔴 `src/themes/default.css:4901-4907`; `src/lib/conversationMute.ts:9` ("three call sites" — there are five); `lib/grappa/networks.ex:585`, `lib/grappa/account_deletion.ex:26`, `lib/grappa_web/controllers/networks_controller.ex:494`, `lib/grappa/irc/client.ex:629` (reference `Networks.list_all_with_circuit_state/0`, `SessionController.require_registered_visitor/1`, `Visitors.maybe_reconnect_after_identity/1`, `Parser.strip_crlf/1` — none exist) · **Severity:** LOW
Method: extracted every backticked path (341 unique) and every backticked `Module.fun/arity` (929 unique) from `lib/` and `cicchetto/src/`, resolved each against the tree; twelve paths and ~12 project-internal functions did not resolve. The CSS one is the worst: it says `.live-badge` / `.alive` / `.none` / `.dead` "survive on the DOM only as the pre-existing vitest `classList` hook (`AdminVisitorsTab.test.tsx`, `AdminSessionsTab.test.tsx`)" — `AdminVisitorsTab.test.tsx` does not exist (the tab merged into Sessions at M-9b) and NOTHING asserts those classes, so the comment justifies keeping dead classes on a contract that is gone.
**Fix:** Correct the four cic pointers; delete the dead-class paragraph and the classes it protects. Consider a five-line CI step resolving backticked paths — it caught a comment justifying dead code.

### Families enumerated and found CLEAN (recorded so they are not re-derived)
`InlineConfirmButton` call sites (13) — **resolved** by #462's `.settings-drawer .inline-confirm-btn` scoping, i.e. the brief's canonical case is already fixed. Modal a11y across 17 modals; the 4 inline scrollback cards; the 4 telemetry sinks (detach-then-attach, `terminate/2`, `attach_telemetry:` opt); 20 `:persistent_term` DI seams (the 4 no-default reads each documented as deliberate); `action_fallback` across all controllers; migration version collisions (0 duplicates, none future-dated); silent narrowing on the server (9 `List.first` + 10 `hd` + 3 `Enum.at` — all documented deliberate, e.g. `representative_*_credential` anchors at `credentials.ex:464-491`, `resolve_visitor_network`'s `[anchor | _]` backed by `order_by: [asc: :slug]`); the two `list_user_names` fan-out mirrors (byte-identical, cross-referenced in both).

---

# Coverage — what this review did NOT cover

A review that does not declare its holes reads as complete and is not. Each agent reported its own
coverage; this is the consolidated list of what nobody read.

**Nothing was executed.** No `mix`, no `bun`, no docker, no test run, no `EXPLAIN QUERY PLAN`, no
`mix boundary.find_violations`, no Dialyzer. The compile and stack lanes belonged to another worker
for the duration, and the agents were instructed read-only. Every claim is derived from source and
from counted greps. Three findings would materially benefit from execution and say so in place:
persistence P-S1 and P-S4 (both index claims need `EXPLAIN QUERY PLAN` against a prod copy before
anyone acts), lifecycle L-S1 (the overflow threshold is stated from the OTP `math` contract, not
measured — the unbounded-counter half is directly readable), and cicchetto C-S1 (the stale-closure
consequences are traced through the code, not observed in a browser).

**Large files read in part, with the unread regions named.** `lib/grappa/session/server.ex` (7,230
lines) — the state type, `init/1`, the `handle_continue`/`terminate` path, the timer block, the
`apply_effects/2` head and tail, the terminal-failure numerics and the pending sweep were read; the
~50 send-verb `handle_call` arms and the mode/ban/WHO helper blocks were not. `event_router.ex`
(4,401) — the moduledoc, the full type block, `route/2` and the canonicalisation pipeline were
read; the ~50 `do_route/2` clauses were surveyed structurally and by targeted grep, not linearly,
and the eleven near-identical single-field WHOIS-leg folds were skimmed. `wire.ex` (1,778),
`numeric_router.ex` (1,142) and `isupport.ex` (682) — public-surface maps plus targeted reads.
`api.ts` (3,159) — the type declarations and the fetch boundary; not the ~80 REST helper bodies.
`ScrollbackPane.tsx` (3,985) — greppped for a11y and meta reads only; its scroll-settle and
unread-divider logic, the densest reactive code in the tree, deserves a pass of its own and did not
get one. `default.css` (12,822) — whole-file mechanical passes (every rule head mapped and
cross-referenced against all 587 sources, every `!important`, every colour literal, every tap
target, every animation against every reduced-motion block) plus ~700 lines read directly; the
layout and geometry bands were read only where a pass flagged them.

**Not covered at all.** `infra/freebsd/**` beyond the shebangs and the OPERATIONS.md account of the
rails — **this is the largest remaining gap, because prod is that jail**; twelve jail rails whose
documented contract reads as carefully thought through but was not verified against the code.
`infra/linux/**`, `infra/cloud/**`, `infra/packaging/**` and the CloudFormation template, read only
through the runbook. `Dockerfile.release` and `Dockerfile.shottino` (the brief scoped the root
`Dockerfile`), so the single-vs-multi-stage question is answered from the docs' argument rather
than from the files. `cicchetto/e2e/compose.yaml` (~750 lines), greppped only. The 30 bats suites
under `test/infra/` and 12 under `test/scripts/` were enumerated, not read — several "no gate
exists for X" claims rest on `grep -rln` over `test/`, and only D-S1, D-S5 and D-S18 were confirmed
by reading the specific suite. Server test bodies were sampled through two mechanical proxies
(`:sys.replace_state` and source-reading tests); "does this assertion mirror the implementation"
needs per-test reading and 106,905 lines of test code did not fit. The 78 migrations not read in
full — a defect confined to one backfill body would not have surfaced. `frontends/shottino`, which
`CLIENT_PROTOCOL.md` names as a second first-party client and which nobody checked against the
contract at all. Admin tab components beyond their type usage and dynamic class names.

**`docs/DESIGN_NOTES.md` was grepped per topic, never read linearly** — 42,708 lines, per the brief.
Every finding was checked against it before being reported, and several candidate findings were
dropped after reading the recorded rationale (named in place where that happened). It remains
possible that a finding here is blessed under wording no agent guessed at; the agents flagged their
own likeliest candidates. The HIGH findings are all code-vs-code or code-vs-published-doc, so they
do not depend on that.

**One scope-file correction.** The review skill lists `cicchetto/public/{manifest.json,sw.js}` —
**neither file exists**, and has not for some time. The manifest is generated by `VitePWA` from the
inline block in `vite.config.ts:130-180` (verified complete: `id`, `start_url`, `display`,
`theme_color`, `background_color`, icons via the shared `PWA_ICONS` SSOT, and the #1103
`share_target`), and the service worker is compiled from `src/service-worker.ts` in `injectManifest`
mode. `index.html` correctly carries no hand-written manifest link — the plugin injects it.

**One doc-reality gap this review owns rather than an agent.** `docs/checkpoints/` **does not
exist** in this tree, yet `docs/reviewing.md`, the review skill, `CLAUDE.md`'s `/start` protocol and
`docs/todo.md`'s closing line all direct a reader to it. Every agent was told to skip it. Either the
directory belongs back, or four documents need correcting.

---

# Trajectory

**What was built recently.** The last 26 days were dominated by client-side correctness and
release plumbing rather than new surface: the #1229 unread-exemption ceiling, the #1331 inline
reconnect at the parked seam, the #1321 push rejection-reason sink, the #1290 RFC 8291 push
transport pin, the #1315 account-beside-nick admin wire, #1322's settings reorganisation, #1323's
VAPID reconciliation, and the 1.2.0 cut with the #165 testnet unpin behind it. Throughput is high
and the theme is coherent: **hardening what shipped, not widening it.** 409 issues closed since
2026-08-01 against 44 open is a ratio that says the backlog is being worked, not accumulating.

**Does it serve the mission?** Yes, and unusually directly. Every one of those clusters is on the
bouncer↔client path — unread accounting, reconnect ergonomics, push delivery, the admin console an
operator actually uses. The infrastructure work in the same window (the nginx removal's aftermath,
the deploy-decision library, the `GRAPPA_CACHE_ID` cache split) is the kind that serves the product
rather than becoming it: it exists so multiple workers can gate concurrently, which is what made
this review's parallelism possible at all.

**What is stalling.** The 44 open issues skew heavily to one surface — **24 are labelled
`cicchetto`, 10 `bug`, 3 `tech-debt`** — and the oldest open items are all roadmap epics rather
than neglected work: #5 (multi-protocol BNC), #65 (OMEMO), #83 (AI-generated themes), #99/#101
(Phase 5 telemetry and scrollback eviction), #102 (the Phase 6 IRCv3 listener), #106 (voice).
Those are deliberately parked, not forgotten. What IS stalling is quieter and this review found it
twice: **declared follow-up slices that were scoped in a DESIGN_NOTES entry and never taken.** #429
emitted 162 runtime wire schemas and wired 3. #411's `as const` mechanism single-sourced the
message-kind set and left the window-state set hand-copied in six places. #415 promoted one schema
to a leaf boundary and left two populations on the older patterns. Each stopped at a defensible
boundary and each left the codebase teaching two answers to one question — which is the specific
condition CLAUDE.md says produces propagation by proximity.

**Risk check.** Three things are worth naming. (1) **Prod is the least-reviewed substrate.** The
FreeBSD jail's twelve rails were not read by anyone in this round, and the one env template with no
drift gate is the one prod uses. (2) **Several controls are asserted by documentation rather than
enforced** — the migration-version rule, `LongLivedModules`, the POSIX file set, `CLIENT_PROTOCOL.md`
— and in at least two cases the document over-claims what the gate covers, which is worse than no
gate, because a reviewer reads the sentence as an audit result. (3) `Session.Server` grew 54% in 26
days to 7,230 lines and 87 state keys with a 12,491-line test; hub *concentration* is flat, so this
is not a runaway, but the absolute width is now the coupling surface every session-touching change
must reason about, and it is the merge-conflict epicentre for concurrent worktrees.

**Recommendation.** Finish one migration completely before starting another. The wire codegen is
the highest-leverage candidate by a wide margin: it is built, gated, proved on the admin surface,
and it would retire findings on five of the six architecture concerns plus three cross-surface
HIGHs in the codebase review — and every week it stays half-adopted, the hand-written side grows.
Second, convert the four hand-maintained lists into gates; each is a ten-line test, and each
currently has a document claiming the gate already exists. Third, and cheapest of all: the
`canonical_*` doc sweep, because 51 references to two deleted functions — two of which now assert
the opposite of the live fold — is an active instruction to reintroduce the over-fold that #364,
#525 and #537 spent three clusters removing.
