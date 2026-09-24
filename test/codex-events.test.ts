import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseCodexEvents } from "../src/core/codex-events.ts";

const fx = (n: string) => readFileSync(join(import.meta.dir, "fixtures", "codex", n), "utf8").split("\n");

describe("parseCodexEvents", () => {
  test("does not fail a run on reconnect or transport-fallback errors", () => {
    const p = parseCodexEvents(fx("ok-with-reconnect.jsonl"));
    expect(p.turnFailed).toBe(false);
    expect(p.failure).toBeNull();
    expect(p.thread).toBe("01a0d0d4-d0a6-71a1-983c-82a9169200b4");
    expect(p.tokens).toEqual({ input: 898388, cached: 788992, output: 5341 });
  });

  test("fails on turn.failed and keeps the message", () => {
    const p = parseCodexEvents(fx("turn-failed.jsonl"));
    expect(p.turnFailed).toBe(true);
    expect(p.failure).toContain("retries exhausted");
    expect(p.limit).toBe(false);
  });

  test("recognizes a usage limit", () => {
    const p = parseCodexEvents(fx("limit.jsonl"));
    expect(p.turnFailed).toBe(true);
    expect(p.limit).toBe(true);
  });

  test("sums usage over several turns", () => {
    expect(parseCodexEvents(fx("two-turns.jsonl")).tokens).toEqual({ input: 300, cached: 190, output: 30 });
  });

  test("recognizes an outdated CLI from an error message", () => {
    const p = parseCodexEvents([
      '{"type":"error","message":"The \'gpt-6-sol\' model is not supported when using Codex with a ChatGPT account."}',
    ]);
    expect(p.cliTooOld).toBe(true);
  });

  test("ignores blank and non-JSON lines", () => {
    expect(parseCodexEvents(["", "warning: something", "{"]).thread).toBeNull();
  });
});
