import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { knowledgeLines, readKnowledge } from "../../src/services/run-service.ts";
import { knowledgeFile } from "../../src/services/run-store.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { SRC } from "../import-graph.ts";

afterEach(snapshotEnv());

function catherd(args: string[], cwd?: string) {
  const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), "knowledge", ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", ANTHROPIC_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const EMPTY = "catherd: no knowledge recorded yet for this repo\n";

describe("catherd knowledge", () => {
  it("shows an empty repo's knowledge as empty, then what add appended, one line each", () => {
    withHome();
    const repo = tempRepo();
    expect(catherd(["show", "--repo", repo])).toEqual({ code: 0, out: EMPTY, err: "" });
    const added = catherd(["add", "the targeted test is bun test <file>", "--repo", repo]);
    expect(added.code).toBe(0);
    expect(added.out).toMatch(/^- \d{4}-\d{2}-\d{2} by hand: the targeted test is bun test <file>\n$/);
    expect(catherd(["add", "the full suite | needs\na DB", "--repo", repo]).code).toBe(0);
    const shown = catherd(["show", "--repo", repo]);
    expect(shown.code).toBe(0);
    expect(shown.out.split("\n")).toEqual([
      added.out.trimEnd(),
      expect.stringMatching(/^- \d{4}-\d{2}-\d{2} by hand: the full suite \/ needs\/a DB$/),
      "",
    ]);
    expect(readFileSync(knowledgeFile(repo), "utf8")).toBe(shown.out);
  });

  it("defaults to the repo it runs in, from any directory inside it", () => {
    withHome();
    const repo = tempRepo();
    const sub = join(repo, "pkg");
    mkdirSync(sub);
    expect(catherd(["path"], sub)).toEqual({ code: 0, out: `${knowledgeFile(repo)}\n`, err: "" });
    expect(catherd(["path", "--repo", sub]).out).toBe(`${knowledgeFile(repo)}\n`);
    expect(catherd(["add", "slow package: pkg"], sub).code).toBe(0);
    expect(catherd(["show", "--repo", repo]).out).toContain("by hand: slow package: pkg\n");
  });

  it("refuses a path outside a git repo, and an empty line", () => {
    withHome();
    const r = catherd(["show", "--repo", "/nonexistent"]);
    expect(r.code).toBe(1);
    expect(r.err).toStartWith("error E_IO_PATH: /nonexistent is not inside a git repository\n");
    const repo = tempRepo();
    const empty = catherd(["add", "  \n ", "--repo", repo]);
    expect(empty.code).toBe(2);
    expect(empty.err).toStartWith("error E_INPUT_INVALID: the knowledge line is empty\n");
    expect(catherd(["show", "--repo", repo]).out).toBe(EMPTY);
  });

  it("prints the repo, the file and its lines as JSON with --json", () => {
    withHome();
    const repo = tempRepo();
    const sub = join(repo, "pkg");
    mkdirSync(sub);
    const file = knowledgeFile(repo);
    const json = (...args: string[]) => {
      const r = catherd([...args, "--json"], sub);
      expect([r.code, r.err]).toEqual([0, ""]);
      return JSON.parse(r.out) as unknown;
    };
    expect(json("path")).toEqual({ repo, path: file });
    expect(json("show")).toEqual({ repo, path: file, lines: [] });
    const a = catherd(["add", "first"], sub).out.trimEnd();
    const b = catherd(["add", "second"], sub).out.trimEnd();
    expect(json("show")).toEqual({ repo, path: file, lines: [a, b] });
    const outside = catherd(["path", "--json", "--repo", "/nonexistent"]);
    expect([outside.code, outside.out]).toEqual([1, ""]);
    expect(outside.err).toStartWith("error E_IO_PATH:");
  });

  it("treats a knowledge.md with nothing in it as empty", async () => {
    withHome();
    const repo = tempRepo();
    mkdirSync(join(knowledgeFile(repo), ".."), { recursive: true });
    writeFileSync(knowledgeFile(repo), "\n");
    expect(await readKnowledge(repo)).toBe(EMPTY.trimEnd());
    expect((await knowledgeLines(repo)).lines).toEqual([]);
  });
});
