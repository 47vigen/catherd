import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../../../src/infra/sources/csv.ts";
import {
  EPOCH_PAGE,
  EPOCH_TABLES,
  EPOCH_URL,
  epochRung,
  fetchEpoch,
  parseEpoch,
} from "../../../src/infra/sources/epoch.ts";
import { unzip } from "../../../src/infra/sources/zip.ts";

const FX = join(import.meta.dir, "..", "..", "fixtures", "sources");
const zipBytes = () => new Uint8Array(readFileSync(join(FX, "epoch.zip")));
const AT = "2026-09-28T10:00:00.000Z";
const zipFetch = (bytes: Uint8Array) =>
  (async () =>
    new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), { status: 200 })) as unknown as typeof fetch;

describe("the zip reader (plan 13 R-F)", () => {
  it("reads the deflated entries it is asked for, by name", () => {
    const all = unzip(zipBytes());
    expect([...all.keys()].sort()).toEqual([
      "README.md",
      "frontiercode_external.csv",
      "terminalbench_external.csv",
      "webdev_arena_external.csv",
    ]);
    const one = unzip(zipBytes(), (n) => n === "README.md");
    expect(new TextDecoder().decode(one.get("README.md"))).toContain("CC BY 4.0");
    expect(new TextDecoder().decode(all.get("frontiercode_external.csv"))).toBe(
      readFileSync(join(FX, "epoch", "frontiercode_external.csv"), "utf8"),
    );
  });

  it("refuses bytes that are not a zip", () => {
    expect(() => unzip(new TextEncoder().encode("<html>not a zip</html>"))).toThrow("not a zip archive");
  });
});

describe("CSV", () => {
  it("reads quoted commas, doubled quotes and line breaks inside a field, and CRLF rows", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\r\n\r\n3,\n')).toEqual([
      { a: "x, y", b: 'say "hi"\nthere' },
      { a: "3", b: "" },
    ]);
    expect(parseCsv("")).toEqual([]);
  });
});

describe("Epoch AI (spec 1.2 §3.1)", () => {
  it("reads the effort after the last _, else the Reasoning effort column; _unknown names none", () => {
    expect(epochRung("gpt-6-astra_max")).toBe("gpt-6-astra#max");
    expect(epochRung("gpt-5.6-sol_unknown", "max")).toBe("gpt-5.6-sol#max");
    expect(epochRung("claude-opus-5_max", "medium")).toBe("claude-opus-5#max");
    expect(epochRung("claude-opus-4-5-20251101_32K")).toBe("claude-opus-4-5-20251101");
    expect(epochRung("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
  });

  it("fetches the zip and keeps the three tables it reads", async () => {
    expect(EPOCH_URL).toBe("https://epoch.ai/data/benchmark_data.zip");
    const tables = await fetchEpoch({ fetchImpl: zipFetch(zipBytes()) });
    expect(Object.keys(tables).sort()).toEqual(
      Object.values(EPOCH_TABLES)
        .map((t) => t.file)
        .sort(),
    );
  });

  it("fails the source on an answer that is not a zip", async () => {
    const html = new TextEncoder().encode("<html>");
    expect((await fetchEpoch({ fetchImpl: zipFetch(html) }).catch((e) => e)).message).toBe(
      "the answer is not a readable zip: not a zip archive",
    );
  });

  it("gives FrontierCode and Terminal-Bench in percent, WebDev as its rating, the best agent per model", () => {
    const tables = Object.fromEntries(
      [...unzip(zipBytes())].map(([name, data]) => [name, new TextDecoder().decode(data)]),
    );
    const rows = parseEpoch(tables, AT);
    const at = (field: string, rung: string) => rows.find((r) => r.field === field && r.rung === rung);
    expect(at("frontiercode", "gpt-5.6-sol#max")).toEqual({
      rung: "gpt-5.6-sol#max",
      field: "frontiercode",
      value: 47.49,
      date: "2026-09-28",
      url: "https://cognition.com/frontiercode",
    });
    // five Terminal-Bench rows for Haiku 4.5 under two spellings: the best, dated by its run
    expect(at("terminalbench", "claude-haiku-4-5-20251001")).toMatchObject({
      value: 35.5056,
      date: "2025-10-15",
    });
    expect(at("webdev", "claude-fable-5-1#max")).toMatchObject({
      value: 1758.05,
      url: "https://arena.ai/leaderboard",
    });
    expect(rows.filter((r) => r.field === "terminalbench")).toHaveLength(2);
    expect(rows.every((r) => r.url.startsWith("https://"))).toBe(true);
    expect(EPOCH_PAGE).toBe("https://epoch.ai/benchmarks");
  });

  it("has no Opus 5.5 row in FrontierCode or Terminal-Bench (plan 13 R-D)", () => {
    const tables = Object.fromEntries(
      [...unzip(zipBytes())].map(([name, data]) => [name, new TextDecoder().decode(data)]),
    );
    expect(parseEpoch(tables, AT).filter((r) => r.rung.startsWith("claude-opus-5-5"))).toEqual([]);
  });
});
