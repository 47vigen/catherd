import { describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { backupDb, db, dbFile, insertCheck, insertMessage, MIGRATIONS, openDb } from "../../src/infra/db.ts";
import { dataDir } from "../../src/infra/paths.ts";
import { withHome } from "../helpers.ts";

describe("the database (plan 46, spec D13)", () => {
  it("opens once per data dir, private, in WAL, with every migration applied", () => {
    withHome();
    const d = db();
    expect(db()).toBe(d);
    expect(statSync(dbFile()).mode & 0o777).toBe(0o600);
    expect(d.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(d.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(d.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
    withHome();
    expect(db()).not.toBe(d);
  });

  it("refuses a database a newer catherd wrote", () => {
    const file = join(withHome(), "newer.db");
    openDb(file).run(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    expect(() => openDb(file)).toThrow(
      expect.objectContaining({
        code: "E_CONFIG_NEWER_SCHEMA",
        message: expect.stringContaining("newer than this catherd"),
      }),
    );
  });

  it("applies only the migrations a database lacks", () => {
    const file = join(withHome(), "old.db");
    openDb(file).close();
    const again = openDb(file);
    expect(again.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
    expect(again.query("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 0 });
  });

  it("backs the whole database up by date, private, and keeps the last 7", () => {
    withHome();
    db().run("INSERT INTO runs (id, dir, repo, created_at) VALUES ('r1', '/d', '/r', 'x')");
    const days = Array.from({ length: 9 }, (_, i) => new Date(Date.UTC(2026, 9, 20 + i)));
    for (const d of days) backupDb(d);
    const file = backupDb(days.at(-1));
    expect(file).toBe(join(dataDir(), "backups", "catherd-2026-10-28.db"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dataDir(), "backups")).sort()).toEqual(
      days.slice(2).map((d) => `catherd-${d.toISOString().slice(0, 10)}.db`),
    );
    expect(openDb(file).query("SELECT id FROM runs").all()).toEqual([{ id: "r1" }]);
  });

  it("removes the temp files a crashed backup left", () => {
    withHome();
    const dir = join(dataDir(), "backups");
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, "catherd-2026-10-20.db.2000000000.tmp");
    writeFileSync(stale, "half");
    backupDb(new Date(Date.UTC(2026, 9, 28)));
    expect(readdirSync(dir)).toEqual(["catherd-2026-10-28.db"]);
  });

  it("keeps a message a plan-46 database holds, as a queued notice, when it adds the plan-47 tables", () => {
    const file = join(withHome(), "v2.db");
    const old = new Database(file, { create: true, strict: true });
    for (const [i, m] of MIGRATIONS.slice(0, 2).entries()) {
      old.run(m);
      old.run(`PRAGMA user_version = ${i + 1}`);
    }
    old.run("INSERT INTO runs (id, dir, repo, created_at) VALUES ('r1', '/d', '/r', 'x')");
    old.run(
      "INSERT INTO messages (run_id, n, at, sender, target, text) VALUES ('r1', 1, 'x', 'a', 'all', 'hi')",
    );
    old.close();
    const d = openDb(file);
    expect(d.query("SELECT kind, mode, delivered_at FROM messages").all()).toEqual([
      { kind: "notice", mode: "queue", delivered_at: null },
    ]);
    insertMessage(d, "r1", {
      n: 2,
      at: "y",
      from: "architect",
      to: "T1",
      text: "go",
      kind: "question",
      mode: "steer",
    });
    expect(d.query("SELECT kind, mode FROM messages WHERE n = 2").get()).toEqual({
      kind: "question",
      mode: "steer",
    });
    for (const t of ["ledger_tasks", "ledger_progress", "checks"])
      expect(d.query("SELECT count(*) AS n FROM sqlite_master WHERE name = ?").get(t)).toEqual({ n: 1 });
  });

  it("stores a check's failing lines as JSON and its flags as integers (plan 47)", () => {
    withHome();
    const d = db();
    d.run("INSERT INTO runs (id, dir, repo, created_at) VALUES ('r1', '/d', '/r', 'x')");
    insertCheck(d, "r1", {
      checkId: "C1",
      scope: "full",
      ref: "HEAD",
      tree: "t1",
      command: "bun test",
      base: false,
      exit: 1,
      failures: ["(fail) a > b"],
      minutes: 0.5,
      cached: false,
      at: "2026-10-28T10:00:00.000Z",
    });
    expect(d.query("SELECT check_id, base, cached, failures FROM checks").get()).toEqual({
      check_id: "C1",
      base: 0,
      cached: 0,
      failures: '["(fail) a > b"]',
    });
  });
});
