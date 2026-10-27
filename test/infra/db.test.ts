import { describe, expect, it } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { db, dbFile, MIGRATIONS, openDb } from "../../src/infra/db.ts";
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
});
