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
import { runPaths } from "../../src/services/run-store.ts";
import { snapshotEnv, tempDir } from "../helpers.ts";
import { fakeDeps, freshRun, testView, writeLane } from "./helpers.ts";

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
