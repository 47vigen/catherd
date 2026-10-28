import { describe, expect, it } from "bun:test";
import { architectNext } from "../../src/domain/architect-machine.ts";
import type { Action } from "../../src/domain/run-machine.ts";
import { makeLog, startedFields } from "./run-fixtures.ts";

const after = (log: ReturnType<typeof makeLog>): Action[] =>
  architectNext(log.state(), log.events.at(-1) as never);

describe("landing in the machine (plan 50, spec D11)", () => {
  it("runs a requested land once and wakes the architect with what it did", () => {
    const log = makeLog();
    log.add("run.started", { ...startedFields, base: "main" });
    log.add("land.requested", { landId: "L1", final: false, by: "architect-1", why: "checkpoint" });
    expect(after(log)).toContainEqual({ type: "land", landId: "L1" });
    log.add("land.done", {
      landId: "L1",
      final: false,
      outcome: "pushed",
      branch: "t",
      sha: "abc",
      mr: null,
      message: "pushed t at abc",
    });
    expect(after(log)).not.toContainEqual({ type: "land", landId: "L1" });
    expect(log.state().arch.inbox.at(-1)?.text).toBe("L1 (land) pushed: pushed t at abc");
  });

  it("ends the run done when the owner answers the merge question, and not on a refused final land", () => {
    const log = makeLog();
    log.add("run.started", { ...startedFields, base: "main" });
    const done = { final: true, branch: "t", sha: "abc", mr: "https://x/1", message: "m" };
    log.add("land.requested", { landId: "L1", final: true, by: "architect-1", why: "w" });
    log.add("land.done", { landId: "L1", outcome: "refused", ...done });
    log.add("question.parked", { unit: "run", question: "(stuck) help?", reason: "owner", why: "w" });
    log.add("question.answered", { unit: "run", answer: "go on", by: "owner" });
    expect(log.state().arch.finishing).toBeNull();
    log.add("land.requested", { landId: "L2", final: true, by: "architect-1", why: "w" });
    log.add("land.done", { landId: "L2", outcome: "pushed", ...done });
    log.add("question.parked", { unit: "run", question: "Merge?", reason: "land", why: "w" });
    log.add("question.answered", { unit: "run", answer: "merge", by: "owner" });
    expect(log.state().arch.finishing).toEqual({
      verdict: "done",
      why: "the owner answered the merge question: merge",
    });
    expect(after(log)).toContainEqual({ type: "finish", outcome: "done" });
  });
});
