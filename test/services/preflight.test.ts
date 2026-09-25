import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryLock } from "../../src/infra/filelock.ts";
import { locksDir } from "../../src/infra/paths.ts";
import { classify, preflight } from "../../src/services/preflight.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, testView, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

const outcomes = (r: Awaited<ReturnType<typeof preflight>>) =>
  r.needsConfirmation ? [] : r.results.map((x) => [x.lane, x.outcome]);

describe("preflight", () => {
  it("sorts each lane's check into pass, fails-as-expected, skipped and cannot-start", async () => {
    const { repo, run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"], "true");
    writeLane(run, "M1.L2", ["src/b.ts"], "echo nope; exit 1");
    writeLane(run, "M1.L3", ["src/new.ts"], "bun test src/new.ts");
    writeLane(run, "M1.L4", ["src/d.ts"], "no-such-command-catherd --flag");
    writeFileSync(join(run.dir, "lanes", "M1.L5.md"), "# M1.L5 — no check\nOwns: src/e.ts\n");
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

  it("stops a check at its timeout and calls it cannot-start", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"], "sleep 5");
    const started = Date.now();
    const r = await preflight(fakeDeps(), { run: run.id, timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(outcomes(r)).toEqual([["M1.L1", "cannot-start"]]);
    if (!r.needsConfirmation) expect(r.results[0]?.note).toBe("timed out after 0.2 s");
  });

  it("runs checks without catherd's secrets", async () => {
    const { run } = freshRun();
    process.env.TYPESAFE_API_KEY = "secret";
    writeLane(run, "M1.L1", ["src/a.ts"], 'test -z "$TYPESAFE_API_KEY"');
    expect(outcomes(await preflight(fakeDeps(), { run: run.id }))).toEqual([["M1.L1", "pass"]]);
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

  it("classifies by exit code first, then by a missing command", () => {
    expect(classify({ code: 0, timedOut: false, tail: ["sh: x: command not found"] })).toBe("pass");
    expect(classify({ code: 1, timedOut: false, tail: ["sh: x: command not found"] })).toBe("cannot-start");
    expect(classify({ code: 126, timedOut: false, tail: [] })).toBe("cannot-start");
    expect(classify({ code: 2, timedOut: false, tail: ["1 failing"] })).toBe("fails-as-expected");
  });
});
