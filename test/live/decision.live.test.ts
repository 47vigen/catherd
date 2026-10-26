import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DecisionState,
  decisionState,
  difficultyQuestions,
  pickLevel,
} from "../../src/domain/decision.ts";
import { askDecision, decisionQuestions } from "../../src/services/decision-service.ts";

// The decision model is the owner's: this file runs against whichever one these name, and is skipped without them
// (the key is read as catherd reads it, CATHERD_DECISION_KEY, and is optional for a gateway that needs none).
const url = process.env.CATHERD_DECISION_LIVE_URL;
const model = process.env.CATHERD_DECISION_LIVE_MODEL;

const fx = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "decision", "probe-states.json"), "utf8"),
) as {
  min: number;
  rows: { name: string; expected: number; state: DecisionState }[];
};

describe.skipIf(!process.env.CATHERD_LIVE || !url || !model)("live decision model", () => {
  // D19: the six level texts are hand-written, and these four states are the only check of their wording
  for (const row of fx.rows)
    test(`${row.name}: level ${row.expected} of ${row.state.rungs.length}`, async () => {
      const f = decisionQuestions();
      const n = row.state.rungs.length;
      const a = await askDecision(
        null,
        { url: url as string, model: model as string, minConfidence: fx.min },
        "difficulty",
        decisionState(row.state),
        difficultyQuestions(f, row.state.role, n),
      );
      expect(a.why).toBeNull();
      const answers = a.answers ?? {};
      const score = answers.difficulty;
      if (score?.type !== "score") throw new Error("no score answer");
      const nouls = Object.fromEntries(
        Object.entries(answers).flatMap(([id, x]) => (x.type === "noul" ? [[id, x.noul]] : [])),
      );
      const { floor, cap, noulMin } = f.sets.difficulty;
      expect(pickLevel(score.probabilities, n, fx.min, nouls, { floor, cap, noulMin }).level).toBe(
        row.expected,
      );
    }, 60_000);
});
