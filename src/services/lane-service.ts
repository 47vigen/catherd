import { existsSync, readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { CatherdError } from "../domain/errors.ts";
import { assertId, ID_PATTERN, parseRung } from "../domain/ids.ts";
import { quotaUsage } from "../domain/select.ts";
import { assertLaneHeader } from "../domain/lane.ts";
import type { Role } from "../domain/roles.ts";
import { cell } from "../domain/util.ts";
import {
  type ClimbReason,
  currentRoute,
  laneOutcome,
  nextRung,
  type OutcomeRow,
  outcomeRouteRow,
  type RouteRow,
} from "../domain/route.ts";
import { withFileLock } from "../infra/filelock.ts";
import { commitExists } from "../infra/git.ts";
import { laneFile } from "./admission.ts";
import { budgetOf } from "./budget.ts";
import { pendingDispatches } from "./dispatches.ts";
import { workspaceBudget } from "./workspace-admission.ts";
import { findWorkspace, workspaceChildren, workspaceDirectory, workspacePaths } from "./workspace-store.ts";
import {
  isDocPath,
  isSourcePath,
  landedMilestones,
  fullCommit,
  milestoneFiles,
  milestoneStart,
  partialReviewer,
  reviewerPassed,
  milestoneVerifier,
} from "./milestones.ts";
import type { Deps, Verdict } from "./ports.ts";
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
  runFile,
  runPaths,
} from "./run-store.ts";
import { writeDigest } from "./protocol.ts";
import { openQuestions } from "./questions.ts";
import { type Notes, type NotesPatch, refreshState } from "./state.ts";

const withHints = (hints: string[]) => (hints.length ? { hints } : {});

/**
 * Spec 1.5 plan 24: what `route` returns: little, since every call lands in the coordinator's context. The
 * decision's source, kind, difficulty, Jev's answer and the provenance go to routes.jsonl.
 */
export interface RouteResult {
  lane: string | null;
  role: Role;
  rung: string;
  ladder: string[];
  backend: string;
  /** the native agent to run a `claude:` rung as */
  agent: string | null;
  /** the decision in one line */
  why: string;
}

function readLaneFile(run: Run, path: string): { lane: string; text: string } {
  const file = runFile(run, path, "read");
  const [folder, name, ...deeper] = relative(run.dir, file).split(sep);
  const lane = folder === "lanes" && deeper.length === 0 && name?.endsWith(".md") ? name.slice(0, -3) : null;
  if (!lane || !ID_PATTERN.test(lane))
    throw new CatherdError("E_LANE_INVALID", `a lane file lives at lanes/<id>.md, not ${path}`, {
      fix: "pass lane_file as lanes/Mx.Ly.md",
    });
  if (!existsSync(file))
    throw new CatherdError("E_LANE_INVALID", `no lane file ${path}`, {
      fix: "write it with write_run_file first",
    });
  const text = readFileSync(file, "utf8");
  // spec 1.1 §6: a lane routes only on values the catalog knows
  assertLaneHeader(text, `lanes/${lane}.md`);
  return { lane, text };
}

/**
 * Spec 1.5 plan 24: the run's dispatches per quota, plus each lane routed but not dispatched yet at its current
 * rung, so a tie between quotas goes to the one the run will have used least.
 */
function runUsage(run: Run): Record<string, number> {
  const records = readRecords(run).records;
  const dispatched = new Set(records.flatMap((r) => (r.lane ? [r.lane] : [])));
  const routes = readRoutes(run);
  const waiting = [...new Set(routes.map((r) => r.lane))]
    .filter((l) => !dispatched.has(l))
    .flatMap((l) => currentRoute(routes, l)?.rung ?? []);
  return quotaUsage([...records.map((r) => r.rung), ...waiting]);
}

/** Spec §5.4 through the routing port; every decision is recorded in routes.jsonl. */
export async function route(
  deps: Deps,
  i: { run: string; laneFile?: string; role: Role },
): Promise<RouteResult> {
  const [one] = await routeLanes(deps, { run: i.run, laneFiles: [i.laneFile], role: i.role });
  return one as RouteResult;
}

/**
 * Spec 1.5 plan 24, batch `route`: several lanes of one role in one call (Jev asked about all at once), each
 * recorded as `route` records one. `laneFiles` holds `undefined` for a role routed without a lane.
 */
export async function routeLanes(
  deps: Deps,
  i: { run: string; laneFiles: (string | undefined)[]; role: Role },
): Promise<RouteResult[]> {
  const run = findRun(i.run);
  const lanes = i.laneFiles.map((f) => (f === undefined ? null : readLaneFile(run, f)));
  const dup = lanes.find((l, n) => l && lanes.findIndex((x) => x?.lane === l.lane) !== n);
  if (dup)
    throw new CatherdError("E_INPUT_INVALID", `route: lane ${dup.lane} is named twice`, {
      fix: "name each lane file once",
    });
  const profile = deps.profiles.forRepo(run.meta.repo);
  const spentFraction = Math.max(
    budgetOf(run, profile.budget, deps.now())?.fraction ?? 0,
    (await workspaceBudget(run, deps.now()))?.fraction ?? 0,
  );
  const reqs = lanes.map((lane) => ({
    host: deps.host.host,
    runDir: run.dir,
    repo: run.meta.repo,
    profile,
    role: i.role,
    lane: lane?.lane ?? null,
    laneText: lane?.text ?? null,
    usage: runUsage(run),
    spentFraction,
  }));
  const answers =
    reqs.length === 1
      ? [await deps.routing.route(reqs[0] as (typeof reqs)[number])]
      : await deps.routing.routeMany(reqs);
  return answers.map((a, n) => record(deps, run, i.role, lanes[n] ?? null, a));
}

/** One decision into routes.jsonl (spec 1.5 plan 24: every role's, with its source, ladder and provenance). */
function record(
  deps: Deps,
  run: Run,
  role: Role,
  lane: { lane: string } | null,
  a: Awaited<ReturnType<Deps["routing"]["route"]>>,
): RouteResult {
  const at = new Date(deps.now()).toISOString();
  const detail = {
    why: a.why,
    ...(a.jevSaid ? { jevSaid: a.jevSaid } : {}),
    ...(a.noClear ? { noClear: a.noClear } : {}),
    ...(a.tie ? { tie: a.tie } : {}),
    ...(a.provenance ? { provenance: a.provenance } : {}),
  };
  if (lane)
    appendRoute(run, {
      at,
      lane: lane.lane,
      role,
      rung: a.rung,
      ladder: a.ladder,
      source: "route",
      decidedBy: a.source,
      from: null,
      reason: null,
      kind: a.kind,
      difficulty: a.difficulty,
      questionSet: a.questionSet,
      jev: a.jev,
      ...detail,
    });
  else
    appendRoute(run, {
      at,
      lane: null,
      role,
      name: null,
      rung: a.rung,
      ladder: a.ladder,
      source: "route",
      decidedBy: a.source,
      ...detail,
    });
  return {
    lane: lane?.lane ?? null,
    role,
    rung: a.rung,
    ladder: a.ladder,
    backend: parseRung(a.rung).backend,
    agent: deps.profiles.agentFor(run.meta.repo, role, a.rung),
    why: a.why,
  };
}

/** Evidence that the lane's own ownership is the problem: a design question, never a capability one. */
const OWNERSHIP = /outside (the )?lane('s)? ownership|owned by/i;

const CLIMB_DESIGN_FIX = "send it to the architect (ask/architect delta), not up the ladder";

/**
 * Spec 1.1 §9: a climb is for capability. Evidence that points at the plan (a contradiction, a file the
 * lane does not own, a cross-lane interface) goes to the architect: ownership evidence on a `blocked`
 * climb is refused outright; with Jev on, its `finding` answer `design` refuses any climb with evidence.
 * A climb the environment caused (`env`) is never a design question.
 */
async function refuseDesign(
  deps: Deps,
  run: Run,
  i: { lane: string; reason: ClimbReason; evidence?: string; env?: boolean },
): Promise<void> {
  if (!i.evidence || i.env) return;
  if (i.reason === "blocked" && OWNERSHIP.test(i.evidence))
    throw new CatherdError(
      "E_CLIMB_DESIGN",
      `climb ${i.lane}: the evidence is about lane ownership, which a higher rung cannot fix`,
      { fix: CLIMB_DESIGN_FIX },
    );
  const use = deps.profiles.forRepo(run.meta.repo).jev.use;
  if (use === "off") return;
  const file = laneFile(run, i.lane);
  if (!existsSync(file)) return;
  const v = await deps.routing.finding(run.dir, readFileSync(file, "utf8"), i.evidence, use);
  if (v.value === "design")
    throw new CatherdError("E_CLIMB_DESIGN", `climb ${i.lane}: Jev calls the evidence a design finding`, {
      fix: CLIMB_DESIGN_FIX,
    });
}

/**
 * A lane's final outcome: its outcomes.jsonl row (spec §5.6) and, beside Jev's answer, its routes.jsonl row
 * (spec 1.5 plan 24). Called under the routes lock.
 */
function writeOutcome(run: Run, routes: RouteRow[], o: OutcomeRow): void {
  appendOutcome(run, o);
  appendRoute(run, outcomeRouteRow(routes, o));
}

/** Spec §4.5: one rung up the lane's ladder, on a fresh thread; the reason goes to routes.jsonl. */
export async function climb(
  deps: Deps,
  i: { run: string; lane: string; reason: ClimbReason; evidence?: string; env?: boolean },
): Promise<{
  lane: string;
  rung: string;
  top: boolean;
  backend: string;
  agent: string | null;
  hints?: string[];
}> {
  const run = findRun(i.run);
  assertId("lane", i.lane);
  const unrouted = () =>
    new CatherdError("E_LANE_INVALID", `lane ${i.lane} was never routed`, {
      fix: `route(run, "lanes/${i.lane}.md") first`,
    });
  // an unrouted lane is refused before Jev is asked about its evidence (no call, no jev.jsonl row)
  if (!currentRoute(readRoutes(run), i.lane)) throw unrouted();
  // plan 23: a reply that named the environment (ENV: …) would stop a higher rung the same way
  const last = readRecords(run)
    .records.filter((r) => r.lane === i.lane)
    .at(-1);
  if (last?.environment)
    throw new CatherdError(
      "E_CLIMB_ENV",
      `climb ${i.lane}: ${last.name} was stopped by the environment (${last.environment}), which a higher rung cannot fix`,
      {
        fix: `fix the environment (doctor; catherd knowledge env set for the gate environment) and dispatch ${i.lane} again at the same rung, or park the milestone when only the owner can fix it`,
      },
    );
  await refuseDesign(deps, run, i);
  const { cur, next } = await withFileLock(runPaths(run.dir).routes, () => {
    const cur = currentRoute(readRoutes(run), i.lane);
    if (!cur) throw unrouted();
    const next = nextRung(cur.ladder, cur.rung);
    appendRoute(run, {
      ...cur,
      at: new Date(deps.now()).toISOString(),
      source: "climb",
      from: cur.rung,
      rung: next ?? cur.rung,
      reason: i.evidence ? `${i.reason}: ${i.evidence}` : i.reason,
      env: i.env === true,
    });
    // spec §5.6: a climb past the top rung ends the lane open
    if (!next) {
      const routes = readRoutes(run);
      const o = laneOutcome(routes, i.lane, false, new Date(deps.now()).toISOString());
      if (o) writeOutcome(run, routes, o);
    }
    return { cur, next };
  });
  const { hints } = await refreshState(run, {
    next: next
      ? `dispatch ${i.lane} at ${next} on a fresh thread`
      : `${i.lane} failed on its top rung: ask finding, then the architect or the report`,
  });
  const rung = next ?? cur.rung;
  return {
    lane: i.lane,
    rung,
    top: next === null,
    backend: parseRung(rung).backend,
    agent: next ? deps.profiles.agentFor(run.meta.repo, cur.role, next) : null,
    ...withHints(hints),
  };
}

export const LAND_SKIPS = ["docs-only", "no-code"] as const;
export type LandSkip = (typeof LAND_SKIPS)[number];

/**
 * Spec 1.1 §6: a milestone lands only with a reviewer record and a verifier verdict since its lanes
 * started, or with a `skip` the commit range bears out. Throws E_LAND_GATE naming what is missing.
 */
async function gate(run: Run, m: string, commit: string, skip: LandSkip | undefined): Promise<void> {
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
    if (against.length === 0) return;
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
  const missing = [
    ...(reviewerPassed(run, m, start)
      ? []
      : [
          `a reviewer record (a dispatch named reviewer-${m}, or record_agent_run with role reviewer and that name, status ok)`,
        ]),
    ...(verdict?.passed
      ? []
      : [
          `a verifier verdict (record_agent_run with role verifier and a name holding ${m}, status ok; a headless verifier's reply opening VERDICT: PASS)${verdict ? `: the latest, ${verdict.name}${verdict.headless ? " (headless)" : ""}, is ${verdict.verdict}` : ""}`,
        ]),
  ];
  if (missing.length)
    throw new CatherdError(
      "E_LAND_GATE",
      `land ${m}: missing ${missing.join(" and ")}, since its lanes started`,
      {
        fix: `run reviewer-${m} (a dispatch, or a Claude subagent recorded with record_agent_run(name: "reviewer-${m}")) and the verifier on ${m}, recording it with record_agent_run(name: "verifier-${m}") (a FAIL with status "failed"), then land again; a docs-only milestone passes skip: "docs-only"`,
      },
    );
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

export async function land(deps: Deps, i: LandInput) {
  const run = findRun(i.run);
  if (!run.meta.workspace) return landRun(deps, i, run);
  const workspace = findWorkspace(run.meta.workspace.id);
  // Completion and dispatch admission share a boundary. Landing remains available at a spent budget.
  return withFileLock(workspacePaths(workspaceDirectory(workspace.id)).admission, async () => {
    if (!workspaceChildren(workspace).some((child) => child.dir === run.dir))
      throw new CatherdError("E_RUN_CORRUPT", "the run is not a member of its workspace execution");
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
    // An unreadable newer native verdict must not leave an older PASS standing.
    readAgentRuns(run, true);
    return landRun(deps, i, run);
  });
}

async function landRun(
  deps: Deps,
  i: LandInput,
  run: Run,
): Promise<{ ledger: string; minutes: number; digest: string; hints?: string[] }> {
  // the digest is named after the milestone: an id, checked before anything is written
  assertId("milestone", i.milestone);
  // commitExists throws E_IO_UNEXPECTED on a timeout, which reaches the caller as is
  if (!/^[0-9a-f]{7,40}$/.test(i.commit) || !(await commitExists(run.meta.repo, i.commit)))
    throw new CatherdError("E_RUN_COMMIT", `no commit ${i.commit} in ${run.meta.repo}`, {
      fix: "commit the milestone first, then pass its hash",
    });
  await gate(run, i.milestone, i.commit, i.skip);
  const now = new Date(deps.now());
  let row = "";
  let minutes = 0;
  const landRow = (notes: Notes): NotesPatch => {
    minutes = Math.max(
      0,
      Math.round((now.getTime() - Date.parse(notes.lastLandedAt ?? run.meta.createdAt)) / 60_000),
    );
    row = [i.milestone, i.what, i.commit, String(minutes), i.evidence].map(cell).join(" | ");
    appendLedger(run, row);
    return { lastCheck: cell(i.evidence), next: i.next, lastLandedAt: now.toISOString() };
  };
  // on a failed refresh the notes still reach state.json, so the next landing counts its minutes from this one
  const { hints } = await refreshState(run, landRow);
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
  if (i.learned) appendKnowledge(run.meta.repo, now, `${run.meta.title} ${i.milestone}`, i.learned);
  // spec 1.1 §10: the milestone's digest, which the milestone push links
  const digest = writeDigest(run, {
    milestone: i.milestone,
    what: i.what,
    commit: i.commit,
    evidence: i.evidence,
    minutes,
    at: now.toISOString(),
  });
  return { ledger: row, minutes, digest, ...withHints(hints) };
}

/** Jev's `finding` or `same-defect` answer, through the routing port. */
export async function ask(
  deps: Deps,
  i: { run: string; question: "finding" | "same-defect"; state: Record<string, string> },
): Promise<Verdict<string>> {
  const run = findRun(i.run);
  const need = (k: string): string => {
    const v = i.state[k];
    if (!v)
      throw new CatherdError("E_INPUT_INVALID", `ask ${i.question} needs state.${k}`, {
        fix: i.question === "finding" ? "pass state { lane_file, finding }" : "pass state { before, after }",
      });
    return v;
  };
  // spec §5.5: a profile with Jev off never asks it, for routing or for these verdicts
  const use = deps.profiles.forRepo(run.meta.repo).jev.use;
  if (i.question === "finding") {
    const { text } = readLaneFile(run, need("lane_file"));
    return deps.routing.finding(run.dir, text, need("finding"), use);
  }
  return deps.routing.sameDefect(run.dir, need("before"), need("after"), use);
}
