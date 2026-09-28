import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendJsonl } from "../../src/infra/store.ts";
import { formatRun } from "../../src/entry/runs-command.ts";
import { isCatherdError } from "../../src/domain/errors.ts";
import { withParked } from "../../src/domain/state.ts";
import { land } from "../../src/services/lane-service.ts";
import { answer, openQuestions, park } from "../../src/services/questions.ts";
import { runPaths } from "../../src/services/run-store.ts";
import { setNext } from "../../src/services/run-service.ts";
import { readNotes } from "../../src/services/state.ts";
import { summarizeRun } from "../../src/services/summary.ts";
import { snapshotEnv } from "../helpers.ts";
import { call, mcpClient } from "../mcp-helpers.ts";
import { fakeDeps, freshRun, passGate } from "./helpers.ts";

afterEach(snapshotEnv());

const nextLine = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.startsWith("Next: "));
const head = (repo: string) =>
  execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

describe("park and answer (spec 1.1 §8)", () => {
  it("parks a milestone: the question is recorded, state.md's next names it, and the hints say what to do", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    await setNext({ run: run.id, next: "dispatch M3.L1" });
    const r = await park(deps, { run: run.id, milestone: "M2", question: "Keep the v1 API?" });
    expect(r.parked).toEqual(["M2"]);
    expect(r.hints[0]).toBe(
      "push the full question to the owner now (PushNotification): M2: Keep the v1 API?",
    );
    expect(r.hints[1]).toStartWith("continue with the milestones and runs that do not depend on M2");
    expect(readNotes(run).parked).toEqual(["M2"]);
    expect(nextLine(runPaths(run.dir).state)).toBe("Next: parked: M2 waits on the owner; dispatch M3.L1");
    expect(openQuestions(run)).toEqual([
      expect.objectContaining({ milestone: "M2", question: "Keep the v1 API?" }),
    ]);
  });

  it("keeps a parked milestone in front of every later next step, until it is answered", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    await park(deps, { run: run.id, milestone: "M2", question: "q2" });
    await park(deps, { run: run.id, milestone: "M4", question: "q4" });
    await setNext({ run: run.id, next: "dispatch M3.L1" });
    expect(readNotes(run).next).toBe("parked: M2, M4 wait on the owner; dispatch M3.L1");
    const a = await answer(deps, { run: run.id, milestone: "M2", answer: "yes, keep it" });
    expect(a.parked).toEqual(["M4"]);
    expect(readNotes(run).next).toBe("parked: M4 waits on the owner; M2: the owner answered; continue it");
    expect(openQuestions(run).map((q) => q.milestone)).toEqual(["M4"]);
    expect(withParked("parked: M4 waits on the owner; x", [])).toBe("x");
  });

  it("refuses a milestone that is not an id, writing nothing", async () => {
    const { run } = freshRun();
    for (const milestone of ["../state", "M1/a"]) {
      for (const p of [
        park(fakeDeps(), { run: run.id, milestone, question: "q" }),
        answer(fakeDeps(), { run: run.id, milestone, answer: "a" }),
      ])
        expect(
          await p.then(
            () => null,
            (e: unknown) => (isCatherdError(e) ? e.code : e),
          ),
        ).toBe("E_ADMIT_ID");
    }
    expect(openQuestions(run)).toEqual([]);
    expect(readNotes(run).parked ?? []).toEqual([]);
  });

  it("unparks on a second answer when the first recorded the answer but could not save state.json", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    await park(deps, { run: run.id, milestone: "M2", question: "Keep the v1 API?" });
    // the answer row reached questions.jsonl, but the state save that unparks M2 did not happen
    appendJsonl(join(run.dir, "questions.jsonl"), {
      at: new Date().toISOString(),
      milestone: "M2",
      kind: "answer",
      text: "yes",
    });
    expect(openQuestions(run)).toEqual([]);
    expect(readNotes(run).parked).toEqual(["M2"]);
    const r = await answer(deps, { run: run.id, milestone: "M2", answer: "yes" });
    expect(r.parked).toEqual([]);
    expect(readNotes(run).parked).toEqual([]);
    expect(nextLine(runPaths(run.dir).state)).not.toContain("parked");
    // the answer is not recorded twice
    const answers = readFileSync(join(run.dir, "questions.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.includes('"kind":"answer"'));
    expect(answers).toHaveLength(1);
  });

  it("refuses to answer a milestone with no open question", async () => {
    const { run } = freshRun();
    try {
      await answer(fakeDeps(), { run: run.id, milestone: "M9", answer: "a" });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(isCatherdError(e) && e.code).toBe("E_INPUT_INVALID");
    }
  });

  it("land refuses a parked milestone, and lands it once answered", async () => {
    const { repo, run } = freshRun();
    const deps = fakeDeps();
    await passGate(run, "M2");
    await park(deps, { run: run.id, milestone: "M2", question: "Keep the v1 API?" });
    const landing = {
      run: run.id,
      milestone: "M2",
      what: "w",
      commit: head(repo),
      evidence: "ok",
      next: "M3",
    };
    try {
      await land(deps, landing);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(isCatherdError(e) && [e.code, e.message]).toEqual([
        "E_LAND_GATE",
        "land M2: it is parked, waiting on the owner: Keep the v1 API?",
      ]);
    }
    await answer(deps, { run: run.id, milestone: "M2", answer: "yes" });
    expect((await land(deps, landing)).ledger).toStartWith("M2 |");
  });

  it("status lists the open questions first", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    await park(deps, { run: run.id, milestone: "M2", question: "Keep the v1 API?" });
    const s = summarizeRun(deps, run);
    expect(s.questions).toEqual([expect.objectContaining({ milestone: "M2" })]);
    expect(formatRun(s)[2]).toBe("  ! parked M2: Keep the v1 API?");
  });

  it("serves park and answer over MCP", async () => {
    const { run } = freshRun();
    const c = await mcpClient(fakeDeps());
    expect((await call(c, "park", { run: run.id, milestone: "M2", question: "q" })).data.parked).toEqual([
      "M2",
    ]);
    expect((await call(c, "status", { run: run.id })).data.runs[0].questions[0].milestone).toBe("M2");
    expect((await call(c, "answer", { run: run.id, milestone: "M2", answer: "a" })).data.parked).toEqual([]);
  });
});
