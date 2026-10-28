import { join } from "node:path";
import { CatherdError } from "../domain/errors.ts";
import { assertId } from "../domain/ids.ts";
import { cell, coveredMs } from "../domain/util.ts";
import { laneOutcome, type OutcomeRow, outcomeRouteRow, type RouteRow } from "../domain/route.ts";
import { withFileLock } from "../infra/filelock.ts";
import { commitExists } from "../infra/git.ts";
import { gatesFile, readPasses, recordedItems } from "./gate-service.ts";
import { pendingDispatches } from "./dispatches.ts";
import {
  findWorkspace,
  WORKSPACE_LOCK_WAIT_MS,
  workspaceChildren,
  workspaceDirectory,
  workspacePaths,
} from "./workspace-store.ts";
import {
  isDocPath,
  isSourcePath,
  landedMilestones,
  fullCommit,
  milestoneFiles,
  milestoneStart,
  partialReviewer,
  reviewerPassed,
  milestoneCommits,
  milestoneVerifier,
} from "./milestones.ts";
import { acceptedBaselineItem, machineGate } from "./milestone-check.ts";
import type { Deps } from "./ports.ts";
import {
  appendKnowledge,
  appendLedger,
  appendOutcome,
  appendRoute,
  findRun,
  readAgentRuns,
  readRecords,
  readRoutes,
  type Run,
  runPaths,
} from "./run-store.ts";
import { writeDigest } from "./protocol.ts";
import { pauseSpans } from "./pause.ts";
import { openQuestions, parkedSpans } from "./questions.ts";
import { type Notes, type NotesPatch, patchNotes, refreshState } from "./state.ts";

const withHints = (hints: string[]) => (hints.length ? { hints } : {});

/**
 * A lane's final outcome: its outcomes.jsonl row (spec §5.6) and, beside it, its routes.jsonl row. Called under the routes lock.
 */
function writeOutcome(run: Run, routes: RouteRow[], o: OutcomeRow): void {
  appendOutcome(run, o);
  appendRoute(run, outcomeRouteRow(routes, o));
}

export const LAND_SKIPS = ["docs-only", "no-code"] as const;
export type LandSkip = (typeof LAND_SKIPS)[number];

/**
 * Spec 1.1 §6: a milestone lands only with a reviewer record and a verifier verdict since its lanes
 * started, or with a `skip` the commit range bears out. Throws E_LAND_GATE naming what is missing.
 */
async function gate(run: Run, m: string, commit: string, skip: LandSkip | undefined): Promise<string[]> {
  // spec 1.1 §8: a parked milestone waits on the owner, whatever else it has
  const question = openQuestions(run).find((q) => q.milestone === m);
  if (question)
    throw new CatherdError(
      "E_LAND_GATE",
      `land ${m}: it is parked, waiting on the owner: ${question.question}`,
      {
        fix: `when the owner answers, call answer(run, "${m}", <their answer>), finish ${m}, then land it`,
      },
    );
  if (skip) {
    // the range a skip is judged on must be the milestone as it stands: an older commit would leave
    // later source commits unreviewed
    const [landed, head] = await Promise.all([fullCommit(run, commit), fullCommit(run, "HEAD")]);
    if (landed !== head)
      throw new CatherdError(
        "E_LAND_GATE",
        `land ${m}: skip "${skip}" refused: ${commit} is not HEAD (${head.slice(0, 7)}): commits after it would land unreviewed`,
        {
          fix: `land ${m} with HEAD (${head.slice(0, 7)}) once it holds the milestone; if source changed, run reviewer-${m} and the verifier and land without skip`,
        },
      );
    const files = await milestoneFiles(run, commit);
    // an empty range lands nothing: the milestone's work is most likely not committed yet
    if (files.length === 0) {
      const last = landedMilestones(run).at(-1);
      throw new CatherdError(
        "E_LAND_GATE",
        `land ${m}: skip "${skip}" refused: ${last ? `the commit range changed nothing since ${last} landed` : `${commit} changed nothing`}`,
        { fix: `commit the milestone first, then land ${m} with that commit` },
      );
    }
    const against =
      skip === "docs-only" ? files.filter((f) => !isDocPath(f)) : files.filter((f) => isSourcePath(f));
    if (against.length === 0) return [];
    const shown = `${against.slice(0, 5).join(", ")}${against.length > 5 ? `, and ${against.length - 5} more` : ""}`;
    throw new CatherdError(
      "E_LAND_GATE",
      `land ${m}: skip "${skip}" refused: ${skip === "docs-only" ? "files outside the docs changed" : "source files changed"}: ${shown}`,
      { fix: `run the reviewer (reviewer-${m}) and the verifier on ${m}, then land it without skip` },
    );
  }
  const start = milestoneStart(run, m);
  // plan 23: a reviewer that stopped partial read part of the diff; that is not the milestone's review
  const partial = partialReviewer(run, m, start);
  if (partial)
    throw new CatherdError(
      "E_LAND_GATE",
      `land ${m}: ${partial.name} replied STATUS: partial, which is not the milestone's review`,
      {
        fix: `dispatch a scoped second pass, reviewer-${m}-2, over the files ${partial.name} did not read (its reply names them), then land again`,
      },
    );
  // the latest verifier attempt, passed or not: a FAIL after a PASS undoes it
  const verdict = milestoneVerifier(run, m, start);
  // plan 23: a verdict on the machine is a blocker for the owner, never a fix round
  if (verdict?.blocked != null)
    throw new CatherdError(
      "E_LAND_GATE",
      `land ${m}: ${verdict.name} is blocked by the environment${verdict.blocked ? `: ${verdict.blocked}` : ""}`,
      {
        fix: `surface it to the owner: park(run, "${m}", <the blocker and its probe>); once the environment is fixed, run a fresh verifier on ${m}. A fix round or a climb cannot help`,
      },
    );
  // plan 48: the 1.5 landing gate only; a daemon run lands through the architect (plan 50)
  const landed = await fullCommit(run, commit);
  const settled = verdict?.passed === true;
  const missing = [
    ...(reviewerPassed(run, m, start)
      ? []
      : [
          `a reviewer record (a dispatch named reviewer-${m}, or record_agent_run with role reviewer and that name, status ok)`,
        ]),
    ...(settled
      ? []
      : [
          `a verifier verdict (record_agent_run with role verifier named exactly verifier-${m}, status ok; a headless verifier-${m}'s reply opening VERDICT: PASS)${verdict ? `: the latest, ${verdict.name}${verdict.headless ? " (headless)" : ""}, is ${verdict.verdict}` : ""}`,
        ]),
  ];
  // a headless verifier that wrapped its verdict in markdown (**VERDICT: PASS**) gave no verdict: fail safe, and say why
  const marked =
    verdict?.headless === true && verdict.ok && !verdict.passed && /VERDICT:\s*PASS\b/.test(verdict.verdict)
      ? `the reply's first line must be the bare VERDICT: PASS, and ${verdict.name}'s is "${verdict.verdict}", which counts as no verdict (markdown around it, or text before it): dispatch the verifier again; otherwise `
      : "";
  if (missing.length)
    throw new CatherdError(
      "E_LAND_GATE",
      `land ${m}: missing ${missing.join(" and ")}, since its lanes started`,
      {
        fix: `${marked}run reviewer-${m} (a dispatch, or a Claude subagent recorded with record_agent_run(name: "reviewer-${m}")) and the verifier on ${m}, recording it with record_agent_run(name: "verifier-${m}") (a FAIL with status "failed"), then land again; a docs-only milestone passes skip: "docs-only"`,
      },
    );
  // plan 30b: the verdict must be about the commit being landed, and catherd's own check must have run on it
  const checked = verdict?.head ?? null;
  if (verdict && checked === null)
    throw new CatherdError(
      "E_LAND_GATE",
      `land ${m}: ${verdict.name}'s PASS names no HEAD, so it cannot be told to cover ${landed.slice(0, 12)}`,
      {
        fix: `a headless verifier's reply ends with HEAD: <sha>; run a fresh verifier-${m} on the committed milestone (${landed.slice(0, 7)})`,
      },
    );
  if (verdict && checked !== null && !landed.startsWith(checked))
    throw new CatherdError(
      "E_LAND_GATE",
      `land ${m}: ${verdict.name} checked ${checked.slice(0, 12)}, and the commit being landed is ${landed.slice(0, 12)}: a PASS from before a later commit does not count`,
      {
        fix: `run a fresh ${verdict.name} on ${landed.slice(0, 7)}: what passed is carried over by gate_check`,
      },
    );
  const machine = await machineGate(run, m, landed);
  if (machine.missing.length)
    throw new CatherdError(
      "E_LAND_GATE",
      `land ${m}: the machine gate on ${landed.slice(0, 12)}: ${machine.missing.join("; ")}`,
      {
        fix: `run the full check with gate_run(run, "${m}", <command>) on ${landed.slice(0, 7)}; fix what fails, commit, and verify again`,
      },
    );
  const items = await recordedItems(run, m);
  const passes = readPasses(gatesFile(run.meta.repo));
  const unpassed: string[] = [];
  for (const item of items) {
    const passed =
      item.passed &&
      passes.some(
        (pass) =>
          pass.run === run.id &&
          pass.item === item.item &&
          pass.command === item.command &&
          pass.commit.length > 0 &&
          !pass.commit.includes("+"),
      );
    if (!passed && !(await acceptedBaselineItem(run, m, landed, item.command, item.item)))
      unpassed.push(item.item);
  }
  if (unpassed.length)
    throw new CatherdError(
      "E_LAND_GATE",
      `land ${m}: gate items without a pass on ${landed.slice(0, 12)}: ${unpassed.join(", ")}`,
      {
        fix: `run each item and record gate_pass with milestone "${m}" on ${landed.slice(0, 7)}, then land again`,
      },
    );
  return machine.audit;
}

/**
 * Spec §4.7: the full five-column ledger row, with the minutes since the previous landing (or the
 * run's start), and `learned` appended to the repo's knowledge.md.
 */
type LandInput = {
  run: string;
  milestone: string;
  what: string;
  commit: string;
  evidence: string;
  next: string;
  learned?: string;
  skip?: LandSkip;
};

type LandResult = { ledger: string; minutes: number; digest: string; digestPath: string; hints?: string[] };

export async function land(deps: Deps, i: LandInput): Promise<LandResult> {
  const run = findRun(i.run);
  const link = run.meta.workspace;
  if (!link) return landRun(deps, i, run);
  const workspace = findWorkspace(link.id);
  const step = workspace.steps.find((s) => s.id === link.step);
  if (!step || !workspaceChildren(workspace).some((child) => child.dir === run.dir))
    throw new CatherdError("E_RUN_CORRUPT", "the run is not a member of its workspace execution");
  // #43 finding 3: only the step's completion milestone waits for the child's dispatches
  if (i.milestone !== step.milestone) {
    const landed = await landRun(deps, i, run);
    if (i.milestone.toLowerCase() !== step.milestone.toLowerCase()) return landed;
    // #43 finding 7: m1 is not M1; the dependents wait on the step's own milestone
    const hint = `${i.milestone} is not ${step.milestone}, the milestone workspace step ${step.id} completes on: its dependents still wait`;
    return { ...landed, hints: [...(landed.hints ?? []), hint] };
  }
  // An unreadable newer native verdict must not leave an older PASS standing.
  readAgentRuns(run, true);
  // Completion and dispatch admission share a boundary, held only for the check and the ledger row: the git
  // work runs outside it (#43 finding 5). Landing remains available at a spent budget.
  return landRun(deps, i, run, (write) =>
    withFileLock(
      workspacePaths(workspaceDirectory(workspace.id)).admission,
      async () => {
        const pending = await withFileLock(runPaths(run.dir).runs, () => {
          const { records, corrupt } = readRecords(run);
          if (corrupt)
            throw new CatherdError("E_RUN_CORRUPT", "workspace completion has unreadable dispatch records", {
              fix: "repair the child's dispatch records before landing its milestone",
            });
          return pendingDispatches(run, deps.now(), records, true);
        });
        if (pending.length)
          throw new CatherdError("E_LAND_GATE", "workspace completion waits for all admitted dispatches", {
            fix: "finish and collect the child's dispatches before landing its milestone",
          });
        return write();
      },
      { timeoutMs: WORKSPACE_LOCK_WAIT_MS },
    ),
  );
}

/**
 * The checks (commit, gate) first, then the ledger row and the notes, inside `critical` (a workspace
 * completion's lock), with no git; then state.md, the lane outcomes, knowledge and the digest.
 */
async function landRun(
  deps: Deps,
  i: LandInput,
  run: Run,
  critical: (write: () => Promise<Notes>) => Promise<Notes> = (write) => write(),
): Promise<LandResult> {
  // the digest is named after the milestone: an id, checked before anything is written
  assertId("milestone", i.milestone);
  // commitExists throws E_IO_UNEXPECTED on a timeout, which reaches the caller as is
  if (!/^[0-9a-f]{7,40}$/.test(i.commit) || !(await commitExists(run.meta.repo, i.commit)))
    throw new CatherdError("E_RUN_COMMIT", `no commit ${i.commit} in ${run.meta.repo}`, {
      fix: "commit the milestone first, then pass its hash",
    });
  const audit = await gate(run, i.milestone, i.commit, i.skip);
  // read before the ledger row: the range runs from the previous landing to this commit
  const commits = await milestoneCommits(run, i.commit);
  const now = new Date(deps.now());
  let row = "";
  let minutes = 0;
  let pausedMinutes = 0;
  // spec 1.5 "The ledger": the minutes leave out the time the milestone was parked and any machine or
  // workspace pause, so a night parked on a question does not count
  const paused = [...parkedSpans(run, i.milestone), ...pauseSpans(run)];
  const landRow = (notes: Notes): NotesPatch => {
    const from = Date.parse(notes.lastLandedAt ?? run.meta.createdAt);
    const left = coveredMs(from, now.getTime(), paused);
    pausedMinutes = Math.round(left / 60_000);
    minutes = Math.max(0, Math.round((now.getTime() - from - left) / 60_000));
    row = [i.milestone, i.what, i.commit, String(minutes), i.evidence].map(cell).join(" | ");
    appendLedger(run, row);
    return { lastCheck: cell(i.evidence), next: i.next, lastLandedAt: now.toISOString() };
  };
  // the notes reach state.json first, with no git: the next landing counts its minutes from this one
  await critical(() => patchNotes(run, landRow));
  const { hints } = await refreshState(run);
  hints.push(...audit);
  // spec §5.6: every routed lane of the milestone lands with it
  // under the routes lock, so a racing climb cannot slip between the read and the rows
  let routed: string[] = [];
  let landed = 0;
  await withFileLock(runPaths(run.dir).routes, () => {
    const routes = readRoutes(run);
    routed = [...new Set(routes.map((r) => r.lane))];
    for (const lane of routed)
      if (lane.startsWith(`${i.milestone}.`)) {
        landed++;
        const o = laneOutcome(routes, lane, true, now.toISOString());
        if (o) writeOutcome(run, routes, o);
      }
  });
  // a milestone name no routed lane starts with is most likely a typo: say so rather than record nothing
  if (routed.length > 0 && landed === 0)
    hints.push(
      `land: no routed lane is in milestone "${i.milestone}" (routed: ${routed.slice(0, 5).join(", ")}${routed.length > 5 ? ", …" : ""}); check its name: no lane outcome was recorded`,
    );
  if (i.learned) await appendKnowledge(run.meta.repo, now, `${run.meta.title} ${i.milestone}`, i.learned);
  // spec 1.1 §10: the milestone's digest, which the milestone push links
  const digest = writeDigest(run, {
    milestone: i.milestone,
    what: i.what,
    commit: i.commit,
    evidence: i.evidence,
    minutes,
    at: now.toISOString(),
    commits,
    pausedMinutes,
  });
  // spec 1.5: the digest's full path, for the milestone push to link
  return { ledger: row, minutes, digest, digestPath: join(run.dir, digest), ...withHints(hints) };
}
