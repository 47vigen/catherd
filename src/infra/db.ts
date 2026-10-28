import { Database } from "bun:sqlite";
import { chmodSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CatherdError, UPGRADE } from "../domain/errors.ts";
import type { RunRecord } from "../domain/record.ts";
import type { RunEvent } from "../domain/run-events.ts";
import { dataDir } from "./paths.ts";
import { ensurePrivateDir, PRIVATE_FILE } from "./store.ts";

/**
 * Spec D13: the run and machine state, one SQLite database. Each migration runs once, in order, in one
 * transaction; `PRAGMA user_version` is the number applied. Documents and configuration stay files.
 */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE runs (id TEXT PRIMARY KEY, dir TEXT NOT NULL, repo TEXT NOT NULL, created_at TEXT NOT NULL,
     legacy INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE events (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL,
     type TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL, UNIQUE (run_id, seq));`,
  `CREATE TABLE dispatches (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
     dispatch_id TEXT NOT NULL, role TEXT NOT NULL, lane TEXT, rung TEXT NOT NULL, status TEXT NOT NULL,
     started_at TEXT NOT NULL, ended_at TEXT NOT NULL, cost_usd REAL, body TEXT NOT NULL,
     UNIQUE (run_id, dispatch_id));
   CREATE TABLE messages (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), n INTEGER NOT NULL,
     at TEXT NOT NULL, sender TEXT NOT NULL, target TEXT NOT NULL, text TEXT NOT NULL, UNIQUE (run_id, n));`,
];

export const dbFile = (): string => join(dataDir(), "catherd.db");

/** Opens `file` (created 0600), sets the pragmas and applies the migrations it lacks; a newer file is refused. */
export function openDb(file: string): Database {
  ensurePrivateDir(join(file, ".."));
  const db = new Database(file, { create: true, strict: true });
  chmodSync(file, PRIVATE_FILE);
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  const at = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (at > MIGRATIONS.length) {
    db.close();
    throw new CatherdError(
      "E_CONFIG_NEWER_SCHEMA",
      `${file} has schema ${at}, newer than this catherd (${MIGRATIONS.length})`,
      { fix: `upgrade catherd: ${UPGRADE}` },
    );
  }
  for (let v = at; v < MIGRATIONS.length; v++)
    db.transaction(() => {
      // a second process may have migrated since the read above
      const now = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (now > v) return;
      db.run(MIGRATIONS[v] as string);
      db.run(`PRAGMA user_version = ${v + 1}`);
    }).immediate();
  return db;
}

const open = new Map<string, Database>();

/** The database under the current data dir, opened once per process and path. */
export function db(): Database {
  const file = dbFile();
  let d = open.get(file);
  if (!d) {
    d = openDb(file);
    open.set(file, d);
  }
  return d;
}

/** The run's row, written once before its first event, record or message: every table points at it. */
export function ensureRunRow(
  d: Database,
  run: { id: string; dir: string; meta: { repo: string; createdAt: string } },
  legacy = false,
): void {
  d.query("INSERT OR IGNORE INTO runs (id, dir, repo, created_at, legacy) VALUES (?, ?, ?, ?, ?)").run(
    run.id,
    run.dir,
    run.meta.repo,
    run.meta.createdAt,
    legacy ? 1 : 0,
  );
}

/** One event row; `e` is already stamped and validated. */
export function insertEvent(d: Database, runId: string, e: RunEvent): void {
  d.query("INSERT INTO events (run_id, seq, type, at, body) VALUES (?, ?, ?, ?, ?)").run(
    runId,
    e.seq,
    e.type,
    e.at,
    JSON.stringify(e),
  );
}

/** One dispatch's record. */
export function insertDispatch(d: Database, runId: string, r: RunRecord): void {
  d.query(
    `INSERT INTO dispatches (run_id, dispatch_id, role, lane, rung, status, started_at, ended_at, cost_usd, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    r.dispatchId,
    r.role,
    r.lane,
    r.rung,
    r.status,
    r.startedAt,
    r.endedAt,
    r.costUsd,
    JSON.stringify(r),
  );
}

/** One team message. */
export function insertMessage(
  d: Database,
  runId: string,
  m: { n: number; at: string; from: string; to: string; text: string },
): void {
  d.query("INSERT INTO messages (run_id, n, at, sender, target, text) VALUES (?, ?, ?, ?, ?, ?)").run(
    runId,
    m.n,
    m.at,
    m.from,
    m.to,
    m.text,
  );
}

const BACKUPS_KEPT = 7;

/** Spec D13: a copy of the whole database at a run's end, `backups/catherd-<date>.db`; the last 7 days are kept. */
export function backupDb(now: Date = new Date()): string {
  const dir = join(dataDir(), "backups");
  ensurePrivateDir(dir);
  const file = join(dir, `catherd-${now.toISOString().slice(0, 10)}.db`);
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  db().query("VACUUM INTO ?").run(tmp);
  chmodSync(tmp, PRIVATE_FILE);
  renameSync(tmp, file);
  const all = readdirSync(dir)
    .filter((f) => /^catherd-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();
  for (const f of all.slice(0, -BACKUPS_KEPT)) rmSync(join(dir, f), { force: true });
  return file;
}
