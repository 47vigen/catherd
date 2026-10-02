import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetReadiness } from "../../src/services/backends.ts";
import { type DispatchInput, watchersSettled } from "../../src/services/dispatch-service.ts";
import { result } from "../../src/services/run-service.ts";
import { snapshotEnv } from "../helpers.ts";
import { type CodexScenario, simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, freshRun, runRole, writeLane } from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

const THREAD = "01a0d0d4-d0a6-71a1-983c-82a9169200b4";

function setup(s: CodexScenario) {
  const { run } = freshRun();
  process.env.PATH = simPath();
  Object.assign(process.env, withScenario(s).env);
  writeLane(run, "M1.L1", ["src/a.ts"]);
  return { run, deps: fakeDeps() };
}

const input = (run: string): DispatchInput => ({
  run,
  role: "worker",
  name: "worker-M1.L1",
  brief: "Read lanes/M1.L1.md",
  rung: "codex:gpt-6-luna#high",
  lane: "M1.L1",
});

describe("a final reply never overwrites the report (plan 22)", () => {
  it("result returns the report, the later short reply under later:, and the report's STATUS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "catherd-fx-"));
    const events = join(dir, "two-replies.jsonl");
    const msg = (id: string, text: string) =>
      JSON.stringify({ type: "item.completed", item: { id, type: "agent_message", text } });
    const done =
      '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}';
    const report = "Done: moved the kit.\nDeviation: kept one export.\nSTATUS: complete — lane finished";
    const short = "The notification is just my wait loop.";
    writeFileSync(
      events,
      [
        `{"type":"thread.started","thread_id":"${THREAD}"}`,
        '{"type":"turn.started"}',
        msg("i0", report),
        done,
        '{"type":"turn.started"}',
        msg("i1", short),
        done,
        "",
      ].join("\n"),
    );
    const { run, deps } = setup({ eventsFile: events, reply: short });
    const { record } = await runRole(deps, input(run.id));
    expect(record).toMatchObject({ replyStatus: "complete", replyWhy: "lane finished" });
    const r = await result(deps, { run: run.id, name: "worker-M1.L1" });
    expect(r.reply).toBe(
      `Done: moved the kit.\nDeviation: kept one export.\n\nlater:\n${short}\n\nSTATUS: complete — lane finished\n`,
    );
  });
});
