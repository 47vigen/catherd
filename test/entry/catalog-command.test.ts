import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDiscovery } from "../../src/adapters/discovery.ts";
import { formatModel, syncLine } from "../../src/entry/catalog-command.ts";
import type { CatalogModel, IndexStatus } from "../../src/services/catalog-service.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
function catherd(...args: string[]) {
  return catherdIn(undefined, "/nonexistent", ...args);
}
/** git alone on PATH, so the command can find the repository it runs in but no backend CLI. */
function gitOnlyPath(): string {
  const bin = mkdtempSync(join(tmpdir(), "catherd-bin-"));
  symlinkSync(Bun.which("git") as string, join(bin, "git"));
  return bin;
}
function catherdIn(cwd: string | undefined, path: string, ...args: string[]) {
  const p = Bun.spawnSync([process.execPath, CLI, "catalog", ...args], {
    cwd,
    // no backend CLI on PATH: refresh lists nothing, and never touches the user's own
    env: { ...process.env, CATHERD_ORCHESTRATION_HOST: "claude-code", PATH: path, ANTHROPIC_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("formatModel", () => {
  it("shows each pair's intelligence, price and speed, and its run evidence", () => {
    withHome();
    const pair = (rung: string, intelligence: number, speed: number | null, evidence: string | null) => ({
      rung,
      enabled: true,
      intelligence,
      price: { input: 2, cached: 0.2, output: 10 },
      speed,
      context: 272000,
      cost: {} as never,
      evidence,
    });
    const m: CatalogModel = {
      id: "gpt-6-sol",
      name: "GPT-6 Sol",
      backend: "codex",
      model: "gpt-6-sol",
      billing: "codex",
      efforts: ["medium", "high"],
      capabilities: null,
      roles: ["worker" as const],
      listed: null,
      notes: {},
      rungs: [
        pair("codex:gpt-6-sol#medium", 41.234, 81.234, null),
        pair("codex:gpt-6-sol#high", 47, null, "12 lanes, 2 climbed, 1 partial"),
      ],
    };
    expect(formatModel(m).split("\n")).toEqual([
      "codex:gpt-6-sol  2 pairs  roles worker",
      "  #medium  intelligence 41.2 · $2/$10 per M · 81.2 tok/s",
      "  #high  intelligence 47.0 · $2/$10 per M",
      "    runs: 12 lanes, 2 climbed, 1 partial",
    ]);
  });
});

describe("catherd catalog", () => {
  it("lists models with their indexed pairs, as text or JSON", () => {
    withHome();
    const text = catherd("list", "--backend", "codex", "--text", "gpt-6-sol");
    expect(text.code).toBe(0);
    expect(text.out).toContain("codex:gpt-6-sol  6 pairs  roles ");
    expect(text.out).toMatch(/\n {2}#high {2}intelligence [\d.]+ · \$2\/\$10 per M/);
    const json = JSON.parse(catherd("list", "--role", "artist", "--json").out);
    expect(json.models.every((m: { backend: string }) => m.backend === "codex")).toBe(true);
  });

  it("refuses an unknown role with exit 2 and the fix", () => {
    withHome();
    const r = catherd("list", "--role", "chef");
    expect([r.code, r.err]).toEqual([
      2,
      `error E_INPUT_INVALID: no role "chef"\nfix: pass --role ${"architect|verifier|worker|reviewer|ui-reviewer|artist|writer|researcher"}\n`,
    ]);
  });

  it("has no treat-like command any more", () => {
    withHome();
    const r = catherd("treat-like", "a#high", "b#high");
    expect(r.code).not.toBe(0);
  });

  it("lists and refreshes opencode for the repository it runs in, and globally outside one", () => {
    withHome();
    const repo = realpathSync(tempRepo());
    const listing = [{ id: "opencode/gpt-6-luna", efforts: ["high"], context: 262144, imageIn: false }];
    const at = Date.parse("2026-09-25T10:00:00.000Z");
    writeDiscovery("opencode", listing, at, repo);
    const path = gitOnlyPath();
    const luna = (cwd: string) =>
      JSON.parse(catherdIn(cwd, path, "list", "--backend", "opencode", "--text", "gpt-6-luna", "--json").out)
        .models[0];
    // the repository's own listing narrows the efforts and marks the model offered
    expect(luna(repo)).toMatchObject({ listed: true, efforts: ["high"] });
    const outside = mkdtempSync(join(tmpdir(), "catherd-norepo-"));
    expect(luna(outside)).toMatchObject({ listed: null });
    // opencode cannot list here, so refresh reports the repository's own last listing
    const rows = JSON.parse(catherdIn(repo, path, "refresh", "--json").out) as {
      backend: string;
      fetchedAt: string | null;
    }[];
    expect(rows.find((x) => x.backend === "opencode")?.fetchedAt).toBe(new Date(at).toISOString());
    const global = JSON.parse(catherdIn(outside, path, "refresh", "--json").out) as typeof rows;
    expect(global.find((x) => x.backend === "opencode")?.fetchedAt).toBeNull();
  });

  it("refreshes every backend, keeping the claude-code list without an API key", () => {
    withHome();
    const r = catherd("refresh", "--json");
    const rows = JSON.parse(r.out) as { backend: string; models: number; error?: string }[];
    expect(rows.find((x) => x.backend === "claude-code")?.models).toBe(5);
    expect(rows.find((x) => x.backend === "codex")).toMatchObject({
      error: "codex is not on PATH",
      fix: "npm i -g @openai/codex",
    });
    expect(r.code).toBe(0);
    const text = catherd("refresh").out;
    expect(text).toContain("! codex: codex is not on PATH\n    fix: npm i -g @openai/codex\n");
    expect(text).not.toContain("previous listing");
  });
});

describe("catherd catalog sync", () => {
  it("takes --force and --json, and no longer --unmatched", () => {
    withHome();
    const r = catherd("sync", "--help");
    expect(r.code).toBe(0);
    for (const flag of ["--force", "--json"]) expect(r.out).toContain(flag);
    expect(r.out).not.toContain("--unmatched");
  });

  it("prints one line: the pair count and age, or why the fetch failed and what was kept", () => {
    const now = Date.parse("2026-10-21T12:00:00.000Z");
    const fresh: IndexStatus = {
      fetchedAt: "2026-10-21T11:00:00.000Z",
      checkedAt: "2026-10-21T11:30:00.000Z",
      pairs: 81,
      error: null,
    };
    expect(syncLine(fresh, true, now)).toBe("+ catalog: 81 pairs, fetched 1 h ago");
    expect(syncLine({ ...fresh, error: "http 503" }, true, now)).toBe(
      "! catalog: http 503; keeps the index fetched 1 h ago",
    );
  });
});
