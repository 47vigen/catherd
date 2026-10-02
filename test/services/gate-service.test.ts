import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatRun } from "../../src/entry/runs-command.ts";
import { isCatherdError } from "../../src/domain/errors.ts";
import {
  failedItems,
  gateCheck,
  gatePass,
  gatesFile,
  latestVerifierStep,
  recordedItems,
} from "../../src/services/gate-service.ts";
import { createRun } from "../../src/services/run-store.ts";
import { summarizeRun } from "../../src/services/summary.ts";
import { snapshotEnv } from "../helpers.ts";
import { call, mcpClient } from "../mcp-helpers.ts";
import { fakeDeps, freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

function write(repo: string, file: string, text: string): void {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
}
function commit(repo: string): string {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
  return git("rev-parse", "--short", "HEAD").trim();
}

const item = (run: string, over: Record<string, unknown> = {}) => ({
  run,
  item: "unit tests",
  command: "bun test",
  paths: ["src/"],
  ...over,
});

describe("the gate ledger (spec 1.1 §7)", () => {
  it("carries a pass over while the command and the content of its paths are the same", async () => {
    const { repo, run } = freshRun();
    write(repo, "src/a.ts", "a");
    write(repo, "package.json", "{}");
    const c1 = commit(repo);
    const deps = fakeDeps();
    // a file path beside a directory path
    const both = (id: string, over: Record<string, unknown> = {}) =>
      item(id, { paths: ["src/", "package.json"], ...over });
    expect(await gateCheck(deps, both(run.id))).toEqual({ carried: false });
    const passed = await gatePass(deps, { ...both(run.id), evidence: "12 pass" });
    expect(passed.commit).toBe(c1);
    // an unrelated file changes: still carried, from the commit it passed on
    write(repo, "docs/x.md", "x");
    commit(repo);
    expect(await gateCheck(deps, both(run.id))).toMatchObject({ carried: true, commit: c1 });
    expect(await gateCheck(deps, both(run.id, { command: "bun test --bail" }))).toEqual({ carried: false });
    // a file under its paths changes: run it again
    write(repo, "src/a.ts", "b");
    commit(repo);
    expect(await gateCheck(deps, both(run.id))).toEqual({ carried: false });
  });

  it("hashes a dirty file's mode and type, not only its bytes: a lost exec bit or a symlink is not carried", async () => {
    const { repo, run } = freshRun();
    write(repo, "src/run.sh", "a");
    write(repo, "src/b.txt", "b");
    chmodSync(join(repo, "src/run.sh"), 0o755);
    commit(repo);
    const deps = fakeDeps();
    // both dirty, then passed on that tree
    write(repo, "src/run.sh", "echo hi");
    write(repo, "src/b.txt", "shared");
    write(repo, "src/target.txt", "shared");
    await gatePass(deps, { ...item(run.id), evidence: "ok" });
    expect(await gateCheck(deps, item(run.id))).toMatchObject({ carried: true });
    // the same bytes without the exec bit
    chmodSync(join(repo, "src/run.sh"), 0o644);
    expect(await gateCheck(deps, item(run.id))).toEqual({ carried: false });
    chmodSync(join(repo, "src/run.sh"), 0o755);
    expect(await gateCheck(deps, item(run.id))).toMatchObject({ carried: true });
    // the same bytes behind a symlink
    rmSync(join(repo, "src/b.txt"));
    symlinkSync("target.txt", join(repo, "src/b.txt"));
    expect(await gateCheck(deps, item(run.id))).toEqual({ carried: false });
  });

  it("hashes a gate file's committed mode: a committed chmod -x of a script is not carried", async () => {
    const { repo, run } = freshRun();
    write(repo, "run.sh", "echo hi");
    chmodSync(join(repo, "run.sh"), 0o755);
    commit(repo);
    const deps = fakeDeps();
    const script = item(run.id, { paths: ["run.sh"] });
    await gatePass(deps, { ...script, evidence: "ok" });
    expect(await gateCheck(deps, script)).toMatchObject({ carried: true });
    // the same blob, committed without the exec bit: the tree is clean again
    chmodSync(join(repo, "run.sh"), 0o644);
    commit(repo);
    expect(await gateCheck(deps, script)).toEqual({ carried: false });
  });

  it("hashes uncommitted changes under its paths, so a verifier on an uncommitted tree gets its own hash", async () => {
    const { repo, run } = freshRun();
    write(repo, "src/a.ts", "a");
    commit(repo);
    const deps = fakeDeps();
    write(repo, "src/a.ts", "dirty");
    await gatePass(deps, { ...item(run.id), evidence: "ok" });
    expect((await gateCheck(deps, item(run.id))).carried).toBe(true);
    write(repo, "src/a.ts", "dirtier");
    expect((await gateCheck(deps, item(run.id))).carried).toBe(false);
    // a pass on "." carries until a new, untracked file appears under it
    await gatePass(deps, { ...item(run.id, { paths: ["."] }), evidence: "ok" });
    expect((await gateCheck(deps, item(run.id, { paths: ["."] }))).carried).toBe(true);
    write(repo, "src/new.ts", "n");
    expect((await gateCheck(deps, item(run.id, { paths: ["."] }))).carried).toBe(false);
  });

  it("keeps the ledger per repo, beside knowledge.md, and a pass is found from another run of the repo", async () => {
    const { repo, run } = freshRun();
    write(repo, "src/a.ts", "a");
    commit(repo);
    await gatePass(fakeDeps(), { ...item(run.id), evidence: "ok" });
    expect(await Bun.file(gatesFile(repo)).text()).toContain('"evidence":"ok"');
    const other = createRun({ repo, title: "second", aLines: ["A1 it works"], version: "0.0.0-test" });
    expect(other.id).not.toBe(run.id);
    expect(await gateCheck(fakeDeps(), item(other.id))).toMatchObject({ carried: true });
  });

  it("refuses a path that leaves the repo", async () => {
    const { run } = freshRun();
    try {
      await gateCheck(fakeDeps(), item(run.id, { paths: ["../x"] }));
      throw new Error("expected a refusal");
    } catch (e) {
      expect(isCatherdError(e) && e.code).toBe("E_INPUT_INVALID");
    }
  });

  it("refuses a path that exists neither at HEAD nor in the working tree, recording nothing", async () => {
    const { repo, run } = freshRun();
    write(repo, "src/a.ts", "a");
    commit(repo);
    write(repo, "lib/new.ts", "n");
    // thunks: each call is awaited as it is made, so none rejects unhandled while another is awaited
    for (const call of [
      () => gateCheck(fakeDeps(), item(run.id, { paths: ["src/", "scr/"] })),
      () => gatePass(fakeDeps(), { ...item(run.id, { paths: ["scr/"] }), evidence: "e" }),
    ]) {
      const e = await (call() as Promise<unknown>).then(
        () => null,
        (x: unknown) => x,
      );
      expect(isCatherdError(e) && [e.code, e.message]).toEqual([
        "E_INPUT_INVALID",
        "gate path scr/ exists neither at HEAD nor in the working tree",
      ]);
      expect(isCatherdError(e) && e.fix).toContain("check the spelling");
    }
    expect(latestVerifierStep(run)).toBeNull();
    // a path only in the working tree (not committed yet) is fine
    expect(await gateCheck(fakeDeps(), item(run.id, { paths: ["lib/"] }))).toEqual({ carried: false });
  });

  it("hashes an ignored path named explicitly by its content on disk: a changed .env is not carried", async () => {
    const { repo, run } = freshRun();
    write(repo, ".gitignore", ".env\ngen/\n");
    write(repo, "src/a.ts", "a");
    commit(repo);
    write(repo, ".env", "A=1");
    write(repo, "gen/out/x.js", "x");
    write(repo, "gen/y.js", "y");
    const deps = fakeDeps();
    const env = item(run.id, { paths: [".env", "gen/"] });
    await gatePass(deps, { ...env, evidence: "ok" });
    expect(await gateCheck(deps, env)).toMatchObject({ carried: true });
    write(repo, ".env", "A=2");
    expect(await gateCheck(deps, env)).toEqual({ carried: false });
    write(repo, ".env", "A=1");
    expect(await gateCheck(deps, env)).toMatchObject({ carried: true });
    // a file deep in an ignored directory, its exec bit, and a new file there
    write(repo, "gen/out/x.js", "z");
    expect(await gateCheck(deps, env)).toEqual({ carried: false });
    write(repo, "gen/out/x.js", "x");
    chmodSync(join(repo, "gen/y.js"), 0o755);
    expect(await gateCheck(deps, env)).toEqual({ carried: false });
    chmodSync(join(repo, "gen/y.js"), 0o644);
    expect(await gateCheck(deps, env)).toMatchObject({ carried: true });
    write(repo, "gen/new.js", "n");
    expect(await gateCheck(deps, env)).toEqual({ carried: false });
    rmSync(join(repo, "gen/new.js"));
    // "." still hashes HEAD and the not-ignored status: an ignored file is covered only when named
    const whole = item(run.id, { paths: ["."] });
    await gatePass(deps, { ...whole, evidence: "ok" });
    write(repo, ".env", "A=3");
    expect(await gateCheck(deps, whole)).toMatchObject({ carried: true });
  });

  it("hashes a symlinked gate path by its target's content too: a changed target is not carried", async () => {
    const { repo, run } = freshRun();
    write(repo, ".gitignore", "shared/\n");
    write(repo, "src/a.ts", "a");
    write(repo, "shared/secrets.env", "A=1");
    write(repo, "shared/conf/x.json", "{}");
    symlinkSync("shared/secrets.env", join(repo, ".env"));
    symlinkSync("shared/conf", join(repo, "conf"));
    symlinkSync("shared/missing", join(repo, "dangling"));
    commit(repo);
    const deps = fakeDeps();
    const env = item(run.id, { paths: [".env", "conf", "dangling"] });
    await gatePass(deps, { ...env, evidence: "ok" });
    expect(await gateCheck(deps, env)).toMatchObject({ carried: true });
    write(repo, "shared/secrets.env", "A=2");
    expect(await gateCheck(deps, env)).toEqual({ carried: false });
    write(repo, "shared/secrets.env", "A=1");
    expect(await gateCheck(deps, env)).toMatchObject({ carried: true });
    // a symlinked directory is walked: a file changed in it, and a new file there
    write(repo, "shared/conf/x.json", "{1}");
    expect(await gateCheck(deps, env)).toEqual({ carried: false });
    write(repo, "shared/conf/x.json", "{}");
    write(repo, "shared/conf/y.json", "{}");
    expect(await gateCheck(deps, env)).toEqual({ carried: false });
    rmSync(join(repo, "shared/conf/y.json"));
    expect(await gateCheck(deps, env)).toMatchObject({ carried: true });
    // a dangling link that comes to point at something
    write(repo, "shared/missing", "m");
    expect(await gateCheck(deps, env)).toEqual({ carried: false });
    rmSync(join(repo, "shared/missing"));
    // a symlink inside a walked ignored directory, and a cycle, which terminates
    symlinkSync("../secrets.env", join(repo, "shared/conf/link.env"));
    symlinkSync("..", join(repo, "shared/conf/up"));
    const walked = item(run.id, { paths: ["shared/conf"] });
    await gatePass(deps, { ...walked, evidence: "ok" });
    expect(await gateCheck(deps, walked)).toMatchObject({ carried: true });
    write(repo, "shared/secrets.env", "A=3");
    expect(await gateCheck(deps, walked)).toEqual({ carried: false });
  });

  it("refuses an ignored directory with more files than it walks, naming narrower paths", async () => {
    const { repo, run } = freshRun();
    write(repo, ".gitignore", "big/\n");
    commit(repo);
    for (let i = 0; i < 10_001; i++) write(repo, `big/d${i % 10}/f${i}`, "");
    try {
      await gateCheck(fakeDeps(), item(run.id, { paths: ["big/"] }));
      expect.unreachable();
    } catch (e) {
      expect(isCatherdError(e) && e.code).toBe("E_INPUT_INVALID");
      expect(isCatherdError(e) && e.message).toContain("big");
      expect(isCatherdError(e) && e.fix).toContain("narrower");
    }
  });

  it("hashes an absent ignored output as absent, not as an error, and its build as new content", async () => {
    const { repo, run } = freshRun();
    write(repo, ".gitignore", "dist/\n");
    write(repo, "apps/checkout/src/a.ts", "a");
    commit(repo);
    const deps = fakeDeps();
    const built = item(run.id, { paths: ["apps/checkout/", "apps/checkout/dist"] });
    expect(await gateCheck(deps, built)).toEqual({ carried: false });
    await gatePass(deps, { ...built, evidence: "ok" });
    expect(await gateCheck(deps, built)).toMatchObject({ carried: true });
    write(repo, "apps/checkout/dist/index.js", "x");
    expect(await gateCheck(deps, built)).toEqual({ carried: false });
  });

  it("covers dependencies through the tracked lockfiles, never walking node_modules under a named path", async () => {
    const { repo, run } = freshRun();
    write(repo, ".gitignore", "node_modules/\n");
    write(repo, "apps/web/src/a.ts", "a");
    write(repo, "bun.lock", "v1");
    write(repo, "apps/web/package.json", "{}");
    commit(repo);
    // more files than a walk takes, under an ignored folder inside the gate's paths
    for (let i = 0; i < 10_001; i++) write(repo, `node_modules/.bun/p${i % 10}/f${i}`, "");
    const deps = fakeDeps();
    const whole = item(run.id, { paths: ["."] });
    const web = item(run.id, { paths: ["apps/web/"] });
    await gatePass(deps, { ...whole, evidence: "ok" });
    await gatePass(deps, { ...web, evidence: "ok" });
    expect(await gateCheck(deps, whole)).toMatchObject({ carried: true });
    // a lockfile change outside apps/web/ still reaches the apps/web/ item
    write(repo, "bun.lock", "v2");
    commit(repo);
    expect(await gateCheck(deps, web)).toEqual({ carried: false });
    expect(await gateCheck(deps, whole)).toEqual({ carried: false });
  });

  it("records each check as the verifier's step, which status shows", async () => {
    const { repo, run } = freshRun();
    write(repo, "src/a.ts", "a");
    commit(repo);
    const deps = fakeDeps({ now: () => Date.parse("2026-09-28T10:05:00Z") });
    await gateCheck(deps, item(run.id, { item: "boot check" }));
    expect(latestVerifierStep(run)).toEqual({
      at: "2026-09-28T10:05:00.000Z",
      item: "boot check",
      command: "bun test",
      carried: false,
    });
    const s = summarizeRun(deps, run);
    expect(s.verifier?.item).toBe("boot check");
    expect(formatRun(s)).toContain("  verifier step boot check at 10:05 · 0 min ago · open");
  });

  it("serves gate_check and gate_pass over MCP", async () => {
    const { repo, run } = freshRun();
    write(repo, "src/a.ts", "a");
    commit(repo);
    const c = await mcpClient(fakeDeps());
    expect((await call(c, "gate_check", item(run.id))).data).toEqual({ carried: false });
    expect((await call(c, "gate_pass", { ...item(run.id), evidence: "ok" })).data.recorded).toBe(true);
    expect((await call(c, "gate_check", item(run.id))).data.carried).toBe(true);
    // the optional milestone lands on the verifier's step
    expect((await call(c, "gate_check", item(run.id, { milestone: "M1" }))).data.carried).toBe(true);
    expect(latestVerifierStep(run)).toMatchObject({ item: "unit tests", carried: true, milestone: "M1" });
    // the list alone, recording no step; half an item is refused
    expect((await call(c, "gate_check", { run: run.id, milestone: "M1" })).data).toEqual({
      recorded: [{ item: "unit tests", command: "bun test", passed: true }],
    });
    expect((await call(c, "gate_check", { run: run.id, item: "x", milestone: "M1" })).error?.code).toBe(
      "E_INPUT_INVALID",
    );
    expect((await call(c, "gate_check", { run: run.id })).error?.code).toBe("E_INPUT_INVALID");
  });

  it("lists the milestone's recorded items with whether each passed, so a new verifier reuses their names (plan 23)", async () => {
    const { repo, run } = freshRun();
    write(repo, "src/a.ts", "a");
    commit(repo);
    const deps = fakeDeps();
    const m1 = (name: string, over: Record<string, unknown> = {}) =>
      item(run.id, { item: name, command: `run ${name}`, milestone: "M1", ...over });
    expect(await gateCheck(deps, m1("lint"))).toEqual({
      carried: false,
      recorded: [{ item: "lint", command: "run lint", passed: false }],
    });
    await gatePass(deps, { ...m1("lint"), evidence: "ok" });
    await gateCheck(deps, m1("acceptance"));
    // another milestone's items stay out
    await gateCheck(deps, item(run.id, { item: "boot", milestone: "M2" }));
    expect(recordedItems(run, "M1")).toEqual([
      { item: "lint", command: "run lint", passed: true },
      { item: "acceptance", command: "run acceptance", passed: false },
    ]);
    expect(failedItems(run, "M1")).toEqual(["acceptance"]);
    // a second check of an item that passed, not carried (its content changed), is open again
    write(repo, "src/a.ts", "b");
    await gateCheck(fakeDeps({ now: () => Date.now() + 1000 }), m1("lint"));
    expect(failedItems(run, "M1")).toEqual(["lint", "acceptance"]);
  });
});
