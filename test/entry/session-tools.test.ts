import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { COORDINATOR_TOOLS } from "../../src/domain/role-scope.ts";
import { daemonLauncher } from "../../src/services/daemon.ts";
import { appendEvent, readEvents } from "../../src/services/run-events-store.ts";
import { findRun } from "../../src/services/run-store.ts";
import { PLAN, startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { call, mcpClient } from "../mcp-helpers.ts";
import { fakeDeps, freshRun, PLAN_TEXT, waitFor } from "../services/helpers.ts";

afterEach(snapshotEnv());
const real = daemonLauncher.launch;
let launched: string[] = [];
beforeEach(() => {
  launched = [];
  daemonLauncher.launch = (id: string) => {
    launched.push(id);
    return 1;
  };
});
afterEach(() => {
  daemonLauncher.launch = real;
});

describe("the session tools", () => {
  it("lists exactly the six session tools", async () =>
    expect((await (await mcpClient()).listTools()).tools.map((t) => t.name).sort()).toEqual([
      "answer",
      "cancel",
      "profile",
      "result",
      "run_start",
      "status",
    ]));

  it("passes run_start's plan to the client", async () => {
    withHome();
    const repo = tempRepo();
    writeFileSync(join(repo, "p.md"), PLAN_TEXT);
    const c = await mcpClient(fakeDeps());
    const started = await call(c, "run_start", { repo, title: "wallet", a_lines: ["A1 x"], plan: ["p.md"] });
    expect(started.isError).toBe(false);
    expect(started.data.plan).toEqual([join(repo, "p.md")]);
    expect(readEvents(findRun(started.data.run)).map((e) => e.type)).toEqual([
      "run.started",
      "plan.approved",
    ]);
  });

  it("starts, shows, answers, cancels and reads a run through the client", async () => {
    withHome();
    const repo = tempRepo();
    const c = await mcpClient(fakeDeps());
    const started = await call(c, "run_start", { repo, title: "wallet", a_lines: ["A1 it works"] });
    expect(started.isError).toBe(false);
    const run = findRun(started.data.run);
    expect(launched).toEqual([run.id]);
    expect(started.data).toMatchObject({ daemon: "revived", notifyUrl: "https://ntfy.sh/catherd-test" });
    // the daemon is the fake: the test plays its part, parking a lane
    await appendEvent(run, { type: "plan.ready", milestones: PLAN });
    await appendEvent(run, {
      type: "question.parked",
      unit: "M1.L2",
      question: "which currency?",
      reason: "needs_user",
    });
    const shown = await call(c, "status", { run: run.id });
    expect(shown.data.runs[0]).toMatchObject({
      id: run.id,
      engine: "2.0",
      phase: "running",
      parked: [
        { unit: "M1.L2", question: "which currency?", command: `catherd answer ${run.id} M1.L2 "<answer>"` },
      ],
    });
    // without a run: the unfinished one
    expect((await call(c, "status")).data.runs.map((r: { id: string }) => r.id)).toEqual([run.id]);
    expect((await call(c, "answer", { run: run.id, unit: "M9", answer: "x" })).error?.code).toBe(
      "E_INPUT_INVALID",
    );
    const answered = await call(c, "answer", { run: run.id, unit: "M1.L2", answer: "euros" });
    expect(answered.data).toEqual({ unit: "M1.L2", parked: [] });
    expect((await call(c, "cancel", { run: run.id })).data).toEqual({ cancelling: true, live: [] });
    expect(
      readEvents(run)
        .map((e) => e.type)
        .slice(-3),
    ).toEqual(["question.parked", "question.answered", "cancel.requested"]);
    await appendEvent(run, { type: "run.ended", outcome: "cancelled", reportPath: null });
    const result = await call(c, "result", { run: run.id });
    expect(result.data).toMatchObject({ phase: "ended", outcome: "cancelled", report: null });
  });

  it("gets, validates and sets a profile, and sets the notify url", async () => {
    const c = await mcpClient(fakeDeps());
    expect((await call(c, "profile", { action: "get" })).data.profile.name).toBe("test");
    expect((await call(c, "profile", { action: "validate" })).data).toMatchObject({ valid: true });
    const set = await call(c, "profile", { action: "set", notify_url: "https://ntfy.sh/mine" });
    expect(set.data).toEqual({ notifyUrl: "https://ntfy.sh/mine" });
  });

  it("refuses every session tool but status to a role process", async () => {
    const { run } = freshRun();
    const c = await mcpClient({ ...fakeDeps(), role: { run: run.id, name: "verifier-M1" } });
    for (const tool of COORDINATOR_TOOLS)
      expect([tool, (await call(c, tool, { run: run.id })).error?.code]).toEqual([tool, "E_ROLE_SCOPE"]);
    expect((await call(c, "status", { run: run.id })).isError).toBe(false);
  });
});

describe("catherd answer", () => {
  it("answers a parked unit from the command line", async () => {
    const { run } = freshRun();
    await appendEvent(run, { type: "run.started", ...startedFields });
    await appendEvent(run, {
      type: "question.parked",
      unit: "M1.L2",
      question: "which currency?",
      reason: "needs_user",
    });
    // the revived daemon has nothing to do but end a cancelled run
    await appendEvent(run, { type: "cancel.requested", by: "owner" });
    const cli = (...args: string[]) =>
      Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "..", "src", "cli.ts"), ...args], {
        env: { ...process.env, ANTHROPIC_API_KEY: "", CATHERD_NO_END_PUSH: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
    const refused = cli("answer", run.id, "M1.L2");
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr.toString()).toContain("error E_INPUT_INVALID: no answer given");
    const done = cli("answer", run.id, "M1.L2", "use", "euros");
    expect(done.exitCode).toBe(0);
    expect(done.stdout.toString()).toBe("answered M1.L2\n");
    expect(readEvents(run).find((e) => e.type === "question.answered")).toMatchObject({
      unit: "M1.L2",
      answer: "use euros",
      by: "owner",
    });
    // the daemon the call revived ends the run
    await waitFor(() => readEvents(run).some((e) => e.type === "run.ended"));
  });
});
