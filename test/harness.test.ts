import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { firstTurnInput, formatHarness, harnessCosts, recordHarness } from "../src/core/harness.ts";
import { appendJsonl, createRun, readJsonl, rolePaths } from "../src/core/runstore.ts";
import { fakeRecord } from "./records.ts";
import { tempRepo, withHome } from "./helpers.ts";

const fx = (n: string) => join(import.meta.dir, "fixtures", "codex", n);
const row = (isolated: boolean, firstTurnInput: number, backend: "codex" | "opencode" = "codex") => ({
  at: "x",
  name: "w",
  backend,
  isolated,
  firstTurnInput,
});

describe("harness cost", () => {
  beforeEach(() => withHome());

  test("reads the first turn's input tokens from a Codex event stream", () => {
    expect(firstTurnInput(fx("ok-with-reconnect.jsonl"))).toBe(898388);
    expect(firstTurnInput("/nope.jsonl")).toBeNull();
  });

  test("records a row for a Codex run and none for a stream without usage", () => {
    const run = createRun(tempRepo(), "t", []);
    copyFileSync(fx("ok-with-reconnect.jsonl"), rolePaths(run.dir, "worker-M1.L1").jsonl);
    writeFileSync(rolePaths(run.dir, "worker-M1.L2").jsonl, '{"type":"text","part":{"text":"hi"}}\n');
    recordHarness(run.dir, fakeRecord("worker-M1.L1", { isolated: true }));
    recordHarness(run.dir, fakeRecord("worker-M1.L2", { backend: "opencode" }));
    expect(readJsonl<{ name: string; firstTurnInput: number }>(join(run.dir, "harness.jsonl"))).toMatchObject(
      [{ name: "worker-M1.L1", backend: "codex", firstTurnInput: 898388, isolated: true }],
    );
  });

  test("subtracts the isolated median from the native median across runs", () => {
    const a = createRun(tempRepo(), "a", []);
    const b = createRun(tempRepo(), "b", []);
    appendJsonl(join(a.dir, "harness.jsonl"), row(false, 45_000));
    appendJsonl(join(a.dir, "harness.jsonl"), row(false, 47_000));
    appendJsonl(join(b.dir, "harness.jsonl"), row(true, 33_000));
    const [codex] = harnessCosts([a.dir, b.dir]);
    expect(codex).toEqual({
      backend: "codex",
      nativeRuns: 2,
      isolatedRuns: 1,
      nativeMedian: 46_000,
      isolatedMedian: 33_000,
      extraPerRun: 13_000,
    });
    expect(formatHarness(codex!)).toContain("your codex customizations add ~13k input tokens per run");
  });

  test("reports the native median alone when there is nothing to compare, and nothing without data", () => {
    const a = createRun(tempRepo(), "a", []);
    expect(harnessCosts([a.dir])).toEqual([]);
    appendJsonl(join(a.dir, "harness.jsonl"), row(false, 40_000));
    const [codex] = harnessCosts([a.dir]);
    expect(codex?.extraPerRun).toBeNull();
    expect(formatHarness(codex!)).toBe(
      "codex native: median first-turn input ~40k tokens over 1 run; no isolated runs to compare",
    );
  });
});
