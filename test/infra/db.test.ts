import { describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backupDb, db, dbFile, MIGRATIONS, openDb } from "../../src/infra/db.ts";
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
});
