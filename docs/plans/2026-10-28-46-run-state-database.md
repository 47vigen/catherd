# Plan 46 — the run state in one database (architect-led runs, stage 1, slice 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Never read the whole plan: take your task brief.

Setup: bun install --frozen-lockfile

**Goal:** a run's events, dispatch records and team messages live in one SQLite database that every catherd process opens, earlier runs stay readable where they are and are copied in for cross-run queries, and the database is backed up at each run's end.

**Architecture:** one new infra module, `src/infra/db.ts` (Bun's built-in `bun:sqlite`, no dependency), with ordered migrations under `PRAGMA user_version`. The three stores keep their function signatures (`readEvents`/`appendEvent`/`withEventsLock`, `readRecords`/`appendRecord`, `teamMessages`/`teamSend`), so no caller changes beyond three that read the events file's bytes. Per store, a store file an earlier build left in the run folder stays that run's store; every other run writes rows. Then a read-only import copies finished earlier runs in as `legacy = 1`, and the run's end writes a `VACUUM INTO` backup.

**Tech stack:** Bun ≥ 1.4 (`bun:sqlite`), TypeScript, zod.

**Spec:** `docs/specs/2026-10-27-architect-led-runs-design.md` — D13 (machine state), D16 (migration), D17 stage 1. Plan 46 is the first slice of stage 1; the rest of stage 1 is plans 47–51 ("Next plans" below), in an order where every deletion follows its replacement.

Why this slice first: D2's ledger, D3's thread tools and D10's caps and stall fingerprints are all rows of this database, and D17 measures every stage as queries over it. Nothing in stage 1 can land its replacement before the store it writes to exists. This slice deletes nothing a later plan needs, and changes no behaviour a role or the owner sees.

## Global Constraints

- Version stays 2.0: each milestone's changeset is `"catherd-cli": minor`; 2.0 is unreleased (`latest` is 1.5.0).
- No new dependency: `bun:sqlite` only. The database is `<catherd data dir>/catherd.db` (`dataDir()`), 0600, `busy_timeout=5000`, `journal_mode=WAL`, `foreign_keys=ON`.
- A database newer than the binary is refused with `E_CONFIG_NEWER_SCHEMA`, message `<file> has schema <n>, newer than this catherd (<m>)`, fix `upgrade catherd: <UPGRADE>`.
- Layers `domain → infra → adapters → services → entry` (test/architecture.test.ts): SQLite lives in `src/infra/db.ts`; services call it; the domain never does.
- Configuration stays files (D13): profiles, config, repo bindings, the workspace registry, knowledge. `src/infra/store.ts` and ProfileService are untouched.
- Documents stay files: plan, lanes, briefs, replies, reports, logs, digests. A row never holds a document's body.
- An earlier build's run folder is never written by the import. A run an earlier 2.0 build started keeps working on its own files (Ruling R1).
- Tests never reach the network and never sleep on the wall clock for correctness. Each test's database is its `withHome()` data dir's.
- No personal hosts or product names in code, tests or docs. web/ and web/openapi.json do not change.
- Commits: conventional, subject ≤ 100 characters, lower-case first word. The full root suite takes about 280 s: `catherd lock -- bun test`.

## Review Focus

1. Three processes (the run's daemon, the session's MCP server, a `catherd` CLI) append to one run at once: seqs stay dense 1..n, nothing fails `SQLITE_BUSY` (Task 2, "appends dense seqs from two processes at once").
2. This build is installed while an earlier build's run is in flight: `answer`, `cancel` and team messages append to that run's `events.jsonl` and `team.jsonl`, and `status` and the panel read it as before (Task 2, Task 4; Ruling R1).
3. A run created by a plan-46 M1 build (events in the database, a `runs.jsonl` header file) is read by an M2 build: its records stay in its `runs.jsonl` (Task 3, "skips a crash-truncated tail of an earlier build's runs.jsonl").
4. A database a newer catherd wrote: refused, with no migration applied over it (Task 1).
5. The import meets a half-written or corrupt earlier run folder: reported and skipped, none of it imported, the folder byte-for-byte unchanged (Task 5).

## What already exists

- src/services/run-events-store.ts — `eventsFile`, `isDaemonRun` (`existsSync(events.jsonl)`), `readEvents(run, fromSeq)` (dense seq check, torn tail, `E_RUN_CORRUPT`, `E_RUNTIME_TOO_OLD` via `decode`), `replayRun`, `lastSeq` (file tail), `withEventsLock(run, fn)` (file lock `events.jsonl.lock`, `fn` may be async: src/services/run-client.ts:120), `writeEvents`, `appendEvent`, `appendEvents`, `tailEvents` (polls `readEvents` by seq; the panel's live view, src/entry/panel/server.ts:586).
- Raw reads of the events file outside the store: src/services/daemon.ts `hasEnded` (68, file `includes('"type":"run.ended"')`), src/services/notifier.ts `enqueueReports` (517, `statSync(eventsFile(run)).size` as a change key), src/services/run-index.ts (166, `stamp(eventsFile(run))` as the cache key).
- src/services/run-store.ts — `runPaths` (`runs`, `outcomes`, `routes`, …), `createRun` (writes the `runs.jsonl`, `routes.jsonl`, `agents.jsonl` headers at 162–164), `readRecords` (243, `readJsonl`, first record per `dispatchId` wins, `corrupt` counts bad rows), `appendRecord` (260, under `withFileLock(runs.jsonl)`), `recordsOnThread`, `runFile`. Locks keyed on `runPaths(run.dir).runs` also in src/services/admission.ts:287, workspace-admission.ts:41/73, lane-service.ts:267 (a lock file `runs.jsonl.lock`; the target itself is never created by the lock).
- src/services/session-view.ts `runActivity` (stats `state.json`, `runs.jsonl`, `state.md`, `agents.jsonl`). src/services/run-service.ts `readRunFile` (244). src/services/team.ts — `TEAM_FILE`, `teamMessages`, `teamSend` (numbers under `withFileLockSync(team.jsonl)`), `teamRead`, `teamWait`, `teamLast`, `teamFor`.
- src/services/run-effects.ts `finish` (1406–1417: report, `run.ended`, `refreshState`). src/entry/mcp/server.ts `oninitialized` (the leading server runs `reconcileAll` at 239).
- src/infra/paths.ts `dataDir()`; src/infra/store.ts `ensurePrivateDir`, `PRIVATE_FILE`; src/domain/errors.ts `UPGRADE`, `errorMessage`. test/helpers.ts `withHome()`; test/services/helpers.ts `freshRun()`; test/domain/run-fixtures.ts `makeLog`, `startedFields`; test/domain/make-record.ts `makeRecord`.

## Contracts

```ts
// src/infra/db.ts
export const MIGRATIONS: readonly string[]; // index i is user_version i+1; M1 ships 1, M2 adds 2
export const dbFile: () => string; // join(dataDir(), "catherd.db")
export function openDb(file: string): Database; // uncached: 0600, pragmas, migrations; newer → E_CONFIG_NEWER_SCHEMA
export function db(): Database; // openDb(dbFile()), cached per path (a test's withHome() gives a new one)
export function ensureRunRow(
  d: Database,
  run: { id: string; dir: string; meta: { repo: string; createdAt: string } },
  legacy?: boolean, // false
): void; // INSERT OR IGNORE INTO runs
export function insertEvent(d: Database, runId: string, e: RunEvent): void;
export function insertDispatch(d: Database, runId: string, r: RunRecord): void; // M2
export function insertMessage(d: Database, runId: string, m: { n: number; at: string; from: string; to: string; text: string }): void; // M2
export function backupDb(now?: Date): string; // M3: <data dir>/backups/catherd-<YYYY-MM-DD>.db, last 7 kept

// src/services/run-events-store.ts (M1); every existing export keeps its signature
export function lastEventSeq(run: Run): number; // 0 for none
export function hasRunEnded(run: Run): boolean;

// src/services/legacy-import.ts (M3)
export function importLegacyRuns(): { imported: string[]; skipped: { id: string; reason: string }[] };
```

The two migrations, exact (D13 names; `body` is the row's whole JSON, the columns are what a query filters on):

```sql
-- 1 (M1)
CREATE TABLE runs (id TEXT PRIMARY KEY, dir TEXT NOT NULL, repo TEXT NOT NULL, created_at TEXT NOT NULL,
  legacy INTEGER NOT NULL DEFAULT 0);
CREATE TABLE events (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL,
  type TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL, UNIQUE (run_id, seq));
-- 2 (M2)
CREATE TABLE dispatches (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
  dispatch_id TEXT NOT NULL, role TEXT NOT NULL, lane TEXT, rung TEXT NOT NULL, status TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT NOT NULL, cost_usd REAL, body TEXT NOT NULL,
  UNIQUE (run_id, dispatch_id));
CREATE TABLE messages (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), n INTEGER NOT NULL,
  at TEXT NOT NULL, sender TEXT NOT NULL, target TEXT NOT NULL, text TEXT NOT NULL, UNIQUE (run_id, n));
```

## Rulings

Each is `Ruling: <what> — <why> — <cost if wrong>`. They bind every task.

- R1 — Ruling: each store chooses per run and per file: when the run folder holds that store's file (`events.jsonl`, `runs.jsonl`, `team.jsonl`), the file stays that run's store, read and appended as before; otherwise the database. `createRun` stops writing the `runs.jsonl` header (M2). D16's refusal to drive an earlier build's run is not taken here: the event schema does not change in plan 46, so such a run keeps working, and the refusal lands with the schema change (plan 48) — no meta flag, no per-run migration, and runs in flight across every M1/M2/M3 `next` snapshot stay whole — a stray store file in a new run's folder hides that run's rows (nothing in this build writes one).
- R2 — Ruling: `events` keeps a global `id INTEGER PRIMARY KEY` and the per-run dense `seq` with `UNIQUE (run_id, seq)`, where D13 sketches `seq` as the primary key — replay, the panel's since-cursor (`tailEvents`) and every event's own `seq` field are per run — one more column.
- R3 — Ruling: a row stores its whole validated JSON in `body` plus the columns a query filters on; reads parse `body` — the event and record schemas change through stage 1 and the body stays their one source — the columns duplicate fields of the body.
- R4 — Ruling: the existing lock files stay the writers' mutual exclusion (`events.jsonl.lock`, `runs.jsonl.lock`, `team.jsonl.lock`); each write is one `BEGIN IMMEDIATE` transaction inside the lock — `withEventsLock` holds across awaits (run-client.ts:120) and admission holds `runs.jsonl.lock` across its pending check, which no SQLite transaction can — two mechanisms until plan 48 makes the reducer's writes single transactions and drops the lock.
- R5 — Ruling: plan 46 moves `runs`, `events`, `dispatches` and `messages`. `outcomes.jsonl` and `routes.jsonl` stay files: routing writes both and plan 49 shrinks routing to ladders, so they are deleted rather than migrated. `state.json`, `sessions.jsonl`, `agents.jsonl`, `harness.jsonl` and the workspace's `meta.json` stay files until their mechanisms move or go. D13's `checks`, `merges`, `caps`, `questions`, `ledger_*` and `memory_outbox` tables arrive with the tools that write them — prefer deleting a mechanism to migrating it — two stores side by side until plan 51.
- R6 — Ruling: `messages` holds today's team message only (`n`, `at`, sender, target, text); D13's `kind`, `mode` and `delivered_at` come with `thread_send` (plan 47) — no column without a writer — plan 47 adds a migration.
- R7 — Ruling: the import runs at the leading MCP server's boot, before `reconcileAll`, and takes every run folder with an `events.jsonl` holding `run.ended` and no `runs` row; it copies events, records and messages in one transaction per run with `legacy = 1`; that run's own reads stay on its files. A folder that cannot be read (a corrupt meta.json, a corrupt events line) is printed `catherd: not imported <id>: <reason>` and skipped — the session server is the one process every owner starts, and the boot lock gives one importer — a run that finishes on an old build is imported at the next session's boot, not at once.
- R8 — Ruling: an earlier run's checks are imported as their events; there is no `checks` table yet (R5) — the D17 check-minutes query reads `check.*` events until plan 47's `check` tool writes rows.
- R9 — Ruling: the backup is `backups/catherd-<UTC date>.db`, written to a temp name and renamed; a second run ending the same day replaces that day's file; the 7 newest names stay; a failed backup is logged (`warn`, `backup`) and never fails the run's end — D13 asks for one copy per run end and the last 7 kept; seven days covers a week of runs — on a day with many runs only the last end is kept.
- R10 — Ruling: `readRunFile` serves `events.jsonl` and `runs.jsonl` from rows (one JSON line each) when the run has no such file — the rules-review brief (run-briefs.ts:489) and the report's pointers name them as files, and a role reads run files through `read_run_file` — an export per read, gone when plan 49 deletes the rules review.
- R11 — Ruling: no SQL views, metric queries or `catherd` command over the database in plan 46: `sqlite3 <data dir>/catherd.db` answers an ad-hoc question; D17's metrics, compared per task over at least two runs each (the spec's amended D17), are plan 51's — YAGNI until a stage is measured — stage 0 vs stage 1 numbers wait for plan 51.
- R12 — Ruling: each milestone carries its own changeset and its own docs, because each merges on its own and publishes a `next` snapshot — three changesets for one plan.

## Parallelism

- M1: Task 1, then Task 2 (Task 2 uses `db()` and `insertEvent`).
- M2 (after M1 merges): Task 3, then Task 4 (both add to db.ts; Task 3 owns migration 2).
- M3 (after M2 merges): Task 5 and Task 6 at once (Task 5: legacy-import.ts and server.ts; Task 6: db.ts `backupDb`, run-effects.ts, docs).

## M1 — The database, and the event log in it

A1 — a run started by this build keeps its events in `<data dir>/catherd.db` and writes no `events.jsonl`; `status`, `result`, the panel and replay read them as before (Check).
A2 — a run an earlier build started keeps its `events.jsonl`, read and appended there (Check).
A3 — a database a newer catherd wrote is refused with `E_CONFIG_NEWER_SCHEMA` (Check).

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 1: The database module

Files: src/infra/db.ts (new), test/infra/db.test.ts (new)

`MIGRATIONS` holds migration 1 (Contracts). `openDb(file)`: `ensurePrivateDir` its folder; `new Database(file, { create: true, strict: true })`; `chmodSync(file, PRIVATE_FILE)`; `PRAGMA busy_timeout = 5000`, `journal_mode = WAL`, `foreign_keys = ON`; read `user_version`; above `MIGRATIONS.length`, close and throw (Global Constraints); else for each missing `v`, in one `db.transaction(...).immediate()`, re-read `user_version` (a second process may have migrated), skip when it is past `v`, `db.run(MIGRATIONS[v])`, `PRAGMA user_version = v + 1`. `db()` caches `openDb(dbFile())` in a `Map` by path. `ensureRunRow` and `insertEvent` per Contracts (`insertEvent` writes `e.seq`, `e.type`, `e.at`, `JSON.stringify(e)`). The doc comment names spec D13.

- [ ] Write the test; `bun test test/infra/db.test.ts` fails (no module).

Test: test/infra/db.test.ts — describe "the database (plan 46, spec D13)":
- "opens once per data dir, private, in WAL, with every migration applied" — `withHome()`; `db()` twice is the same object; `statSync(dbFile()).mode & 0o777` is `0o600`; `PRAGMA journal_mode` → `{ journal_mode: "wal" }`, `foreign_keys` → `{ foreign_keys: 1 }`, `user_version` → `{ user_version: MIGRATIONS.length }`; after a second `withHome()`, `db()` is another object.
- "refuses a database a newer catherd wrote" — `openDb(f).run(\`PRAGMA user_version = ${MIGRATIONS.length + 1}\`)`; `openDb(f)` throws `{ code: "E_CONFIG_NEWER_SCHEMA", message: stringContaining("newer than this catherd") }`.
- "applies only the migrations a database lacks" — open and close `f`, open again: `user_version` is `MIGRATIONS.length`, `SELECT count(*) AS n FROM runs` → `{ n: 0 }`.

- [ ] Implement; the test passes; `bun run typecheck && bun run lint && bun test test/architecture.test.ts`.
- [ ] Commit (suggested): `feat(db): one sqlite database for run state, migrated by user_version`

### Task 2: The event log in the database

Files: src/services/run-events-store.ts, src/services/daemon.ts, src/services/notifier.ts, src/services/run-index.ts, src/services/run-service.ts, README.md, plugin/skills/catherd/SKILL.md, MIGRATION.md, .changeset/plan-46-event-log-database.md, test/services/run-events-store.test.ts, test/services/run-effects.test.ts, test/services/lanes-run.test.ts

run-events-store.ts: a private `onFile(run) = existsSync(eventsFile(run))` (R1). `isDaemonRun` is `onFile(run) || SELECT 1 FROM events WHERE run_id = ? LIMIT 1`. `readEvents` with no file reads `SELECT seq, body FROM events WHERE run_id = ? AND seq >= ? ORDER BY seq` and decodes each body with the existing `decode` (a newer `v` still throws `E_RUNTIME_TOO_OLD`; a body that is not an event throws `corrupt(run, seq - 1, "a row is not an event")`). `lastEventSeq` is `lastSeq` on a file run, else `MAX(seq)` (0 when null). `hasRunEnded` is the file check moved from daemon.ts on a file run, else `SELECT 1 … AND type = 'run.ended'`. `writeEvents` on a file run is unchanged; else, in one `.immediate()` transaction: `ensureRunRow(d, run)`, stamp from `lastEventSeq(run) + 1`, `insertEvent` each. `withEventsLock`, `appendEvent(s)` and `tailEvents` do not change (R4). Doc comments: `eventsFile` is "the store of a run an earlier 2.0 build started"; `isDaemonRun` "a 2.0 run has events".

Callers: daemon.ts drops its `hasEnded` for `hasRunEnded`; notifier.ts `enqueueReports` keys on `lastEventSeq(run)` instead of the file size; run-index.ts's key starts `${lastEventSeq(run)}|` instead of the events file's stamp (its doc: "recomputed when the run's last event seq or its runs.jsonl's mtime and size change"). run-service.ts `readRunFile`: a map `ROWS_AS_FILE = { "events.jsonl": (run) => readEvents(run) }`; when the file is absent and the path is in the map, return one `JSON.stringify` line per row (R10).

Docs: README.md's "lands each milestone from the run's own `events.jsonl`" reads "…from the run's event log in catherd's database"; plugin/skills/catherd/SKILL.md's "writes everything it does to the run's `events.jsonl`" reads "…to the run's event log"; MIGRATION.md, under "From 1.5 to 2.0", a new "### Run state moves to one database (plan 46)": a run this build starts keeps its events in `<data dir>/catherd.db` (SQLite, WAL); a run an earlier build started keeps its `events.jsonl` and finishes as before; `catherd run-file read <run> events.jsonl` still prints a run's events. Changeset: `"catherd-cli": minor` — "A run's event log lives in one SQLite database, `catherd.db` in catherd's data folder, instead of its folder's `events.jsonl`; runs an earlier build started keep their files."

- [ ] Write the tests; run `bun test test/services/run-events-store.test.ts test/services/run-effects.test.ts test/services/lanes-run.test.ts`: the new and changed tests fail.

Test: test/services/run-events-store.test.ts —
- "stamps v, seq and at, and keeps a new run's events in the database, never in events.jsonl" (replaces "…and keeps the file private") — `appendEvent(run, started, 2026-10-21T10:00Z)` → `{ v: 1, seq: 1, type: "run.started" }`; no `events.jsonl`; `SELECT seq, type, body FROM events` → `[{ seq: 1, type: "run.started", body: JSON.stringify(e) }]`; the `runs` row `{ dir: run.dir, legacy: 0 }`; `replayRun(run).title` is `"t"`; `lastEventSeq` 1; `hasRunEnded` false.
- "keeps an earlier build's run on its events.jsonl, read and appended there (plan 46)" — the file holds `line(1)`; `appendEvent(run.ended)` gets seq 2 and is the file's second line; no `events` row for the run; `lastEventSeq` 2; `hasRunEnded` true.
- "refuses a database row that is not an event" — an inserted row `(seq 2, body 'not json')` → `readEvents` throws `E_RUN_CORRUPT`.
- "appends dense seqs from two processes at once" — two `Bun.spawn([process.execPath, "-e", <append 20 ticks to findRun(id)>], { env: { ...process.env, ANTHROPIC_API_KEY: "" } })`, awaited together → `readEvents(run).map((e) => e.seq)` is 1..40.
- The other existing tests ("appends dense seqs from concurrent writers", "reads from a seq", "is not a 2.0 run until its first event", the torn-line, chunk and newer-`v` cases that write the file first) pass unchanged.
Test: test/services/run-effects.test.ts — "rethrows when the effect.failed event cannot be written, so the daemon hears of it": in place of the `chmodSync(eventsFile(run), 0o444)`, `db().run("CREATE TEMP TRIGGER no_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'read-only'); END")`, dropped in `finally`.
Test: test/services/lanes-run.test.ts — "reads a run's events as the file an earlier build kept (plan 46)" — after `appendEvent(run, { type: "tick" })`, `readRunFile({ run: run.id, path: "events.jsonl" })` is `` `${JSON.stringify(e)}\n` ``.

- [ ] Implement; the same command passes; then the full Check.
- [ ] Commit (suggested): `feat(events): a run's event log lives in the database`

### M1 lanes

- M1.L1 — Task 1 — owns src/infra/db.ts, test/infra/db.test.ts — fast check: `bun test test/infra/db.test.ts test/architecture.test.ts && bun run typecheck && bun run lint`
- M1.L2 — Task 2 — after M1.L1 — owns the files Task 2 lists — fast check: `bun test test/services/run-events-store.test.ts test/services/run-effects.test.ts test/services/lanes-run.test.ts test/services/daemon.test.ts test/services/notifier.test.ts test/entry/panel-server.test.ts && bun run typecheck && bun run lint`

## M2 — Dispatch records and the team channel in the database

A1 — a run started by this build keeps its dispatch records and team messages in the database and writes no `runs.jsonl` or `team.jsonl`; budgets, the land gate, `status` and briefs read them as before (Check).
A2 — a run whose folder has a `runs.jsonl` or a `team.jsonl` keeps reading and appending there (Check).

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 3: Dispatch records

Files: src/infra/db.ts, src/services/run-store.ts, src/services/session-view.ts, src/services/run-index.ts, src/services/run-service.ts, test/infra/db.test.ts, test/services/run-store.test.ts, test/services/dispatch.test.ts, test/services/workspace.test.ts, test/services/workspace-land.test.ts, test/services/ledger.test.ts, test/services/land-gate.test.ts, test/services/lanes-run.test.ts

db.ts: migration 2 (Contracts, both tables); `insertDispatch` writes `dispatchId, role, lane, rung, status, startedAt, endedAt, costUsd` and the body. run-store.ts: `createRun` no longer writes the `runs.jsonl` header (`routes` and `agents` keep theirs). `readRecords` reads the file when it exists, else a private `dispatchRows(run)`: `SELECT body FROM dispatches WHERE run_id = ? ORDER BY id`, each body `JSON.parse`d, a body that does not parse counted in `corrupt` (the land gate refuses on `corrupt`, as for a torn file row); the dedupe and the `host` default below it are unchanged. `appendRecord` keeps its lock and its "existing record wins" read; it appends to the file when the file exists, else `ensureRunRow` + `insertDispatch` in one `.immediate()` transaction; its doc adds "A run an earlier build started keeps its runs.jsonl; every other run's records are `dispatches` rows (plan 46, D13)." session-view.ts `runActivity` also takes the newest `endedAt` of `readRecords(run).records`. run-index.ts's key gains `|${readRecords(run).records.length}`. run-service.ts's `ROWS_AS_FILE` gains `"runs.jsonl": (run) => readRecords(run).records`.

- [ ] Write the tests; run `bun test test/infra/db.test.ts test/services/run-store.test.ts test/services/dispatch.test.ts test/services/workspace.test.ts test/services/workspace-land.test.ts test/services/ledger.test.ts test/services/land-gate.test.ts test/services/lanes-run.test.ts`: the changed tests fail.

Test: test/services/run-store.test.ts — "creates meta, ledger header, JSONL headers and the lanes, roles and shots folders, and no runs.jsonl" (the `runs.jsonl` header assertion becomes `existsSync(...runs)` false); "skips a crash-truncated tail of an earlier build's runs.jsonl and keeps every row after it whole" — writes the header `{"schema":1,"kind":"runs"}` first, then as before; "keeps one record per dispatch, however many finalizers append it at once" — five racing appends → no `runs.jsonl`, `SELECT dispatch_id, role, status FROM dispatches` is one row `D1`, `readRecords` → `{ records: [{ dispatchId: "D1", secs: out[0].secs }], corrupt: 0 }`.
Test: test/services/dispatch.test.ts — "writes one record when two finalizers race, and both return it": `SELECT count(*) AS n FROM dispatches WHERE run_id = ?` → `{ n: 1 }` instead of the file's two lines.
Test: test/services/workspace.test.ts — "status preserves stored metadata, child state and dispatch evidence": `runs.jsonl` leaves the files list; `readRecords(api)` is equal before and after `workspaceStatus`.
Test: test/services/workspace-land.test.ts — "refuses landing with corrupted dispatch records": `ensureRunRow(db(), run)` and a `dispatches` row whose body is `{broken-record` → `land` rejects `E_RUN_CORRUPT`.
Test: test/services/ledger.test.ts — "refuses a milestone whose only verifier verdicts carry a longer name": `DELETE FROM dispatches WHERE run_id = ? AND json_extract(body, '$.name') = 'verifier-M2'` instead of rewriting the file. test/services/land-gate.test.ts — "refuses a PASS that names no HEAD": `UPDATE dispatches SET body = json_remove(body, '$.head') WHERE … json_extract(body, '$.name') = 'verifier-M1'`.
Test: test/services/lanes-run.test.ts — the plan-46 test becomes "reads a run's events and records as the files an earlier build kept": after `appendRecord(run, makeRecord({ dispatchId: "D1" }))`, `runs.jsonl` reads as `` `${JSON.stringify(readRecords(run).records[0])}\n` ``. test/infra/db.test.ts passes on `MIGRATIONS.length` 2 unchanged.

- [ ] Implement; the same command passes; `bun run typecheck && bun run lint`.
- [ ] Commit (suggested): `feat(records): dispatch records live in the database`

### Task 4: Team messages, docs and the changeset

Files: src/infra/db.ts, src/services/team.ts, MIGRATION.md, .changeset/plan-46-records-messages-database.md, test/services/team.test.ts

db.ts: `insertMessage` per Contracts (`sender` = `from`, `target` = `to`). team.ts: `teamMessages` with no `team.jsonl` is `SELECT n, at, sender AS "from", target AS "to", text FROM messages WHERE run_id = ? ORDER BY n`; `teamSend` keeps its lock and numbering, appends to the file when it exists, else `ensureRunRow` + `insertMessage` in one `.immediate()` transaction. `TEAM_FILE` stays (an earlier build's store). The doc comment of `teamMessages`: "`messages` rows (plan 46), or an earlier build's team.jsonl, torn lines skipped".

MIGRATION.md's plan-46 section gains: dispatch records and team messages are in the database too; `runs.jsonl` and `team.jsonl` are written only for a run an earlier build started; `catherd run-file read <run> runs.jsonl` still prints its records. Changeset (minor): "Dispatch records and team messages live in the run-state database beside the events; a run an earlier build started keeps its `runs.jsonl` and `team.jsonl`."

- [ ] Write the test; `bun test test/services/team.test.ts` fails.

Test: test/services/team.test.ts — "keeps a run's messages in the database; an earlier build's team.jsonl stays that run's store (plan 46)" — `send(run, "worker-M1.L3", "all", "first")` → no `team.jsonl`, `SELECT n, sender, target, text FROM messages` → `[{ n: 1, sender: "worker-M1.L3", target: "all", text: "first" }]`; a second fixture whose `team.jsonl` holds message 1 `old`: the next send numbers 2, `teamMessages` texts `["old", "next"]`, no `messages` row for it. Every existing team test passes unchanged.

- [ ] Implement; the test passes; then the full Check.
- [ ] Commit (suggested): `feat(team): team messages live in the database`

### M2 lanes

- M2.L1 — Task 3 — owns the files Task 3 lists — fast check: `bun test test/infra test/services/run-store.test.ts test/services/dispatch.test.ts test/services/workspace.test.ts test/services/workspace-land.test.ts test/services/ledger.test.ts test/services/land-gate.test.ts test/services/lanes-run.test.ts test/services/admission.test.ts && bun run typecheck && bun run lint`
- M2.L2 — Task 4 — after M2.L1 — owns the files Task 4 lists — fast check: `bun test test/services/team.test.ts test/services/run-briefs.test.ts && bun run typecheck && bun run lint`

## M3 — Earlier runs imported, a backup at each run's end

A1 — at a session's start every finished run an earlier build kept on files is in the database with `legacy = 1`, its folder unchanged; an unreadable folder is named and skipped (Check).
A2 — each run's end leaves a copy of the whole database under `backups/`, the last 7 kept (Check).
A3 — ideas.md, HANDOFF.md and MIGRATION.md say what plan 46 changed; the changeset names catherd-cli (Check).

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 5: The read-only import of earlier runs

Files: src/services/legacy-import.ts (new), src/entry/mcp/server.ts, test/services/legacy-import.test.ts (new)

`importLegacyRuns()` (R7): the ids already in `runs`; `listRuns()`; its `corrupt` folders start `skipped` with their reasons; each run with no row, an `events.jsonl` and `hasRunEnded(run)` is read (`readEvents`, `readRecords`, `teamMessages`) and then written in one `.immediate()` transaction: `ensureRunRow(d, run, true)`, `insertEvent`/`insertDispatch`/`insertMessage` for each; a throw while reading or writing adds `{ id, reason: errorMessage(e) }` to `skipped` and rolls that run back. Its doc: the spec D13 import, "reads only the run folder, never writes it; such a run's own reads stay on its files". server.ts, in the leading server's boot just before `reconcileAll(context)`: `for (const w of importLegacyRuns().skipped) console.error(\`catherd: not imported ${w.id}: ${w.reason}\`);` (inside the existing `try`).

- [ ] Write the test; `bun test test/services/legacy-import.test.ts` fails.

Test: test/services/legacy-import.test.ts — a helper writes a folder as an earlier build left it (`events.jsonl` from `makeLog` with `run.started`, and `run.ended` when finished; `runs.jsonl` with a header and record `D1`; `team.jsonl` with message `hi`):
- "copies a finished earlier run in as legacy, once, and never writes its folder" — every file's text before = after; result `{ imported: [run.id], skipped: [] }`; `runs.legacy` 1; events `run.started`, `run.ended`; dispatch `D1`; message `hi`; `readEvents(run)` still reads the file; a second call → `{ imported: [], skipped: [] }`.
- "leaves an earlier run still in flight, and every run of this build, alone" — an unfinished earlier run and a new run with one appended `tick` → nothing imported; `SELECT id, legacy FROM runs` is only the new run with 0.
- "reports and skips a folder it cannot read, and imports nothing of it" — a finished earlier run with `not json` and `{"v":1}` appended, and a folder `20260101-000000-bad` with a corrupt meta.json → `imported: []`, `skipped` ids are both, the run's reason contains "is corrupt", `runs` is empty.

- [ ] Implement; the test passes; `bun test test/entry/mcp.test.ts test/entry/mcp-handshake.test.ts` still pass.
- [ ] Commit (suggested): `feat(db): import finished earlier runs read-only for cross-run queries`

### Task 6: The backup at each run's end, docs, ideas and the changeset

Files: src/infra/db.ts, src/services/run-effects.ts, test/infra/db.test.ts, test/services/run-effects.test.ts, MIGRATION.md, docs/dev/ideas.md, docs/handoff/HANDOFF.md, .changeset/plan-46-import-backup.md

`backupDb(now = new Date())` (R9): `backups/` under `dataDir()` (`ensurePrivateDir`), `file = catherd-${now.toISOString().slice(0, 10)}.db`, `tmp = ${file}.${process.pid}.tmp` removed first, `db().query("VACUUM INTO ?").run(tmp)`, `chmodSync(tmp, PRIVATE_FILE)`, `renameSync(tmp, file)`; then every name matching `/^catherd-\d{4}-\d{2}-\d{2}\.db$/`, sorted, past the last 7 is removed; returns `file`. run-effects.ts `finish`: after `refreshState`, `try { backupDb(); } catch (e) { log("warn", "backup", { run: run.id, error: errorMessage(e) }); }`.

Docs: MIGRATION.md's plan-46 section gains the import (finished earlier runs are copied in as `legacy` at a session's start, their folders untouched) and the backup (`backups/catherd-<date>.db`, the last 7). docs/dev/ideas.md gains "### From plan 46 (the run-state database)": the lock files beside the transactions (R4, plan 48); `outcomes.jsonl`, `routes.jsonl`, `state.json` and the other files still beside the database (R5); no metric views yet (R11, plan 51); one backup per day (R9). HANDOFF.md, a row under the 2.0 table: "46 run-state database | `docs/plans/2026-10-28-46-run-state-database.md` | written (stage 1 slice 1 of the architect-led runs spec; plans 47–51 listed in its Next plans)". Changeset (minor): "Finished runs an earlier build kept on files are copied into the run-state database at a session's start, read-only, so cross-run queries see them; each run's end backs the database up under `backups/`, keeping the last seven."

- [ ] Write the tests; `bun test test/infra/db.test.ts test/services/run-effects.test.ts -t "backs|finishes by writing"` fails.

Test: test/infra/db.test.ts — "backs the whole database up by date, private, and keeps the last 7" — one `runs` row `r1`; `backupDb` for 2026-10-20 … 2026-10-28 and once more for the 28th → the last returns `join(dataDir(), "backups", "catherd-2026-10-28.db")`, mode `0o600`; `backups/` holds exactly the 22nd–28th; `openDb(file)` reads `[{ id: "r1" }]`.
Test: test/services/run-effects.test.ts — "finishes by writing the report and run.ended" also expects `readdirSync(join(dataDir(), "backups"))` to be one name matching `/^catherd-\d{4}-\d{2}-\d{2}\.db$/`.

- [ ] Implement; the tests pass; `bun run format:check`; then the full Check.
- [ ] Commit (suggested): `feat(db): back the database up at each run's end; docs for plan 46`

### M3 lanes

- M3.L1 — Task 5 — owns the files Task 5 lists — fast check: `bun test test/services/legacy-import.test.ts test/entry && bun run typecheck && bun run lint`
- M3.L2 — Task 6 — owns the files Task 6 lists — fast check: `bun test test/infra/db.test.ts test/services/run-effects.test.ts && bun run typecheck && bun run lint && bun run format:check`

## Edge cases

- A run whose `events.jsonl` exists but is empty (a test or a crash at the first append): a file run with no events; `isDaemonRun` true, as before.
- `runs.jsonl.lock` and `events.jsonl.lock` in a new run's folder: lock files only; neither makes the run a file run (the store looks for the file itself).
- `recordsOnThread` across every run: each run's records from its own store, so a thread an M1-build run started and an M2-build run resumes is found in both.
- A database whose `-wal` file a crashed process left: SQLite recovers it at the next open.
- Two servers booting at once: only the boot-lock leader imports; the transaction per run and `INSERT OR IGNORE` make a second importer harmless anyway.
- A `withHome()` test that never touches a store still creates no database: `db()` opens lazily.

## Out of scope

- Moving outcomes, routes, `state.json`, sessions, native agent runs, harness rows and workspace state (R5); D13's other tables (R5, R6); metric views and per-task comparisons (R11).
- Refusing to drive an earlier build's run (D16): plan 48, with the event-schema change.
- The panel (`web/`): it reads through the same stores.

## Next plans (the rest of stage 1)

Each is one plan, merged in this order, every deletion after its replacement. All run on the shared milestone tree (stage 2 brings per-writer trees). Each plan writer pre-validates against the merged head of the previous one.

- **Plan 47 — the architect loop (D1–D3, D12's call path, the contract lines).** Tables `ledger_tasks`, `ledger_progress` and the `messages` columns `kind`, `mode`, `delivered_at` (a migration each); the `ledger` tool and the read-only renders `ledger/tasks.json` and `ledger/progress.md` (last 40 entries, `progress-archive.md`); the wake queue and the event digest (one block per event, free writer slots named last); the architect's role-server tools `capabilities`, `delegate_task`, `task_status`, `task_cancel`, `thread_send`/`thread_read`/`thread_wait` (on `messages`, from plan 45's team tools), `check` (with `{base}` and a tree-keyed pass cache) writing a `checks` table, `ask_owner` (refused outside O6's stop classes), `finish`; every call's `why` recorded; the resumed thread, and a fresh thread from the ledger at 70% of the window, on a restart or a rung change; the architect gets `workspace-write`; plan lint once at start, its findings as warnings in the first digest (preflight no longer parks). Standing roles callable through `delegate_task` (D12: researcher and writer, a cap of 4 outside the writer cap, results by path). Contract lines that fit: "a run is the permission to test", "handoffs are context, not proof", "plans can be stale" (`SKIP <task> — <evidence>`), "owner questions carry their context". Behind a profile switch `engine: "architect"` so the 2.0 machine still runs every other run; nothing is deleted.
- **Plan 48 — the reducer (D4), caps and stall (D10).** `next(state, event) → actions[]` over dispatch, check, merge, wake and cap events only; the `caps` table and D10's caps (12 h wall, budget, 4 attempts per ledger task, 15 min idle; the 80% wake; the 10-minute grace); stall fingerprints on `dispatches` and the refusal with "stalled"; `impossible` from a worker and from the architect; the engine switch becomes the default and the 2.0 machine's run of a new run goes. Deleted after the reducer runs: milestone and round transitions (`laneActions`, `fixActions`, `reviewActions`, `milestoneActions`, `architectAgain`, `planningActions`, `approvalActions`, `onLaneStopped`, `waitsForSibling`, `afterReady`), the `floors` and `failedOn` retry floors (`run-state.ts:829`), the admission tick (`REFUSAL_WAIT_MS` and admit-order refusals), the auto-rerun of a red check (`milestone-check.ts:243-262`) and the automatic baseline, the judge role and its calls (its triage is now the architect's), rule review and `rules.ts`; the event schema version bumps, and D16's refusal to drive an earlier build's run lands with it; the lock files of R4 go as writes become single transactions.
- **Plan 49 — ladders (D7) and the decision model's deletion.** Each role's rungs become its ladder (first = default), a `delegate_task` rung off the ladder refused, a climb only after `failed`, `timeout`, `too_hard` or a review BLOCKER; `init`'s defaults (a flash-class worker first; a verifier ladder of rungs that run commands; R2's cross-family architect). ProfileService's migration per D16: drop `judge`, `decision` and `bars`; rungs to ladders in intelligence order; `caps` and an empty `memory` block; each dropped key named by `profile validate`. Deleted: `decision.ts`, `decision-client.ts`, `decision-service.ts`, the `decide` action and `decision.*` events, routing by bars and objective (`route.ts`, `select.ts`, `routing-service.ts` shrink), `routes.jsonl` and `outcomes.jsonl` (R5), `test/fixtures/decision/`.
- **Plan 50 — landing (D11) and the one verifier (D8).** `land` pushes and opens or updates one MR per repo per run with no park, never the base, never a force-push of a branch the run did not create; `land {final}` needs a green full check and a verifier PASS on the pushed sha, fetches the base and reruns the full check when landed base commits touch the run's diff ("the base moved"), then asks the owner one question; the MR body leads with the problem, then the change, one proof line, and the audit block last (every `why`, Known issues, deleted or skipped tests); the verifier once on the integrated product, its `RAN:` lines required on runnable lines, a bug task's `RUN:` run on base and head ("reproduce, then fix"). Deleted after: the "push" and "merged: MR !N" parks, `E_LAND_GATE`, the merge wait in `milestones.ts`, the milestone-per-branch mode and stacked MRs, the acceptance milestone (`role-prompts.ts`, `run-graph.ts`, `gate-brief.ts`, `verifier-step.ts`), and the verifier role lock (`withRoleLock`, `roleLockOwner`, its caller at `milestone-check.ts:224`, the role slots in `lock-command.ts`).
- **Plan 51 — reviews that converge, the ui-reviewer fold, and the stage-1 measurement.** D8's review lines: cross-family by default (the first reviewer rung of another family; `same-family` marked in the digest and the MR audit when none exists), one reviewer per call, findings with `important | nit | pre-existing` (a `pre-existing` one never starts a fix round), a finding names its bug class, a re-review sees only the diff since the last one and never re-reports, a fourth round on one task is refused in favour of a replan, depth by the change (money, auth, migrations, CI), each finding's handling recorded; the reviewer-scope contract line (a BUG needs an input from the acceptance lines or an existing caller; a disputed finding goes to the architect after two replies). The ui-reviewer folds into the reviewer (the amended D8): first a reviewer brief that names the screens to open and an image-capable rung appended to the reviewer ladder by the profile migration when it has none; then `ui-reviewer` and its ladder dropped from profiles, its prompt and role deleted. The D17 metrics as views over the database (idle %, average concurrency, blocked minutes by reason, check share of wall, rounds per task, cost, standing-role start latency) and a per-task comparison over at least two runs each, covering every role the stage changed (the amended D17); the remaining files of R5 moved or deleted.
