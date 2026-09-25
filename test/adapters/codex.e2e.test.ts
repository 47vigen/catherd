import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FinishedRun, RunRequest } from "../../src/adapters/backend.ts";
import { codexAdapter } from "../../src/adapters/codex/index.ts";
import { newDispatchId, parseRung } from "../../src/domain/ids.ts";
import { dispatchPaths, readExit, tryClaim } from "../../src/infra/dispatch-dir.ts";
import { workerEnv } from "../../src/infra/env.ts";
import { launchSupervisor } from "../../src/infra/launch.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
afterEach(snapshotEnv());

async function waitForExit(dir: string) {
  for (let i = 0; i < 400; i++) {
    const e = readExit(dir);
    if (e) return e;
    await Bun.sleep(25);
  }
  throw new Error("no exit.json");
}

describe("codex end to end on the simulator", () => {
  it("plans, supervises detached, and finalizes exactly once into an ok outcome", async () => {
    const home = withHome();
    const repo = tempRepo();
    const s = withScenario({
      eventsFile: join(FX, "ok-with-reconnect.jsonl"),
      reply: "Done.\nSTATUS: complete — lane finished",
      touch: [{ path: "src/a.ts", content: "new" }],
      delayMs: 100,
    });
    process.env.PATH = simPath();
    Object.assign(process.env, s.env, { TYPESAFE_API_KEY: "secret" });

    const dir = join(home, "dispatch", newDispatchId());
    mkdirSync(dir, { recursive: true });
    const p = dispatchPaths(dir);
    writeFileSync(p.brief, "Do the lane.");
    const request: RunRequest = {
      rung: parseRung("codex:gpt-6-sol#medium"),
      access: "workspace-write",
      thread: null,
      isolated: false,
      repo,
      briefPath: p.brief,
      replyPath: p.reply,
      dispatchDir: dir,
    };
    const plan = codexAdapter.plan(request);
    writeJsonAtomic(p.spec, {
      schema: 1,
      backend: "codex",
      dispatchDir: dir,
      cmd: plan.cmd,
      args: plan.args,
      env: workerEnv(process.env, plan.env, plan.cwd),
      cwd: plan.cwd,
      stdinPath: plan.stdinPath,
      idleMs: 60_000,
      wallMs: 120_000,
      killGraceMs: 500,
      graceAfterFinalMs: codexAdapter.graceAfterFinalMs,
      pollMs: 50,
    });
    const started = Date.now();
    launchSupervisor(p.spec);
    const exit = await waitForExit(dir);

    expect(tryClaim(dir)).toBe(true);
    expect(tryClaim(dir)).toBe(false);
    const run: FinishedRun = {
      request,
      eventLines: readFileSync(p.events, "utf8")
        .split("\n")
        .filter((l) => l.trim()),
      reply: readFileSync(p.reply, "utf8"),
      stderr: readFileSync(p.stderr, "utf8"),
      exit,
      startedAtMs: started,
    };
    const o = codexAdapter.finalize(run);
    expect(o.status).toBe("ok");
    expect(o.tokens.output).toBe(5341);
    expect(readFileSync(join(repo, "src/a.ts"), "utf8")).toBe("new");

    const seen = s.recorded();
    expect(seen.stdin).toBe("Do the lane.");
    expect(seen.pwd).toBe(repo);
    expect(seen.cwd).toBe(repo);
    const envSeen = JSON.parse(readFileSync(p.spec, "utf8")).env as Record<string, string>;
    expect(envSeen.TYPESAFE_API_KEY).toBeUndefined();
  });
});
