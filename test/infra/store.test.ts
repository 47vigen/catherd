import { afterEach, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { isCatherdError } from "../../src/domain/errors.ts";
import {
  appendJsonl,
  appendPrivate,
  ensureJsonlHeader,
  ensurePrivateDir,
  nonBlankLines,
  readJsonl,
  readVersioned,
  writeJsonAtomic,
  writeTextAtomic,
} from "../../src/infra/store.ts";
import { noPosixModes, openModes, snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const dir = () => mkdtempSync(join(tmpdir(), "catherd-store-"));
const Thing = z.looseObject({ schema: z.literal(1), name: z.string() });

describe("writeJsonAtomic", () => {
  it("writes pretty JSON and leaves no temp files behind", () => {
    const d = dir();
    const f = join(d, "sub", "a.json");
    writeJsonAtomic(f, { schema: 1, name: "x" });
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ schema: 1, name: "x" });
    expect(readdirSync(join(d, "sub"))).toEqual(["a.json"]);
  });

  it("writes with the mode it is given, even over a file that had a wider one", () => {
    const f = join(dir(), "secret.json");
    writeFileSync(f, "{}", { mode: 0o644 });
    writeJsonAtomic(f, { schema: 1, name: "x" }, { mode: 0o600 });
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
});

describe("readVersioned", () => {
  it("keeps unknown fields", () => {
    const f = join(dir(), "a.json");
    writeFileSync(f, JSON.stringify({ schema: 1, name: "x", extra: true }));
    expect(readVersioned(f, Thing, 1)).toEqual({ schema: 1, name: "x", extra: true });
  });

  it("refuses a newer schema with an upgrade fix", () => {
    const f = join(dir(), "a.json");
    writeFileSync(f, JSON.stringify({ schema: 2, name: "x" }));
    try {
      readVersioned(f, Thing, 1);
      throw new Error("expected a throw");
    } catch (e) {
      expect(isCatherdError(e) && e.code).toBe("E_CONFIG_NEWER_SCHEMA");
      // bunx alone opens the dashboard of the newest catherd and upgrades nothing installed (audit N12)
      expect(isCatherdError(e) && e.fix).toBe(
        "upgrade catherd: bun add -g catherd-cli@latest (or run bunx catherd-cli@latest <command>)",
      );
    }
  });

  it("reports invalid content and unreadable JSON as E_CONFIG_INVALID", () => {
    const f = join(dir(), "a.json");
    writeFileSync(f, JSON.stringify({ schema: 1 }));
    expect(() => readVersioned(f, Thing, 1)).toThrow(/invalid/);
    writeFileSync(f, "{not json");
    try {
      readVersioned(f, Thing, 1);
    } catch (e) {
      expect(isCatherdError(e) && e.code).toBe("E_CONFIG_INVALID");
    }
  });

  it("names a file that is not JSON without quoting it, so a pasted key never reaches the message (B1)", () => {
    const f = join(dir(), "credentials.json");
    writeFileSync(f, "tsk_FAKEKEY_DO_NOT_USE_1234567890\n");
    let err: unknown;
    try {
      readVersioned(f, Thing, 1);
    } catch (e) {
      err = e;
    }
    expect(isCatherdError(err) && err.toJSON()).toEqual({
      code: "E_CONFIG_INVALID",
      message: `${f} is not valid JSON`,
      fix: `fix or delete ${f}`,
    });
    expect(() => readVersioned(f, Thing, 1, { fix: "run x" })).toThrow(
      expect.objectContaining({ fix: "run x" }),
    );
  });
});

describe("jsonl", () => {
  it("writes the header once and reads rows back after it", () => {
    const f = join(dir(), "runs.jsonl");
    ensureJsonlHeader(f, "runs");
    ensureJsonlHeader(f, "runs");
    appendJsonl(f, { a: 1 });
    appendJsonl(f, { a: 2 });
    expect(readJsonl(f)).toEqual({ kind: "runs", rows: [{ a: 1 }, { a: 2 }], corrupt: 0 });
  });

  it("skips a truncated tail and a corrupt middle line, counting them", () => {
    const f = join(dir(), "runs.jsonl");
    ensureJsonlHeader(f, "runs");
    appendJsonl(f, { a: 1 });
    appendFileSync(f, "garbage\n");
    appendJsonl(f, { a: 2 });
    appendFileSync(f, '{"a":3');
    expect(readJsonl(f)).toEqual({ kind: "runs", rows: [{ a: 1 }, { a: 2 }], corrupt: 2 });
  });

  it("starts a fresh line after a crash left a truncated last line, so the next row is kept", () => {
    const f = join(dir(), "runs.jsonl");
    ensureJsonlHeader(f, "runs");
    appendJsonl(f, { a: 1 });
    appendFileSync(f, '{"a":3');
    appendJsonl(f, { a: 4 });
    expect(readJsonl(f)).toEqual({ kind: "runs", rows: [{ a: 1 }, { a: 4 }], corrupt: 1 });
  });

  it("returns empty for a missing file and refuses a newer header", () => {
    const d = dir();
    expect(readJsonl(join(d, "none.jsonl"))).toEqual({ kind: null, rows: [], corrupt: 0 });
    const f = join(d, "new.jsonl");
    writeFileSync(f, '{"schema":9,"kind":"runs"}\n');
    expect(() => readJsonl(f, 1)).toThrow(/newer/);
    expect(existsSync(f)).toBe(true);
  });
});

describe("private modes (audit S2)", () => {
  it.skipIf(noPosixModes)("creates new dirs 0700 and files 0600, whatever the umask lets through", () => {
    const d = dir();
    writeTextAtomic(join(d, "a", "b", "c.txt"), "x");
    appendJsonl(join(d, "logs", "l.jsonl"), { a: 1 });
    ensureJsonlHeader(join(d, "runs", "h.jsonl"), "runs");
    expect(openModes(d)).toEqual([]);
    expect(statSync(join(d, "a", "b", "c.txt")).mode & 0o777).toBe(0o600);
  });

  it.skipIf(noPosixModes)("tightens catherd's existing config and data dirs on the next write", () => {
    const home = withHome();
    for (const sub of ["config", "data"]) {
      mkdirSync(join(home, sub));
      chmodSync(join(home, sub), 0o755);
    }
    writeJsonAtomic(join(home, "config", "config.json"), { schema: 1 });
    appendJsonl(join(home, "data", "logs", "x.jsonl"), { a: 1 });
    expect(openModes(home)).toEqual([]);
  });

  it.skipIf(noPosixModes)(
    "tightens the existing nested dirs and append targets a 0.x catherd left open",
    () => {
      const home = withHome();
      const runs = join(home, "data", "repos", "r-1", "runs");
      const logs = join(home, "data", "logs");
      for (const d of [runs, logs]) mkdirSync(d, { recursive: true, mode: 0o755 });
      for (const d of [
        join(home, "data"),
        join(home, "data", "repos"),
        join(home, "data", "repos", "r-1"),
        runs,
        logs,
      ])
        chmodSync(d, 0o755);
      const log = join(logs, "old.jsonl");
      const knowledge = join(home, "data", "repos", "r-1", "knowledge.md");
      writeFileSync(log, "{}\n", { mode: 0o644 });
      writeFileSync(knowledge, "- old\n", { mode: 0o644 });
      chmodSync(log, 0o644);
      chmodSync(knowledge, 0o644);
      ensurePrivateDir(runs);
      appendJsonl(log, { a: 1 });
      appendPrivate(knowledge, "- new\n");
      expect(openModes(home)).toEqual([]);
      expect(readFileSync(knowledge, "utf8")).toBe("- old\n- new\n");
    },
  );
});

describe("nonBlankLines", () => {
  it("drops blank lines, and reads a missing file as none", () => {
    const f = join(dir(), "x.txt");
    expect(nonBlankLines(f)).toEqual([]);
    writeFileSync(f, "a\n\n  \nb\n");
    expect(nonBlankLines(f)).toEqual(["a", "b"]);
  });
});
