import { defineCommand } from "citty";
import { CatherdError } from "../domain/errors.ts";
import { answerUnit } from "../services/run-client.ts";
import { defaultDeps } from "./deps.ts";
import { JSON_ARG, printJson, refuseInRole } from "./cli-kit.ts";

/** What the phone message names: the run, the unit and the answer, as one command. */
export const answerCommand = defineCommand({
  meta: {
    name: "answer",
    description: "Answer a parked unit of a run: it runs again with your answer",
  },
  args: {
    run: { type: "positional", required: true, description: "the run id" },
    unit: {
      type: "positional",
      required: true,
      description: "the parked unit: the run, a milestone or a lane",
    },
    answer: {
      type: "positional",
      required: false,
      description: "your answer (several words need no quotes)",
    },
    ...JSON_ARG,
  },
  async run({ args }) {
    refuseInRole(process.env, "catherd answer");
    // citty names the first words; the rest of the line is the answer's too
    const answer = (args._ as string[]).slice(2).join(" ").trim();
    if (!answer)
      throw new CatherdError("E_INPUT_INVALID", "no answer given", {
        fix: 'catherd answer <run> <unit> "<your answer>"',
      });
    const r = await answerUnit(defaultDeps(), { run: args.run, unit: args.unit, answer });
    if (args.json) return printJson(r);
    console.log(`answered ${r.unit}${r.parked.length ? `; still waiting: ${r.parked.join(", ")}` : ""}`);
  },
});
