import { describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { isCatherdError } from "../../src/domain/errors.ts";
import {
  appendJsonl,
  ensureJsonlHeader,
  readJsonl,
  readVersioned,
  writeJsonAtomic,
} from "../../src/infra/store.ts";

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

  it("returns empty for a missing file and refuses a newer header", () => {
    const d = dir();
    expect(readJsonl(join(d, "none.jsonl"))).toEqual({ kind: null, rows: [], corrupt: 0 });
    const f = join(d, "new.jsonl");
    writeFileSync(f, '{"schema":9,"kind":"runs"}\n');
    expect(() => readJsonl(f, 1)).toThrow(/newer/);
    expect(existsSync(f)).toBe(true);
  });
});
