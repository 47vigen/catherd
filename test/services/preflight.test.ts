import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryLock } from "../../src/infra/filelock.ts";
import { resetLoginEnv } from "../../src/infra/login-env.ts";
import { locksDir } from "../../src/infra/paths.ts";
import { setGateEnv } from "../../src/services/gate-env.ts";
import {
  classify,
  preflight,
  preflightLimits,
  preflightUser,
  runCheck,
} from "../../src/services/preflight.ts";
import { copyPlanInputs } from "../../src/services/plan-input.ts";
import { appendEvent } from "../../src/services/run-events-store.ts";
import { runPaths } from "../../src/services/run-store.ts";
import { startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv, tempDir } from "../helpers.ts";
import { claimTree } from "../../src/services/milestone-tree.ts";
import { branchRun, fakeDeps, freshRun, PLAN_TEXT, testView, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());
// every other test runs its checks as a normal user, whoever runs the suite
const realUid = preflightUser.uid;
beforeEach(() => {
  preflightUser.uid = () => 1000;
});
afterEach(() => {
  preflightUser.uid = realUid;
});

const outcomes = (r: Awaited<ReturnType<typeof preflight>>) =>
  r.needsConfirmation ? [] : r.results.map((x) => [x.lane, x.outcome]);

describe("preflight in a worktree (plan 35)", () => {
  it("preflights a base-run milestone's lanes in its tree", async () => {
    const { run } = branchRun();
    const { tree } = await claimTree(fakeDeps(), run, "M1", { known: false });
    writeFileSync(join(tree, "marker"), "here");
    writeLane(run, "M1.L1", ["src/a.ts"], "test -f marker");
    // the marker is in the tree only: the repo would fail this check
    expect(outcomes(await preflight(fakeDeps(), { run: run.id, milestone: "M1" }))).toEqual([
      ["M1.L1", "pass"],
    ]);
    // a run without base checks in the repo as before
    const plain = freshRun();
    writeLane(plain.run, "M1.L1", ["src/a.ts"], "test -f marker");
    expect(outcomes(await preflight(fakeDeps(), { run: plain.run.id, milestone: "M1" }))).toEqual([
      ["M1.L1", "fails-as-expected"],
    ]);
  });
});

describe("preflight", () => {
  it("sorts each lane's check into pass, fails-as-expected, skipped and cannot-start", async () => {
    const { repo, run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"], "true");
    writeLane(run, "M1.L2", ["src/b.ts"], "echo nope; exit 1");
    writeLane(run, "M1.L3", ["src/new.ts"], "bun test src/new.ts");
    writeLane(run, "M1.L4", ["src/d.ts"], "no-such-command-catherd --flag");
    writeFileSync(
      join(run.dir, "lanes", "M1.L5.md"),
      "# M1.L5 — no check\nOwns: src/e.ts\nKind: repo_code\nDifficulty: build\n",
    );
    mkdirSync(join(repo, "src"));
    const r = await preflight(fakeDeps(), { run: run.id });
    expect(outcomes(r)).toEqual([
      ["M1.L1", "pass"],
      ["M1.L2", "fails-as-expected"],
      ["M1.L3", "skipped"],
      ["M1.L4", "cannot-start"],
      ["M1.L5", "cannot-start"],
    ]);
    if (r.needsConfirmation) throw new Error("unexpected");
    expect(r.blocked).toBe(true);
    expect(r.results[1]?.tail).toEqual(["nope"]);
    expect(r.results[4]?.note).toBe("lanes/M1.L5.md has no Fast check: line");
  });

  it("passes an absence check whose every hit is one of the lane's Allow: exceptions", async () => {
    const { run } = freshRun();
    const grep = (hits: string) => `printf '${hits}'; exit 1`;
    writeLane(
      run,
      "M1.L1",
      ["src/a.go"],
      grep("src/job/command.go:120:func Allowed()\\n"),
      "Kind: repo_code\nDifficulty: build\nAllow: src/job/command.go:120\n",
    );
    writeLane(
      run,
      "M1.L2",
      ["src/a.go"],
      grep("src/job/command.go:121:func Allowed()\\n"),
      "Kind: repo_code\nDifficulty: build\nAllow: src/job/command.go:120\n",
    );
    const r = await preflight(fakeDeps(), { run: run.id });
    expect(outcomes(r)).toEqual([
      ["M1.L1", "pass"],
      ["M1.L2", "fails-as-expected"],
    ]);
    if (!r.needsConfirmation) expect(r.results[0]?.note).toBe("every hit is an Allow: exception (1)");
  });

  it("stops a check at its timeout and calls it cannot-start", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"], "sleep 5");
    const started = Date.now();
    const r = await preflight(fakeDeps(), { run: run.id, timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(outcomes(r)).toEqual([["M1.L1", "cannot-start"]]);
    if (!r.needsConfirmation) expect(r.results[0]?.note).toBe("timed out after 0.2 s");
  });

  it("returns when the check exits although a process it detached still holds the pipes", async () => {
    const { run } = freshRun();
    // a process in its own session (setsid is Linux-only; Bun detaches the same way everywhere)
    const detach = `'${process.execPath}' -e 'Bun.spawn(["sleep", "6"], { detached: true, stdio: ["ignore", "inherit", "inherit"] }).unref()'`;
    writeLane(run, "M1.L1", ["src/a.ts"], `${detach}; echo started`);
    const started = Date.now();
    const r = await preflight(fakeDeps({ view: testView({ heavy: 1 }) }), { run: run.id, timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(2_000);
    if (r.needsConfirmation) throw new Error("unexpected");
    expect(r.results).toMatchObject([{ lane: "M1.L1", outcome: "pass", exitCode: 0, tail: ["started"] }]);
    // the heavy slot was released
    const release = tryLock(join(locksDir(), "slot-0"));
    expect(release).not.toBeNull();
    release?.();
  });

  it("runs checks without catherd's secrets", async () => {
    const { run } = freshRun();
    process.env.TYPESAFE_API_KEY = "secret";
    writeLane(run, "M1.L1", ["src/a.ts"], 'test -z "$TYPESAFE_API_KEY"');
    expect(outcomes(await preflight(fakeDeps(), { run: run.id }))).toEqual([["M1.L1", "pass"]]);
  });

  it("a preflight check runs with CATHERD_LOCK_HELD", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"], "printenv CATHERD_LOCK_HELD");
    const r = await preflight(fakeDeps(), { run: run.id });
    if (r.needsConfirmation) throw new Error("unexpected");
    expect(r.results).toMatchObject([{ lane: "M1.L1", outcome: "pass", tail: ["1"] }]);
  });

  it("runs checks with an allowlisted env: no backend credentials, but PATH and PWD (spec §4.7)", async () => {
    const { repo } = freshRun();
    Object.assign(process.env, {
      OPENAI_API_KEY: "sk-openai",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GH_TOKEN: "gh-token",
      TYPESAFE_API_KEY: "ts-secret",
    });
    const r = await runCheck(
      repo,
      "env | grep -E '^(PATH|PWD|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|GH_TOKEN|TYPESAFE_API_KEY)='",
      10_000,
    );
    const names = r.tail.map((l) => l.split("=")[0]).sort();
    expect(names).toEqual(["PATH", "PWD"]);
    expect(r.tail).toContain(`PWD=${repo}`);
  });

  it("with confirm on, lists the commands and runs nothing until confirmed", async () => {
    const { repo, run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"], "touch ran");
    const deps = fakeDeps({ view: testView({ preflight: { confirm: true } }) });
    expect(await preflight(deps, { run: run.id })).toEqual({
      needsConfirmation: true,
      commands: [{ lane: "M1.L1", check: "touch ran" }],
      lint: [],
    });
    expect(existsSync(join(repo, "ran"))).toBe(false);
    expect(outcomes(await preflight(deps, { run: run.id, confirmed: true }))).toEqual([["M1.L1", "pass"]]);
    expect(existsSync(join(repo, "ran"))).toBe(true);
  });

  it("waits for a free heavy slot", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"], "true");
    mkdirSync(locksDir(), { recursive: true });
    const release = tryLock(join(locksDir(), "slot-0"));
    const started = Date.now();
    setTimeout(() => release?.(), 300);
    await preflight(fakeDeps({ view: testView({ heavy: 1 }) }), { run: run.id });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it("never runs a check as root, unless IS_SANDBOX says the machine is disposable (spec §10.4)", async () => {
    const { run } = freshRun();
    const ran = join(run.dir, "ran");
    writeLane(run, "M1.L1", ["src/a.ts"], `touch '${ran}'`);
    preflightUser.uid = () => 0;
    delete process.env.IS_SANDBOX;
    const r = await preflight(fakeDeps(), { run: run.id });
    expect(outcomes(r)).toEqual([["M1.L1", "skipped"]]);
    if (!r.needsConfirmation) expect(r.results[0]?.note).toContain("never runs a lane's check as root");
    expect(existsSync(ran)).toBe(false);
    process.env.IS_SANDBOX = "1";
    expect(outcomes(await preflight(fakeDeps(), { run: run.id }))).toEqual([["M1.L1", "pass"]]);
    expect(existsSync(ran)).toBe(true);
  });

  it("classifies by exit code first, then by a missing command", () => {
    expect(classify({ code: 0, timedOut: false, tail: ["sh: x: command not found"] })).toBe("pass");
    expect(classify({ code: 1, timedOut: false, tail: ["sh: x: command not found"] })).toBe("cannot-start");
    expect(classify({ code: 126, timedOut: false, tail: [] })).toBe("cannot-start");
    expect(classify({ code: 2, timedOut: false, tail: ["1 failing"] })).toBe("fails-as-expected");
  });

  it("calls an environment error cannot-start, never fails-as-expected (plan 23)", () => {
    for (const line of [
      "panic: rootless Docker not found",
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      "dial tcp: lookup proxy.golang.org: no such host",
      "curl: (6) Could not resolve host: registry.npmjs.org",
      "open /Users/me/Library/Caches/go-build/ab: operation not permitted",
    ])
      expect(classify({ code: 1, timedOut: false, tail: ["--- FAIL", line] })).toBe("cannot-start");
    // pnpm passes an empty filter: nothing to run yet
    expect(classify({ code: 0, timedOut: false, tail: ['No projects matched the filters in "/repo"'] })).toBe(
      "skipped",
    );
  });

  it("skips an empty pnpm filter only when nothing else in the check failed", () => {
    const tail = [
      'No projects matched the filters in "/repo"',
      "Cannot connect to the Docker daemon at unix:///x",
    ];
    // a later command failed: what it says decides, never "skipped"
    expect(classify({ code: 1, timedOut: false, tail })).toBe("cannot-start");
    expect(classify({ code: 1, timedOut: false, tail: [tail[0] as string, "1 failing"] })).toBe(
      "fails-as-expected",
    );
    expect(
      classify(
        { code: 1, timedOut: false, tail: [tail[0] as string, "1 failing"] },
        "pnpm --filter new-package test; docker compose up",
      ),
    ).toBe("fails-as-expected");
    // a single pnpm --filter invocation: the unmatched filter is its only failure, whatever pnpm exits with
    expect(
      classify({ code: 1, timedOut: false, tail: [tail[0] as string] }, "pnpm --filter new-package test"),
    ).toBe("skipped");
  });

  it("runs only the lanes of milestones not landed, or the milestone named (plan 23)", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"], "true");
    writeLane(run, "M2.L1", ["src/b.ts"], "true");
    writeLane(run, "M2.L2", ["src/c.ts"], "true");
    appendFileSync(runPaths(run.dir).ledger, "M1 | w | abc1234 | 3 | ok\n");
    expect(outcomes(await preflight(fakeDeps(), { run: run.id }))).toEqual([
      ["M2.L1", "pass"],
      ["M2.L2", "pass"],
    ]);
    expect(outcomes(await preflight(fakeDeps(), { run: run.id, milestone: "M1" }))).toEqual([
      ["M1.L1", "pass"],
    ]);
  });

  it("reports lock-busy when no heavy slot comes free within its wait budget (plan 23)", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"], "true");
    mkdirSync(locksDir(), { recursive: true });
    const release = tryLock(join(locksDir(), "slot-0"));
    const saved = preflightLimits.lockWaitMs;
    preflightLimits.lockWaitMs = 100;
    try {
      const r = await preflight(fakeDeps({ view: testView({ heavy: 1 }) }), { run: run.id });
      expect(outcomes(r)).toEqual([["M1.L1", "lock-busy"]]);
      if (!r.needsConfirmation) expect(r.blocked).toBe(false);
    } finally {
      preflightLimits.lockWaitMs = saved;
      release?.();
    }
  });

  it("runs a check in the login env and the repo's gate env, and names the environment error (plan 23)", async () => {
    const { repo, run } = freshRun();
    const dir = tempDir("catherd-shell-");
    const shell = join(dir, "login");
    writeFileSync(shell, `#!/bin/sh\nprintf 'DOCKER_HOST=unix:///login/docker.sock\\0PATH=/login/bin\\0'\n`);
    chmodSync(shell, 0o755);
    process.env.SHELL = shell;
    resetLoginEnv();
    await setGateEnv(repo, "TESTCONTAINERS_RYUK_DISABLED", { value: "true" });
    writeLane(
      run,
      "M1.L1",
      ["src/a.ts"],
      'test "$DOCKER_HOST" = unix:///login/docker.sock && test "$TESTCONTAINERS_RYUK_DISABLED" = true && echo "${PATH%%:*}"',
    );
    writeLane(run, "M1.L2", ["src/b.ts"], "echo 'Could not find a valid Docker environment' >&2; exit 1");
    const r = await preflight(fakeDeps(), { run: run.id });
    resetLoginEnv();
    expect(outcomes(r)).toEqual([
      ["M1.L1", "pass"],
      ["M1.L2", "cannot-start"],
    ]);
    if (r.needsConfirmation) throw new Error("unexpected");
    expect(r.results[0]?.tail).toEqual(["/login/bin"]);
    expect(r.results[1]?.note).toBe("environment: Could not find a valid Docker environment");
  });

  it("warns about a fast check with no lint step when the repo has a linter (plan 23)", async () => {
    const { repo, run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"], "true");
    writeLane(run, "M1.L2", ["src/b.ts"], "go test ./x/... && golangci-lint run ./x/...");
    const none = await preflight(fakeDeps(), { run: run.id });
    if (!none.needsConfirmation) expect(none.warnings).toEqual([]);
    writeFileSync(join(repo, ".golangci.yml"), "linters: {}\n");
    const r = await preflight(fakeDeps(), { run: run.id });
    if (r.needsConfirmation) throw new Error("unexpected");
    expect(r.warnings).toEqual([
      "M1.L1: its fast check runs no linter, and the repo has one (golangci-lint): add the linter of every package the lane touches to its Fast check: line",
    ]);
  });
});

describe("preflight lint (plan 34)", () => {
  const LINT = "M1.L2: After: M1.L1 shares no file with it: drop it unless M1.L2 needs M1.L1's output";

  it("returns the plan's lint beside its results, and lint never blocks (plan 34)", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"], "true");
    writeLane(run, "M1.L2", ["src/b.ts"], "true", "Kind: repo_code\nDifficulty: build\nAfter: M1.L1\n");
    const r = await preflight(fakeDeps(), { run: run.id });
    if (r.needsConfirmation) throw new Error("unexpected");
    expect(r.blocked).toBe(false);
    expect(r.lint).toContain(LINT);
    const confirm = await preflight(fakeDeps({ view: testView({ preflight: { confirm: true } }) }), {
      run: run.id,
    });
    expect(confirm.needsConfirmation).toBe(true);
    expect(confirm.lint).toContain(LINT);
  });

  it("blocks a lane whose After: can never finish, naming why (plan 34)", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"], "true", "Kind: repo_code\nDifficulty: build\nAfter: M1.L9\n");
    const r = await preflight(fakeDeps(), { run: run.id });
    if (r.needsConfirmation) throw new Error("unexpected");
    expect(r.blocked).toBe(true);
    expect(r.results).toContainEqual({
      lane: "M1.L1",
      check: null,
      outcome: "cannot-start",
      exitCode: null,
      tail: [],
      note: "M1.L1: After: M1.L9 has no lane file",
    });
  });
});

describe("preflight lint (plan 40)", () => {
  it("an ignored Owns entry is a lint warning", async () => {
    const { repo, run } = freshRun();
    writeFileSync(join(repo, ".gitignore"), "gen/\n");
    writeLane(run, "M1.L1", ["gen/client.ts"], "true");
    const r = await preflight(fakeDeps(), { run: run.id });
    if (r.needsConfirmation) throw new Error("unexpected");
    expect(r.lint).toEqual(["M1.L1: Owns gen/client.ts is ignored by git: catherd cannot commit it"]);
    expect(r.blocked).toBe(false);
  });

  it("the plan's lint for the milestone it checks joins preflight's lint", async () => {
    const { run } = freshRun();
    writeFileSync(runPaths(run.dir).plan, "## M1 — one\nA1 — tests failed before the code\n");
    writeLane(run, "M1.L1", ["src/a.ts"], "true");
    const r = await preflight(fakeDeps(), { run: run.id, milestone: "M1" });
    if (r.needsConfirmation) throw new Error("unexpected");
    expect(r.lint).toEqual([
      "M1: no Check: line: the verifier must run the whole gate by hand",
      "M1: A1 is about process (failed before), not the product: no gate judges it",
    ]);
  });
});

describe("preflight of a daemon run (plan 32)", () => {
  const BAD_PLAN = `${PLAN_TEXT}\n### Task 4: prose\nJust do it.\n`;
  async function daemon(planText = BAD_PLAN) {
    const { repo, run } = freshRun();
    const file = join(repo, "p.md");
    writeFileSync(file, planText);
    await appendEvent(run, { type: "run.started", ...startedFields, repo, plan: [file] });
    copyPlanInputs(run, [file]);
    return { repo, run };
  }
  const withTasks = (tasks: string) => `Kind: repo_code\nDifficulty: build\nTasks: ${tasks}\n`;

  it("starts a lane with no task, a task the plan does not have, and a task with no test", async () => {
    const { repo, run } = await daemon();
    const marker = join(repo, "ran");
    writeLane(run, "M1.L1", ["src/a.ts"], `touch ${marker}`);
    writeLane(run, "M1.L2", ["src/b.ts"], "true", withTasks("4, 9203"));
    const r = await preflight(fakeDeps(), { run: run.id, milestone: "M1" });
    expect(r).toMatchObject({ needsConfirmation: false, blocked: false });
    expect(outcomes(r)).toEqual([
      ["M1.L1", "pass"],
      ["M1.L2", "pass"],
    ]);
    expect(existsSync(marker)).toBe(true);
  });

  it("asks for the confirm list and passes", async () => {
    const { repo, run } = await daemon(PLAN_TEXT);
    const deps = fakeDeps({ view: testView({ preflight: { confirm: true } }) });
    writeLane(run, "M1.L1", ["src/a.ts"], "true");
    const listed = await preflight(deps, { run: run.id, milestone: "M1" });
    expect(listed.needsConfirmation).toBe(true);
    const ok = await preflight(deps, { run: run.id, milestone: "M1", confirmed: true });
    if (ok.needsConfirmation) throw new Error("unexpected");
    expect(ok).toMatchObject({ blocked: false });
    expect(outcomes(ok)).toEqual([["M1.L1", "pass"]]);
    expect(existsSync(repo)).toBe(true);
  });

  it("leaves a run that is not a daemon run as 1.5 preflight", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"], "true");
    const r = await preflight(fakeDeps(), { run: run.id });
    expect(outcomes(r)).toEqual([["M1.L1", "pass"]]);
  });
});
