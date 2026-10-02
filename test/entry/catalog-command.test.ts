import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDiscovery } from "../../src/adapters/discovery.ts";
import { formatModel, syncLines } from "../../src/entry/catalog-command.ts";
import { type CatalogModel, overridePath } from "../../src/services/catalog-service.ts";
import type { SyncReport } from "../../src/services/source-sync.ts";
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

describe("formatModel (spec 1.2 §4.1, §8)", () => {
  it("adds the price and speed facts, each rung's values with their source, and its run evidence", () => {
    withHome();
    const m: CatalogModel = {
      id: "gpt-6-sol",
      name: "GPT-6 Sol",
      backend: "codex",
      model: "gpt-6-sol",
      billing: "codex",
      efforts: ["medium", "high"],
      context: 272000,
      capabilities: null,
      roles: ["worker" as const],
      listed: null,
      notes: {},
      price: { input: 2, cached: 0.2, output: 10 },
      speed: { "openrouter.throughput_last_30m": 81.234 },
      rungs: [
        {
          rung: "codex:gpt-6-sol#medium",
          enabled: true,
          scores: {
            repo_code: {
              value: 65.3,
              benchmark: "DeepSWE 1.1",
              confidence: "verified",
              source: "shipped",
              date: "2026-09-22",
            },
            terminal: {
              value: 0.123456,
              benchmark: "Terminal-Bench 2",
              confidence: "inferred",
              source: "epoch",
              date: "2026-09-20",
              from: "gpt-6-sol#high",
              lent: "stand-in",
            },
            honesty: {
              value: 95.1,
              benchmark: "Broken Search Tool",
              confidence: "inferred",
              source: "shipped",
              date: "2026-09-20",
              from: "gpt-6-astra#medium",
              lent: "treat-like",
            },
          },
          treatLike: null,
          cost: {} as never,
          evidence: null,
        },
        {
          rung: "codex:gpt-6-sol#high",
          enabled: false,
          scores: {},
          treatLike: null,
          cost: {} as never,
          evidence: "12 lanes, 2 climbed, 1 partial",
        },
      ],
    };
    expect(formatModel(m).split("\n")).toEqual([
      "codex:gpt-6-sol  1/2 rungs scored  roles worker",
      "  $2/$10 per M tokens in/out · openrouter.throughput_last_30m 81.23",
      // a treat-like's value is the user's mapping, "like X"; a stand-in's is a guess (1.2 minor)
      "  #medium  repo_code 65.3 (verified, shipped) · terminal 0.1235 (inferred from gpt-6-sol#high, epoch) · honesty 95.1 (like gpt-6-astra#medium, shipped)",
      "  #high  unscored",
      "    runs: 12 lanes, 2 climbed, 1 partial",
    ]);
  });
});

describe("catherd catalog", () => {
  it("lists models with their scored rungs, as text or JSON", () => {
    withHome();
    const text = catherd("list", "--backend", "codex", "--text", "gpt-6-sol");
    expect(text.code).toBe(0);
    expect(text.out).toContain("codex:gpt-6-sol  6/6 rungs scored  roles ");
    // spec 1.2 §4.1: cost and speed are facts, shown beside the scores
    expect(text.out).toContain("\n  $2/$10 per M tokens in/out\n");
    // spec 1.2 §5.3: each value with its confidence and source
    expect(text.out).toMatch(/\n {2}#high {2}repo_code [\d.]+ \(\w+, \w+\)/);
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

  it("saves a treat-like, and refuses one onto an unscored rung", () => {
    withHome();
    const ok = catherd("treat-like", "opencode:opencode-go/kimi-k3#default", "codex:gpt-6-sol#medium");
    expect([ok.code, ok.out]).toEqual([
      0,
      "✓ opencode-go/kimi-k3#default is treated like gpt-6-sol#medium\n",
    ]);
    expect(JSON.parse(readFileSync(overridePath(), "utf8")).treatLike).toEqual({
      "opencode-go/kimi-k3#default": "gpt-6-sol#medium",
    });
    const bad = catherd("treat-like", "a/b#high", "a/c#high");
    expect(bad.code).toBe(1);
    expect(bad.err).toStartWith("error E_CONFIG_INVALID: a/c#high has no scores of its own to lend\nfix: ");
  });

  it("saves a treat-like with --json as JSON, shaped like --clear's rung and like", () => {
    withHome();
    const r = catherd(
      "treat-like",
      "opencode:opencode-go/kimi-k3#default",
      "codex:gpt-6-sol#medium",
      "--json",
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ rung: "opencode-go/kimi-k3#default", like: "gpt-6-sol#medium" });
  });

  it("refuses a malformed rung with exit 2 and leaves the override file unchanged", () => {
    withHome();
    expect(catherd("treat-like", "a/b#high", "gpt-6-sol#high").code).toBe(0);
    const before = readFileSync(overridePath(), "utf8");
    const bad = catherd("treat-like", "foo", "gpt-6-sol#high");
    expect([bad.code, bad.out]).toEqual([2, ""]);
    expect(bad.err).toStartWith('error E_INPUT_INVALID: "foo" is not a rung\nfix: ');
    expect(readFileSync(overridePath(), "utf8")).toBe(before);
    expect(catherd("list", "--backend", "codex").code).toBe(0);
  });

  it("suggests the three nearest stand-ins, and clears and resets the user's mappings (spec 1.2 §6.4)", () => {
    withHome();
    const s = catherd("treat-like", "--suggest", "codex:gpt-5.6-terra#high");
    expect(s.code).toBe(0);
    const lines = s.out.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "gpt-5.6-terra#high has no repo_code, terminal, honesty value of its own; the nearest stand-ins:",
    );
    expect(
      lines.slice(1, 4).every((l) => /^ {2}[123]\. \S+#\S+ {2}distance \d+\.\d\d {2}lends \S/.test(l)),
    ).toBe(true);
    expect(lines[4]).toBe("map one: catherd catalog treat-like codex:gpt-5.6-terra#high <rung>");
    expect(
      JSON.parse(catherd("treat-like", "--suggest", "codex:gpt-5.6-terra#high", "--json").out).suggestions,
    ).toHaveLength(3);

    expect(catherd("treat-like", "codex:gpt-5.6-terra#high", "gpt-6-sol#high").code).toBe(0);
    const cleared = catherd("treat-like", "--clear", "codex:gpt-5.6-terra#high");
    expect([cleared.code, cleared.out]).toEqual([
      0,
      "✓ gpt-5.6-terra#high is no longer treated like gpt-6-sol#high\n",
    ]);
    const again = catherd("treat-like", "--clear", "codex:gpt-5.6-terra#high");
    expect([again.code, again.err.split("\n")[0]]).toEqual([
      2,
      "error E_INPUT_INVALID: gpt-5.6-terra#high has no treat-like of yours to clear",
    ]);
    expect(catherd("treat-like", "codex:gpt-5.6-terra#high", "gpt-6-sol#high").code).toBe(0);
    const reset = catherd("treat-like", "--reset");
    expect([reset.code, reset.out]).toEqual([
      0,
      "✓ removed 1 treat-like: gpt-5.6-terra#high → gpt-6-sol#high\n",
    ]);
    expect(catherd("treat-like", "--reset").out).toBe("no treat-like of yours to remove\n");
  });

  it("names the profile rungs a cleared mapping leaves on an inferred stand-in", () => {
    withHome();
    const worker = ["codex:gpt-6-luna#high", "codex:gpt-6-sol#medium", "codex:gpt-5.6-terra#high"];
    const set = Bun.spawnSync(
      [process.execPath, CLI, "profile", "set", "roles.worker.rungs", worker.join(",")],
      {
        env: {
          ...process.env,
          CATHERD_ORCHESTRATION_HOST: "claude-code",
          PATH: "/nonexistent",
          ANTHROPIC_API_KEY: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(set.exitCode).toBe(0);
    expect(catherd("treat-like", "codex:gpt-5.6-terra#high", "gpt-6-sol#high").code).toBe(0);
    const r = catherd("treat-like", "--clear", "gpt-5.6-terra#high");
    expect(r.out).toBe(
      [
        "! default: codex:gpt-5.6-terra#high is left on an inferred stand-in for repo_code, terminal, honesty",
        "✓ gpt-5.6-terra#high is no longer treated like gpt-6-sol#high",
        "",
      ].join("\n"),
    );
  });

  it("names the profile rungs a cleared mapping leaves with no value at all, in text and JSON", () => {
    withHome();
    const worker = ["codex:gpt-6-luna#high", "codex:gpt-6-sol#medium", "opencode:acme/foo-9#high"];
    const set = Bun.spawnSync(
      [process.execPath, CLI, "profile", "set", "roles.worker.rungs", worker.join(",")],
      {
        env: {
          ...process.env,
          CATHERD_ORCHESTRATION_HOST: "claude-code",
          PATH: "/nonexistent",
          ANTHROPIC_API_KEY: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(set.exitCode).toBe(0);
    expect(catherd("treat-like", "opencode:acme/foo-9#high", "gpt-6-sol#high").code).toBe(0);
    const r = catherd("treat-like", "--clear", "acme/foo-9#high");
    expect(r.out).toBe(
      [
        "! default: opencode:acme/foo-9#high is left unscored: routing skips it",
        "✓ acme/foo-9#high is no longer treated like gpt-6-sol#high",
        "",
      ].join("\n"),
    );
    expect(catherd("treat-like", "opencode:acme/foo-9#high", "gpt-6-sol#high").code).toBe(0);
    expect(JSON.parse(catherd("treat-like", "--reset", "--json").out).left).toEqual([
      { profile: "default", rung: "opencode:acme/foo-9#high", dims: [], unscored: true },
    ]);
  });

  it("refuses treat-like with neither a pair nor one of its flags, or with two of them, with exit 2", () => {
    withHome();
    for (const args of [
      [],
      ["codex:gpt-6-sol#high"],
      ["--reset", "--clear", "a#high"],
      ["a#high", "b#high", "--reset"],
    ]) {
      const r = catherd("treat-like", ...args);
      expect([r.code, r.err.split("\n")[0]]).toEqual([
        2,
        "error E_INPUT_INVALID: treat-like takes <rung> <like>, or one of --suggest, --clear, --reset",
      ]);
    }
  });

  it("refuses a treat-like for a rung that is already scored, with exit 1", () => {
    withHome();
    const r = catherd("treat-like", "codex:gpt-6-sol#high", "gpt-6-sol#xhigh");
    expect([r.code, r.out]).toEqual([1, ""]);
    expect(r.err).toStartWith("error E_CONFIG_INVALID: gpt-6-sol#high has scores of its own");
  });

  it("lists and refreshes opencode for the repository it runs in, and globally outside one", () => {
    withHome();
    const repo = realpathSync(tempRepo());
    const kimi = [{ id: "opencode-go/kimi-k3", efforts: [], context: 262144, imageIn: false }];
    const at = Date.parse("2026-09-25T10:00:00.000Z");
    writeDiscovery("opencode", kimi, at, repo);
    const path = gitOnlyPath();
    const inRepo = JSON.parse(catherdIn(repo, path, "list", "--text", "kimi", "--json").out);
    expect(inRepo.total).toBe(1);
    const outside = mkdtempSync(join(tmpdir(), "catherd-norepo-"));
    expect(JSON.parse(catherdIn(outside, path, "list", "--text", "kimi", "--json").out).total).toBe(0);
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

describe("catherd catalog sync (spec 1.2 §9)", () => {
  it("takes --force, --unmatched and --json", () => {
    withHome();
    const r = catherd("sync", "--help");
    expect(r.code).toBe(0);
    for (const flag of ["--force", "--unmatched", "--json"]) expect(r.out).toContain(flag);
  });

  it("prints a line per source, then the rungs newly scored, the stand-ins no longer needed and the warnings", () => {
    const report: SyncReport = {
      busy: false,
      sources: [
        { source: "models-dev", state: "fetched", fetchedAt: "2026-09-28T10:00:00.000Z" },
        { source: "arena", state: "fresh", fetchedAt: "2026-09-28T04:00:00.000Z" },
        { source: "vectara", state: "failed", fetchedAt: "2026-09-27T10:00:00.000Z", error: "http 503" },
        { source: "epoch", state: "failed", fetchedAt: null, error: "network error" },
        { source: "artificial-analysis", state: "skipped", fetchedAt: null, detail: "no key: catherd init" },
      ],
      newlyScored: ["claude-opus-5-5#high"],
      noLongerNeeded: [{ rung: "gpt-6-sol#high", like: "yardstick#high" }],
      failed: [],
      warnings: ["gpt-6-sol: input price $2/M on models.dev, $2.5/M on OpenRouter (more than 10 % apart)"],
      unmatched: {},
    };
    expect(syncLines(report, true)).toEqual([
      "+ models-dev: fetched",
      "- arena: fresh (fetched 2026-09-28T04:00:00.000Z)",
      "! vectara: http 503; keeps the answer fetched 2026-09-27T10:00:00.000Z",
      "! epoch: network error; no earlier answer",
      "- artificial-analysis: no key: catherd init",
      "newly scored: claude-opus-5-5#high",
      "stand-in no longer needed: gpt-6-sol#high has values of its own for what yardstick#high lent it",
      "! gpt-6-sol: input price $2/M on models.dev, $2.5/M on OpenRouter (more than 10 % apart)",
    ]);
    expect(syncLines({ ...report, busy: true })).toEqual([
      "- sources: another sync is running; its results apply when it ends",
    ]);
  });
});

it("forwards an explicit root host through catalog clear and reset without session evidence", () => {
  withHome();
  const env = { ...process.env, CATHERD_ORCHESTRATION_HOST: "", PATH: "/nonexistent", ANTHROPIC_API_KEY: "" };
  const run = (...args: string[]) =>
    Bun.spawnSync([process.execPath, CLI, "--host", "codex", "catalog", "treat-like", ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  expect(run("codex:gpt-5.6-terra#high", "gpt-6-sol#high").exitCode).toBe(0);
  expect(run("--clear", "codex:gpt-5.6-terra#high").exitCode).toBe(0);
  expect(run("codex:gpt-5.6-terra#high", "gpt-6-sol#high").exitCode).toBe(0);
  expect(run("--reset").exitCode).toBe(0);
});
