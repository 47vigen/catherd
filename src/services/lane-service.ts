import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { CatherdError } from "../domain/errors.ts";
import { assertId, ID_PATTERN, parseRung } from "../domain/ids.ts";
import type { Difficulty, Kind } from "../domain/lane.ts";
import type { Role } from "../domain/roles.ts";
import {
  type ClimbReason,
  currentRoute,
  laneOutcome,
  nextRung,
  type RouteJev,
  type RouteSource,
} from "../domain/route.ts";
import { withFileLock } from "../infra/filelock.ts";
import { commitExists } from "../infra/git.ts";
import { budgetOf } from "./budget.ts";
import type { Deps, Verdict } from "./ports.ts";
import {
  appendLedger,
  appendOutcome,
  appendRoute,
  findRun,
  knowledgeFile,
  readRoutes,
  type Run,
  runFile,
  runPaths,
} from "./run-store.ts";
import { type Notes, type NotesPatch, refreshState } from "./state.ts";

const withHints = (hints: string[]) => (hints.length ? { hints } : {});

export interface RouteResult {
  lane: string | null;
  role: Role;
  rung: string;
  ladder: string[];
  source: RouteSource;
  kind: Kind | null;
  difficulty: Difficulty | null;
  backend: string;
  /** the native agent to run a `claude:` rung as */
  agent: string | null;
  /** the Jev question set asked, and what it said, when Jev was asked */
  questionSet: string | null;
  jev: RouteJev | null;
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
  return { lane, text: readFileSync(file, "utf8") };
}

/** Spec §5.4 through the routing port; a lane's route is recorded in routes.jsonl. */
export async function route(
  deps: Deps,
  i: { run: string; laneFile?: string; role: Role },
): Promise<RouteResult> {
  const run = findRun(i.run);
  const lane = i.laneFile === undefined ? null : readLaneFile(run, i.laneFile);
  const profile = deps.profiles.forRepo(run.meta.repo);
  const a = await deps.routing.route({
    runDir: run.dir,
    repo: run.meta.repo,
    profile,
    role: i.role,
    lane: lane?.lane ?? null,
    laneText: lane?.text ?? null,
    spentFraction: budgetOf(run, profile.budget, deps.now())?.fraction ?? 0,
  });
  if (lane)
    appendRoute(run, {
      at: new Date(deps.now()).toISOString(),
      lane: lane.lane,
      role: i.role,
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
    });
  return {
    lane: lane?.lane ?? null,
    role: i.role,
    ...a,
    backend: parseRung(a.rung).backend,
    agent: deps.profiles.agentFor(i.role, a.rung),
  };
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
  const { cur, next } = await withFileLock(runPaths(run.dir).routes, () => {
    const cur = currentRoute(readRoutes(run), i.lane);
    if (!cur)
      throw new CatherdError("E_LANE_INVALID", `lane ${i.lane} was never routed`, {
        fix: `route(run, "lanes/${i.lane}.md") first`,
      });
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
      const o = laneOutcome(readRoutes(run), i.lane, false, new Date(deps.now()).toISOString());
      if (o) appendOutcome(run, o);
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
    agent: next ? deps.profiles.agentFor(cur.role, next) : null,
    ...withHints(hints),
  };
}

const cell = (s: string) => s.replace(/[|\n]/g, "/").replace(/\s+/g, " ").trim();

/**
 * Spec §4.7: the full five-column ledger row, with the minutes since the previous landing (or the
 * run's start), and `learned` appended to the repo's knowledge.md.
 */
export async function land(
  deps: Deps,
  i: {
    run: string;
    milestone: string;
    what: string;
    commit: string;
    evidence: string;
    next: string;
    learned?: string;
  },
): Promise<{ ledger: string; minutes: number; hints?: string[] }> {
  const run = findRun(i.run);
  // commitExists throws E_IO_UNEXPECTED on a timeout, which reaches the caller as is
  if (!/^[0-9a-f]{7,40}$/.test(i.commit) || !(await commitExists(run.meta.repo, i.commit)))
    throw new CatherdError("E_RUN_COMMIT", `no commit ${i.commit} in ${run.meta.repo}`, {
      fix: "commit the milestone first, then pass its hash",
    });
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
  const routes = readRoutes(run);
  for (const lane of new Set(routes.map((r) => r.lane)))
    if (lane.startsWith(`${i.milestone}.`)) {
      const o = laneOutcome(routes, lane, true, now.toISOString());
      if (o) appendOutcome(run, o);
    }
  if (i.learned) {
    const file = knowledgeFile(run.meta.repo);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(
      file,
      `- ${now.toISOString().slice(0, 10)} ${run.meta.title} ${i.milestone}: ${cell(i.learned)}\n`,
    );
  }
  return { ledger: row, minutes, ...withHints(hints) };
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
  if (i.question === "finding") {
    const { text } = readLaneFile(run, need("lane_file"));
    return deps.routing.finding(run.dir, text, need("finding"));
  }
  return deps.routing.sameDefect(run.dir, need("before"), need("after"));
}
