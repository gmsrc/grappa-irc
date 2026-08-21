# Issue Pipeline — users → ircbot → orchestrator → worker

The standing operating model for the always-on grappa development loop (vjt,
2026-06-29). Replaces the earlier fixed "issue pack" framing: issues now arrive
as a **continuous stream**, triaged and executed continuously.

## Roles

- **Users** — on IRC (#grappa et al.) report bugs/requests.
- **ircbot** ("vjt-claude", live on azzurra) — receives user issues, **triages**
  them, **creates the GitHub issue** (`vjt/grappa-irc`), and **enqueues it by
  setting the `status:queued` label** — that label IS the build queue. The ircbot
  does NOT implement. It **no longer hands issues over by pinging the
  orchestrator**: setting `status:queued` is the handover — the orchestrator
  self-serves from that label set (see below). vjt may enqueue an issue the same
  way. (Exception: a genuine drop-everything emergency may still be flagged to the
  orchestrator explicitly — but normal work flows through the label, not a ping.)
- **orchestrator** ("grappa-orch") — at the **end of each round** (worker free,
  nothing in flight) **pulls the open `status:queued` set directly from GitHub**,
  picks the next issue per the placement rules below, moves it
  `status:queued → status:cooking`, and drives the worker through it end-to-end
  (close at the merge + ship + announce, removing the `status:*` label on close).
  Does NOT implement. The `status:queued` set IS the queue — there is no separate
  hand-managed list, so the grappa.chat WIP board and the queue are one artifact.
- **worker** ("grappa-worker") — the sibling Claude that implements ONE issue at
  a time in a git worktree, under the orchestrator's direction.

## Picking the next issue (orchestrator, at end of round — no need to ask per issue)

At the end of each round the orchestrator reads the open `status:queued` issues
(`gh issue list --state open --label status:queued --json number,title,labels`)
and picks ONE to dispatch:

1. **Critical bug → first, but never preempt.** A `P0` bug in the queued set is
   dispatched next — but it **never interrupts work already in flight**. The
   in-flight issue always finishes first.
2. **Otherwise → oldest first (FIFO).** Absent a P0, take the lowest-numbered
   queued issue. **No exceptions.**
   🔴 There used to be a *"similarity → group"* rule above this one, preferring a
   queued issue adjacent to what just shipped so related changes reuse context.
   vjt deleted it on 2026-08-20 (#1632): it legitimised skipping the queue
   whenever the next issue *looked* adjacent, and that is the hole through which
   recent issues got picked ahead of old ones. **Picking is absolute FIFO** —
   adjacency is not a reason to jump the queue, and "these two touch the same
   file" is not a placement rule.
3. The orchestrator applies these itself. It escalates to vjt only for genuine
   ambiguity / design forks / scope questions — not for routine placement. When the
   `status:queued` set is **empty**, it goes idle / asks vjt "what next?" rather
   than inventing work.

On dispatch it moves the chosen issue `status:queued → status:cooking`; the label
transitions ARE the queue's state, so the WIP board always reflects the real queue.

## Label state machine (the ONLY legal transitions)

vjt, 2026-08-07: *"non ci inventiamo le transizioni allucinate"*. There are three
states and two transitions. Nothing else exists.

```
status:queued  ──▶  status:cooking  ──▶  closed
   (ircbot          (orchestrator        (MERGED to origin/main)
    enqueues)        dispatches)
```

- **`status:queued`** — triaged and enqueued by the ircbot. Nobody is working on it.
- **`status:cooking`** — a worker holds it. It is in flight *right now*.
- **closed** — **the work is MERGED to `origin/main`.** Not deployed, not
  released: merged. vjt, 2026-08-20: *"si chiudiamo al merge"* (#1632).

🔴 **`status:soon` is DEAD (#1632).** It was the fourth state — "merged, awaiting
release" — and nothing sets it any more. Measured at its removal: 75 open
`status:soon` issues, **71 of them already in milestone 1.3**, and **zero
`status:soon` issues had ever been closed** in the whole history of the repo.
The label still exists on GitHub (deleting it is a separate, irreversible call
for vjt) but an issue carrying it is drift.

⚠️ **The MILESTONE is a PLANNING label, not a shipping record (vjt, 2026-08-21).**
It says which release the work is **INTENDED** to go out in — an intention that
may still change, because vjt dogfoods on staging before committing to a release.
It is **NOT** a promise about which tag contains the code, and reading it as one
is exactly the mistake this note exists to prevent.

🔴 **A merge-closed issue therefore NAMES NO RELEASE, and that is an accepted
price, not an oversight.** At the merge the tag does not exist yet. The duty to
tell a reader **which tag to pull** is not discharged here, and the milestone does
not discharge it either: it is discharged **at the release cut**, by the tag and
its release notes — a later moment, and the final `vX.Y.0` cut is vjt's.

ℹ️ **Deliberately unspecified:** WHEN a milestone is assigned, and when it may be
moved. vjt has not given that rule, so this doc does not invent one.

Rules:

- The **orchestrator owns every transition**. The ircbot only sets `status:queued`
  at intake, and otherwise measures and reports drift — it does not relabel.
- **Advance the label in the same step that causes it.** Merging without closing
  makes the board lie; a board audit on 2026-08-07 found nine issues stuck at
  `cooking` with their change already merged.
- 🔴 **A merge that covers only ONE LEG of a multi-part issue does NOT close it.**
  #96 shipped one leg of three and vjt said explicitly the rest stays open. Epics
  and multi-leg issues close **leg by leg, when the last leg lands** — check each
  one before closing. (This caveat used to live at release-cut time in
  `docs/OPERATIONS.md`; closing moved to merge, so the caveat moved with it.)
- **Do not invent intermediate states.** No `status:review`, no `status:blocked`
  improvised on the spot; if a real new state is needed it goes in this doc first.

## Per-issue execution flow (NO pull request)

```
worktree (branch off local main)
  → implement  (TDD: failing test first; a REAL e2e asserting the visible outcome)
  → gates green (ONE check.sh — never concurrent runs; if waiting on a bg run use a
                 log-pattern Monitor WITH a timeout, never a self-matching pgrep loop)
  → rebase onto main → merge to main → push origin main
  → gh issue close  (AT THE MERGE — multi-leg issues wait for their last leg)
  → deploy m42 (auto hot/cold; add --cic when cic was touched)
  → announce #grappa (fire-and-forget via the ircbot — brief once, move on)
```

- **No PRs.** Worktree + merge + push + deploy. ("No commit *directly* to master"
  is satisfied by the worktree branch; the branch still merges to master — there is
  just no PR step.)
- **Feature boundary → full clear-cycle** of the worker (fresh session per issue;
  self-contained brief staged to `/tmp/orchestrate-next.txt`).
- **A red `integration`/e2e CI job BLOCKS** — never ship on red.
- **Announces are fire-and-forget** — brief the ircbot once; do not poll/verify.

## Why this doc

So the orchestrator and the ircbot share one clear contract: the ircbot triages +
creates + **enqueues (`status:queued`)**; the orchestrator **pulls the queued set
each round** + executes + ships. The label is the sole handover — no ping. Both
read this file (absolute path `/srv/grappa/docs/ISSUE_PIPELINE.md`).
