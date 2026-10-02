import { withGateNotes } from "../domain/gate-brief.ts";
import { gateEnvLines, readGateEnv } from "./gate-env.ts";
import { recordedItems } from "./gate-service.ts";
import type { Run } from "./run-store.ts";

// Plan 23: a dispatched verifier's brief ends with the gate's rules and the run's facts: the milestone's
// recorded items (reuse their names), the failed ones (a re-check runs them first, each command capped), and
// the repo's gate environment.

/** The milestone a verifier dispatch checks: the first `M<n>` its name names as a word (verifier-M1 → M1). */
export const milestoneOfName = (name: string): string | null =>
  /(?:^|[^A-Za-z0-9])(M\d+)(?=$|[-._\s])/.exec(name)?.[1] ?? null;

/** A verifier's brief with the gate notes, once; any other role's brief as it is. */
export function verifierBrief(run: Run, role: string, name: string, brief: string): string {
  if (role !== "verifier") return brief;
  const milestone = milestoneOfName(name);
  return withGateNotes(brief, {
    milestone,
    recorded: milestone ? recordedItems(run, milestone) : [],
    env: gateEnvLines(readGateEnv(run.meta.repo)),
  });
}
