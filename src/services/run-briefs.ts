import { type BriefParts, composeBrief } from "../domain/brief.ts";
import type { Action } from "../domain/run-machine.ts";
import { rulesBlock } from "../domain/rules.ts";
import type { Role } from "../domain/roles.ts";
import type { RunState } from "../domain/run-state.ts";
import { VERSION } from "../infra/version.ts";
import { taskBrief, wakeBrief } from "./architect-run.ts";
import { fitUnit } from "./plan-input.ts";
import type { Run } from "./run-store.ts";
import { standingRules } from "./run-service.ts";
import { teamFor } from "./team.ts";
import { verifierBrief } from "./verifier-brief.ts";

type DispatchAction = Extract<Action, { type: "dispatch" }>;

const READ_RULES = "If the repo has a CLAUDE.md or AGENTS.md, read it first and follow it.";

/** The catherd `lock` rule of the roles that run builds and suites; the others have none. */
const LOCK_RULES: Partial<Record<Role, string>> = {
  worker: `Wrap any full build or full test suite in: bunx catherd-cli@${VERSION} lock -- <command>. Other tasks share this machine.`,
  verifier: `Wrap every heavy command in: bunx catherd-cli@${VERSION} lock --role verifier -- <command>.`,
};

/** Part 2 of a brief: the run, where its files are, the repo's own rules and the lock rule. */
function runFacts(run: Run, role: Role): string[] {
  const lock = LOCK_RULES[role];
  return [`Run ${run.id}: ${run.meta.title}. Its folder is ${run.dir}.`, READ_RULES, ...(lock ? [lock] : [])];
}

/**
 * The parts of one dispatch's brief (plan 44 D1): part 2 the run's facts, part 3 the unit's context and part 4 this
 * round's task, with what the team sent it last.
 */
export function briefFor(run: Run, s: RunState, a: DispatchAction): BriefParts {
  const { unit, round } = a.brief === "wake" ? wakeBrief(run, s, a) : taskBrief(run, s, a);
  // plan 45: what the team sent this dispatch since its name's last brief (T3 Code's `queue` delivery)
  const last = Object.values(s.dispatches)
    .filter((d) => d.name === a.name)
    .sort((x, y) => x.startedAt.localeCompare(y.startedAt))
    .at(-1);
  const sent = teamFor(run, {
    name: a.name,
    unit: a.unit,
    role: a.role,
    since: last?.startedAt ?? null,
    ...(last?.teamSeen === undefined ? {} : { seen: last.teamSeen }),
  });
  const team = sent.length
    ? [`Your team sent you these (catherd team read for the rest):\n${sent.join("\n")}`]
    : [];
  return { facts: runFacts(run, a.role), unit, round: [...round, ...team] };
}

/**
 * The brief a dispatch sends, composed once (plan 44 D2): the parts of `briefFor`, the repo's standing rules for the
 * role as the last of part 3, and a verifier's gate notes as the last of part 4. `resumed` renders `<this-round>`
 * only, for a thread that holds the rest.
 */
export async function renderBrief(
  run: Run,
  s: RunState,
  a: DispatchAction,
  resumed: boolean,
): Promise<string> {
  const role = a.role;
  const parts = briefFor(run, s, a);
  // a knowledge file that cannot be read adds nothing
  const rules = rulesBlock(await standingRules(run.meta.repo, role).catch(() => ""), role);
  return composeBrief(
    {
      facts: parts.facts,
      unit: resumed ? [] : fitUnit(run, [...parts.unit, ...(rules ? [rules] : [])]),
      round:
        role === "verifier"
          ? [await verifierBrief(run, role, a.name, parts.round.join("\n\n"))]
          : parts.round,
    },
    { run: run.id, name: a.name, role, version: VERSION, resumed, lane: null },
  );
}
