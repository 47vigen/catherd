import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARENA_CONFIGS,
  ARENA_PAGE,
  arenaRung,
  arenaUrl,
  fetchArena,
  parseArena,
} from "../../../src/infra/sources/arena.ts";
import { parseVectara, VECTARA_PAGE, VECTARA_URL, vectaraDate } from "../../../src/infra/sources/vectara.ts";
import { fakeFetch } from "../../fake-fetch.ts";

const FX = join(import.meta.dir, "..", "..", "fixtures", "sources");
const text = (name: string) => readFileSync(join(FX, name), "utf8");
const arenaFixture = () =>
  Object.fromEntries(ARENA_CONFIGS.map((c) => [c, JSON.parse(text(`arena-${c}.json`))]));
const AT = "2026-09-28T10:00:00.000Z";

describe("Arena (spec 1.2 §3.1)", () => {
  it("reads the effort from a (Max)/(xHigh)/(High) suffix or a trailing -max, and drops a harness note", () => {
    expect(arenaRung("Claude Opus 5.5 (High)")).toBe("Claude Opus 5.5#high");
    expect(arenaRung("GPT 5.6 Sol (xHigh)")).toBe("GPT 5.6 Sol#xhigh");
    expect(arenaRung("claude-opus-5.5-max")).toBe("claude-opus-5.5#max");
    expect(arenaRung("gpt-5.6-sol-xhigh (codex-harness)")).toBe("gpt-5.6-sol#xhigh");
    expect(arenaRung("muse-spark-1.3 (xHigh)")).toBe("muse-spark-1.3#xhigh");
    expect(arenaRung("DeepSeek V4 Pro (High) (0813)")).toBe("DeepSeek V4 Pro (0813)#high");
    expect(arenaRung("Qwen3.8 Max")).toBe("Qwen3.8 Max");
    expect(arenaRung("gemini-3.5-flash-lite")).toBe("gemini-3.5-flash-lite");
  });

  it("fetches the six configs of the leaderboard dataset", async () => {
    const f = fakeFetch({ status: 200, body: { rows: [] } });
    const got = await fetchArena({ fetchImpl: f.impl });
    expect(Object.keys(got)).toEqual([...ARENA_CONFIGS]);
    expect(f.sent.map((s) => s.url)).toEqual(ARENA_CONFIGS.map(arenaUrl));
    expect(arenaUrl("agent")).toBe(
      "https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=agent&split=latest&length=100",
    );
  });

  it("gives one row per model and config: the agent boards' score, WebDev's rating, dated by the board", () => {
    const rows = parseArena(arenaFixture(), AT);
    expect(rows).toHaveLength(5 * 12 + 14);
    expect(rows.find((r) => r.field === "agent" && r.rung === "Claude Opus 5.5#high")).toEqual({
      rung: "Claude Opus 5.5#high",
      field: "agent",
      value: 0.12152186656915857,
      date: "2026-09-27",
      url: ARENA_PAGE,
    });
    expect(rows.find((r) => r.field === "webdev" && r.rung === "claude-opus-5.5#max")).toMatchObject({
      value: 1826.7306745084245,
      date: "2026-09-25",
    });
    expect(rows.find((r) => r.field === "webdev" && r.rung === "gpt-5.6-sol#xhigh")?.value).toBe(
      1617.3524740259538,
    );
  });

  it("reads no coding or terminal board: Opus 5.5 is on the agent boards and WebDev only (plan 13 R-D)", () => {
    const opus = parseArena(arenaFixture(), AT).filter(
      (r) => r.rung.toLowerCase().includes("opus 5.5") || r.rung.includes("opus-5.5"),
    );
    expect(opus.map((r) => r.field).sort()).toEqual([...ARENA_CONFIGS].sort());
  });

  it("skips a row without a name or a number, and a config missing from the answer", () => {
    const raw = { agent: { rows: [{ row: { model_name: "A (Max)", score: "x" } }, { row: { score: 1 } }] } };
    expect(parseArena(raw, AT)).toEqual([]);
  });
});

describe("Vectara (spec 1.2 §3.1)", () => {
  it("reads the table's factual consistency and hallucination rate, dated by its Last updated line", () => {
    expect(VECTARA_URL).toBe(
      "https://raw.githubusercontent.com/vectara/hallucination-leaderboard/main/README.md",
    );
    const rows = parseVectara(text("vectara-README.md"), AT);
    expect(rows).toHaveLength(12);
    expect(rows.filter((r) => r.rung === "openai/gpt-6-sol")).toEqual([
      {
        rung: "openai/gpt-6-sol",
        field: "factual_consistency",
        value: 93.5,
        date: "2026-09-22",
        url: VECTARA_PAGE,
      },
      {
        rung: "openai/gpt-6-sol",
        field: "hallucination_rate",
        value: 6.5,
        date: "2026-09-22",
        url: VECTARA_PAGE,
      },
    ]);
    expect(rows.some((r) => r.rung === "anthropic/claude-haiku-4-5-20251001")).toBe(true);
  });

  it("dates by the fetch when the README has no Last updated line, and reads nothing without a table", () => {
    expect(vectaraDate("Last updated on September 22, 2026")).toBe("2026-09-22");
    expect(vectaraDate("no date")).toBeNull();
    const table =
      "|Model|Hallucination Rate|Factual Consistency Rate|\n|---|---:|---:|\n|a/b|2.0 %|98.0 %|\n";
    expect(parseVectara(table, AT).map((r) => r.date)).toEqual(["2026-09-28", "2026-09-28"]);
    expect(parseVectara("# nothing here", AT)).toEqual([]);
  });
});
