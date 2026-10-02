// Plan 23: how a verifier runs a gate, which every verifier gets (its agent file, or its dispatch brief), and
// the run's own facts a dispatched verifier's brief adds: the items already recorded, the failed ones to
// re-check first, and the repo's gate environment.

/** A re-check's cap on each command, in minutes: a hung command fails its item, not the verifier. */
export const RECHECK_COMMAND_MIN = 10;

/** The rules of the gate, one paragraph each. */
export const VERIFIER_GATE_RULES = [
  "Run the root gate (the milestone's full check) as one gate item and each per-service acceptance suite as its own item, never as one command: a failure then names its item, and a re-check reruns only that item. Acceptance that builds from HEAD (git archive, a commit's image) is yours: workers do not commit, so they never run it.",
  "Stay in the foreground until your verdict: no background watcher, and never end your turn while a command runs.",
  `When the machine, not the work, stops an item (a VPN filter, a Docker client proxy, a dead registry, no DNS), probe it directly, twice, 5 s apart, and if it still fails, reply VERDICT: BLOCKED: environment — <the probe and its output>. That is a blocker for the owner, not a FAIL.`,
  "Last, when you built Docker images, run docker image prune -f, so the gates of later milestones do not fill the disk.",
];

/** The marker a verifier brief's catherd section starts with: added once. */
export const GATE_NOTES_HEADING = "## The gate (catherd)";

/** The run's facts for one verifier dispatch. */
export interface GateNotes {
  milestone: string | null;
  /** the milestone's recorded items, with whether each passed */
  recorded: { item: string; passed: boolean }[];
  /** the repo's gate environment, as `NAME=value` or `NAME=$FROM` */
  env: string[];
}

/** The section a dispatched verifier's brief ends with (before the reply contract). */
export function gateNotes(n: GateNotes): string {
  const failed = n.recorded.filter((r) => !r.passed).map((r) => r.item);
  const lines = [GATE_NOTES_HEADING, "", ...VERIFIER_GATE_RULES.map((r) => `- ${r}`)];
  if (n.milestone && n.recorded.length) {
    lines.push(
      `- Items already recorded for ${n.milestone}; reuse these names in gate_check, so what passed is carried over: ${n.recorded.map((r) => r.item).join(", ")}.`,
    );
    if (failed.length)
      lines.push(
        `- This is a re-check. Run the failed items first: ${failed.join(", ")}. Cap each command at ${RECHECK_COMMAND_MIN} minutes; a command that runs longer fails its item (say so), it never holds the gate.`,
      );
  }
  if (n.env.length)
    lines.push(
      `- The repo's gate environment is already set in your env (a secret as $NAME of where it came from): ${n.env.join(", ")}.`,
    );
  return lines.join("\n");
}

/** `brief` with the gate notes appended, once: a brief that already has them is kept. */
export function withGateNotes(brief: string, n: GateNotes): string {
  if (brief.includes(GATE_NOTES_HEADING)) return brief;
  return `${brief.trimEnd()}\n\n${gateNotes(n)}\n`;
}
