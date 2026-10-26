import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { INJECTED_TASK, SCORECARD_TASKS } from "../src/domain/scorecard.ts";
import { loadTask } from "../src/services/scorecard.ts";

const ROOT = join(import.meta.dir, "..", "scorecard");
const REPO = join(import.meta.dir, "..");

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

describe("scorecard fixtures", () => {
  it("loads every task under its own id, and the four are the scorecard's tasks", () => {
    expect(readdirSync(join(ROOT, "tasks")).sort()).toEqual([...SCORECARD_TASKS].sort());
    for (const id of SCORECARD_TASKS) expect(loadTask(id, ROOT).id).toBe(id);
  });

  it("pins each task to its commit, and only the Sanitell task to no source", () => {
    const raqam = ["67951678b7cdb115b9f00eb63b3ea7f91a1c464d", "https://github.com/47vigen/raqam.git"];
    expect(
      Object.fromEntries(
        SCORECARD_TASKS.map((id) => [id, [loadTask(id, ROOT).commit, loadTask(id, ROOT).source]]),
      ),
    ).toEqual({
      "raqam-myanmar": raqam,
      "injected-lao": raqam,
      "catherd-findings": [
        "2061e6e61c7252738869590cca37d78239dabd60",
        "https://github.com/47vigen/catherd.git",
      ],
      "sanitell-payment-3": ["0296d87585d6288998f7b845a501ebdf2a5c1cad", null],
    });
  });

  it("has every plan and accept file a task names", () => {
    for (const id of SCORECARD_TASKS) {
      const t = loadTask(id, ROOT);
      if ("file" in t.plan) expect(existsSync(join(ROOT, "tasks", id, t.plan.file))).toBe(true);
      for (const f of t.acceptFiles) expect(existsSync(join(ROOT, "tasks", id, f.from))).toBe(true);
    }
  });

  it("injects a limit and a stale test into the injected task only", () => {
    for (const id of SCORECARD_TASKS) {
      const t = loadTask(id, ROOT);
      expect([t.limits > 0, t.inject !== null]).toEqual(id === INJECTED_TASK ? [true, true] : [false, false]);
    }
  });

  it("names no private host in any fixture or doc", () => {
    const fixtures = files(join(ROOT, "tasks"));
    const docs = files(join(REPO, "docs"));
    for (const [list, words] of [
      [fixtures, ["sakhtar", "dopiyazeh", "codekesh", "omni.", "git@"]],
      [docs, ["sakhtar", "dopiyazeh", "codekesh"]],
    ] as const)
      for (const f of list) {
        const text = readFileSync(f, "utf8");
        for (const word of words) expect([f, text.includes(word)]).toEqual([f, false]);
      }
  });
});
