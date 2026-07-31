# SQLite I/O baseline — BEFORE the 2026-08-01 ZFS-dataset migration

**Campaign:** GH #523 (ROOT A — SQLite write contention).
**Captured:** 2026-07-31 (pre-migration). Mirror of the #523 comment.
**Why this file exists:** on **2026-08-01** the m42 prod jail's SQLite DB moves
onto a dedicated ZFS dataset — `recordsize 64K` + SQLite `page_size 65536` —
replacing the CURRENT `page_size 4096` (SQLite default; never set in
`config/runtime.exs`) on a `recordsize 128K` dataset. **Any I/O/latency number
taken AFTER the move is not comparable to one taken before.**

**vjt ruling (#grappa, 2026-07-31 22:03):** *"mi sembra eccessivo l'rpc, sti
cazzi evita"* — **no `Code.eval_file` on the production BEAM, no micro-bench.**
The baseline is therefore **host-side read-only only** (`zfs get`, `ls`) + what
the source already tells us. The re-runnable probe (`scripts/zfs_baseline.exs`)
stays in the tree for the day someone IS authorised to run it; **it was not run.**

---

## Current storage config (the axis the migration changes)

| Knob | BEFORE (this baseline) | AFTER (2026-08-01) |
|------|------------------------|--------------------|
| SQLite `page_size` | **4096** (default, unset in config) | 65536 |
| ZFS `recordsize` (DB dataset) | **128K** | 64K |
| SQLite pages per ZFS record | **32** (128K ÷ 4K) | **1** (64K ÷ 64K) |

Dataset `tank/bastille/jails/grappa/root` (the jail root, where the DB lives):

| property | value | source |
|---|---|---|
| `recordsize` | 128K | default |
| `compression` | `on` (pool `tank`: `lz4`) | local |
| `atime` | `off` | local |
| `sync` | `standard` | default |
| `logbias` | `latency` | default |
| `primarycache`/`secondarycache` | `all` | default |

Pinned app-side SQLite config (`config/runtime.exs` `Grappa.Repo`, unchanged by
the migration — kept so the diff isolates the storage axis): `journal_mode: :wal`,
`synchronous: :normal`, `busy_timeout: 30_000`, `cache_size: -64_000` (64 MB),
`temp_store: :memory`, `foreign_keys: :on`, `pool_size: 10` (or `POOL_SIZE`).
Deps @ capture: `exqlite 0.38.0`, `ecto_sqlite3 0.24.1`, `ecto_sql 3.14.0`.
Prod DB path: `/home/grappa/grappa/runtime/grappa_prod.db`.

---

## Captured numbers (2026-07-31, host-side read-only — the DB was never opened)

| file | bytes | |
|---|---|---|
| `grappa_prod.db` | **771,121,152** | ~735.4 MiB, mtime 20:04 |
| `grappa_prod.db-wal` | 16,142,192 | ~15.4 MiB |
| `grappa_prod.db-shm` | 32,768 | |

Jail root: 3.4G used of 61G.

### The number that matters, and it needs no benchmark

- DB size ÷ page size = **188,262 SQLite pages** (771,121,152 ÷ 4096).
- ZFS record ÷ SQLite page = **32 pages per record** (128K ÷ 4K).

So today **every random 4K page write dirties a 128K ZFS record** — a
read-modify-write of 32× the payload, and with `compression=lz4` that record is
decompressed and recompressed on the way through. After the migration
(`recordsize 64K`, `page_size 65536`) the ratio becomes **1 page per record**:
a page write maps onto exactly one record and the read-modify-write disappears.

This is the storage-side mechanism BEHIND ROOT A. `SQLITE_BUSY` is a *symptom* of
writers holding the file write-lock longer than they should; a 32× write
amplification on every dirty page is exactly what stretches that hold time under
concurrency.

---

## What this baseline honestly does NOT establish

Stated plainly so nobody over-reads it later:

- **No timing numbers.** Without the micro-bench there is NO measured commit
  latency. The pre/post comparison is **structural and analytical, not
  empirical** — we can say the amplification ratio goes 32:1 → 1:1; we CANNOT say
  "commits got N% faster" from this data.
- The passive `DbLatency` window (#357) was not sampled either (also needed rpc).
- Consequently the **#523 fix must be justified on its OWN merits** — a transient
  `SQLITE_BUSY` must not surface as a 500 — **not on a benchmark delta.** The
  storage migration and the busy-retry fix are two independent improvements that
  happen to touch the same symptom.

---

## The re-runnable probe (NOT run — for future authorised use)

`scripts/zfs_baseline.exs` captures, when run on the LIVE m42 node: (1) storage
config header + file sizes, (2) a `DbLatency` window (#357), (3) an opt-in commit
micro-bench (single-row `BEGIN IMMEDIATE` tx on a throwaway DB on the same
dataset). Per the ruling above it is **not to be run against prod without explicit
authorisation** (the rpc runs code on the production BEAM; the micro-bench fsyncs
on the live dataset). It exists so a future authorised run — e.g. AFTER the
migration for an empirical A/B — uses the IDENTICAL method (the script self-reads
the live `page_size`, so the micro-bench auto-tracks the new value). Invocation +
mitigations (`ZFS_BASELINE_MICRO_PACE_MS`) are documented in the script header.
