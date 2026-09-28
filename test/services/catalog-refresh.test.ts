import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { barPool, deriveBars, percentile } from "../../src/domain/bars.ts";
import { DIMS, type Score, type ScoresFile, ScoresFileSchema } from "../../src/domain/catalog.ts";
import { EPOCH_URL } from "../../src/infra/sources/epoch.ts";
import {
  rebuildShipped,
  refreshBody,
  refreshShipped,
  shippedChanged,
} from "../../src/services/catalog-refresh.ts";
import { snapshotEnv, tempDir, withHome } from "../helpers.ts";
import { rawAnswers, recordedFetch, shippedContext } from "./source-fixtures.ts";

afterEach(snapshotEnv());

const AT = "2026-09-28T10:00:00.000Z";
const NOW = Date.parse(AT);
const ctx = () => shippedContext(NOW);
const rebuild = (o: { aa?: boolean; scores?: ScoresFile } = {}) => {
  const c = ctx();
  return rebuildShipped(rawAnswers(AT, { aa: o.aa }), { ...c, scores: o.scores ?? c.scores });
};
const find = (f: ScoresFile, rung: string, dim: string): Score | undefined =>
  f.scores.find((s) => s.rung === rung && s.dim === dim);

describe("the shipped scores, rebuilt from the keyless sources (spec 1.2 §7)", () => {
  it("keeps every hand-typed value published for its rung", () => {
    const { file } = rebuild();
    for (const s of ctx().scores.scores)
      if (s.source === undefined && s.confidence !== "inferred" && s.confidence !== "adjacent")
        expect(find(file, s.rung, s.dim)).toEqual(s);
  });

  it("never ships a value from Artificial Analysis, even when its answer is cached", () => {
    const withAa = rebuild({ aa: true }).file;
    expect(withAa.scores.filter((s) => s.source === "artificial-analysis")).toEqual([]);
    expect(withAa).toEqual(rebuild().file);
  });

  it("carries the keyless sources' values with their source, date and confidence", () => {
    const s = find(rebuild().file, "claude-opus-5-5#high", "agentic");
    expect(s).toMatchObject({ value: 0.1215, source: "arena", date: "2026-09-27", confidence: "measured" });
  });

  it("spreads a published value to the family's other efforts, but never an inferred one", () => {
    const { file } = rebuild();
    // Luna is published at max only: its other efforts carry that value as adjacent
    expect(find(file, "gpt-6-luna#high", "repo_code")).toMatchObject({
      value: 66.6,
      confidence: "adjacent",
      note: "DeepSWE has it at max; carried to this effort",
    });
    // Fable's DeepSWE value is inferred (a secondary source that names no effort): it stays on max
    expect(find(file, "claude-fable-5-1#max", "repo_code")?.confidence).toBe("inferred");
    expect(find(file, "claude-fable-5-1#xhigh", "repo_code")).toBeUndefined();
  });

  it("ships one value per rung and dimension, and rebuilding it again changes nothing", () => {
    const { file } = rebuild();
    const keys = file.scores.map((s) => `${s.rung} ${s.dim}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ScoresFileSchema.safeParse(file).success).toBe(true);
    const again = rebuild({ scores: file });
    expect(shippedChanged(file, again.file)).toBe(false);
    expect(again.report).toMatchObject({ newlyScored: [], moved: [], barsMoved: [], standInsDropped: [] });
  });

  it("derives the default bars from the values measured or better, with a why line each", () => {
    const { file } = rebuild();
    const pool = barPool(file.scores);
    expect(file.bars.repo_code.copy.repo_code).toBe(Number(percentile(pool.repo_code, 25).toPrecision(4)));
    expect(file.bars).toEqual(
      deriveBars(pool, (d) => `${file.benchmarks[d].benchmark} ${file.benchmarks[d].version}`, "2026-09-28")
        .bars,
    );
    expect((file.barsWhy as Record<string, Record<string, string>>).agentic?.hard).toStartWith(
      "the 75th percentile of ",
    );
    for (const kind of Object.values(file.bars))
      for (const bar of Object.values(kind)) expect(Object.keys(bar)).not.toContain("steer");
  });

  it("drops a shipped treat-like its rung no longer needs, and keeps one that still lends", () => {
    const c = ctx();
    const scores = {
      ...c.scores,
      treatLike: {
        ...c.scores.treatLike,
        "claude-opus-5-5#high": { like: "claude-opus-5-5#xhigh", note: "only xhigh and max are published" },
      },
    };
    const { file, report } = rebuild({ scores });
    expect(file.treatLike["claude-opus-5-5#high"]).toBeUndefined();
    expect(file.treatLike["opencode-go/kimi-k3#max"]?.like).toBe("gpt-6-sol#medium");
    expect(report.standInsDropped).toContain("claude-opus-5-5#high");
  });

  it("reports the rungs newly scored, values moved by more than 5 %, and every bar that moved", () => {
    const first = rebuild().file;
    const before: ScoresFile = structuredClone(first);
    before.scores = before.scores
      .filter((s) => s.rung !== "gpt-6-luna#low")
      .map((s) =>
        s.rung === "gpt-6-sol#max" && s.dim === "agentic"
          ? { ...s, value: s.value * 1.1 }
          : s.rung === "gpt-6-sol#max" && s.dim === "steer"
            ? { ...s, value: s.value * 1.01 }
            : s,
      );
    before.bars.terminal.build = { terminal: 1 };
    const { report } = rebuild({ scores: before });
    expect(report.newlyScored).toEqual(["gpt-6-luna#low"]);
    const sol = find(first, "gpt-6-sol#max", "agentic")?.value as number;
    expect(report.moved).toEqual([{ rung: "gpt-6-sol#max", dim: "agentic", from: sol * 1.1, to: sol }]);
    expect(report.barsMoved).toContainEqual({
      kind: "terminal",
      difficulty: "build",
      dim: "terminal",
      from: 1,
      to: first.bars.terminal.build.terminal ?? null,
    });
    const body = refreshBody(report);
    expect(body).toContain("### Rungs newly scored (1)\n\n- `gpt-6-luna#low`");
    expect(body).toContain(`| \`gpt-6-sol#max\` | agentic | ${sol * 1.1} | ${sol} |`);
    expect(body).toContain("### Bars that moved");
  });
});

describe("refreshShipped (scripts/catalog-refresh.ts)", () => {
  it("syncs without a key, and writes the rebuilt file only when it says something new", async () => {
    withHome();
    const out = join(tempDir("catherd-refresh-"), "scores.json");
    const c = ctx();
    let t = NOW;
    const f = recordedFetch();
    const transport = { fetchImpl: f.impl, now: () => t, sleep: async (ms: number) => void (t += ms) };
    const r = await refreshShipped({
      out,
      current: c.scores,
      models: c.models,
      sources: c.sources,
      transport,
    });
    expect(f.urls.some((u) => u.includes("artificialanalysis"))).toBe(false);
    expect(r.failed).toEqual([]);
    const written = ScoresFileSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(r.changed).toBe(shippedChanged(c.scores, written));
    const again = await refreshShipped({
      out: `${out}.2`,
      current: written,
      models: c.models,
      sources: c.sources,
      transport,
    });
    expect(again.changed).toBe(false);
    expect(existsSync(`${out}.2`)).toBe(false);
  });

  it("writes nothing when a keyless source fails", async () => {
    withHome();
    const out = join(tempDir("catherd-refresh-"), "scores.json");
    const c = ctx();
    let t = NOW;
    const f = recordedFetch({ fail: (u) => u === EPOCH_URL });
    const transport = { fetchImpl: f.impl, now: () => t, sleep: async (ms: number) => void (t += ms) };
    const r = await refreshShipped({
      out,
      current: c.scores,
      models: c.models,
      sources: c.sources,
      transport,
    });
    expect(r.failed.map((x) => x.source)).toEqual(["epoch"]);
    expect(r.changed).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  it("covers every dimension's benchmark name", () => {
    for (const d of DIMS) expect(ctx().scores.benchmarks[d].benchmark.length).toBeGreaterThan(0);
  });
});
