import { sessionKey } from "../domain/host.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { budgetStatus } from "../domain/budget.ts";
import { ID_PATTERN } from "../domain/ids.ts";
import type { RunRecord } from "../domain/record.ts";
import { dispatchPaths } from "../infra/dispatch-dir.ts";
import { nonBlankLines } from "../infra/store.ts";
import { spendOf } from "./budget.ts";
import { dispatchState, listDispatches, liveDispatches } from "./dispatches.ts";
import { lastActivity } from "./finalize.ts";
import type { Deps } from "./ports.ts";
import { findRun, listRuns, readRecords, type Run, runPaths } from "./run-store.ts";
import { groupRuns, type SessionGroup } from "./session-view.ts";
import { orchestratorWait, type OrchestratorWait } from "./orchestrator-wait.ts";

/**
 * Spec §4: what the Runs tab shows. The top level is the sessions; a session's screen holds its runs, each with its
 * milestones and every role (live ones first); a role's screen holds its brief, reply and record.
 */

export interface SessionRow {
  /** the session id; null for "earlier runs" */
  key: string | null;
  name: string;
  live: boolean;
  runs: number;
  liveRoles: number;
  landed: number;
  /** ISO time of its newest activity */
  lastActivity: string;
}

export interface RoleRow {
  run: string;
  dispatchId: string;
  name: string;
  role: string;
  rung: string;
  /** running | starting while live; once finished, the record's status (`finished` until it has one) */
  status: string;
  live: boolean;
  /** a live role's admission time: the page ticks its elapsed time from it */
  since: string;
  /** a finished role's seconds, from its record */
  secs: number | null;
  /** a live role's last command, file edit or message line */
  lastEvent: string | null;
  replyStatus: string | null;
}

export interface Milestone {
  name: string;
  landed: boolean;
  /** the ledger's "what" once landed; before that, plan.md's line for the milestone ("" when it has none) */
  what: string;
}

export interface SessionRun {
  waiting?: OrchestratorWait | null;
  id: string;
  title: string;
  repo: string;
  createdAt: string;
  continued: "here" | "elsewhere" | null;
  continuedIn: string | null;
  /** the budget's spent fraction, null without a cap */
  budget: number | null;
  milestones: Milestone[];
  roles: RoleRow[];
}

export interface SessionDetail {
  session: SessionRow;
  runs: SessionRun[];
  /** the run folders to watch for changes */
  dirs: string[];
}

export interface RoleDetail {
  run: string;
  runTitle: string;
  dispatchId: string;
  name: string;
  role: string;
  rung: string;
  /** running | starting | finished */
  state: string;
  brief: string;
  reply: string;
  record: RunRecord | null;
}

export interface MilestoneDetail {
  run: string;
  runTitle: string;
  name: string;
  landed: boolean;
  what: string;
  /** R/digests/<name>.md; null when land has not written one (not landed, or landed by 1.0) or it is empty */
  digest: string | null;
}

const keyOf = (g: SessionGroup): string | null => (g.session ? sessionKey(g.session) : null);

/** The runs that live on in a session now (it owns them): each run's live roles and landings count once. */
const ownRuns = (g: SessionGroup): Run[] => g.runs.filter((x) => x.current).map((x) => x.run);

function rowOf(deps: Deps, g: SessionGroup): SessionRow {
  const own = ownRuns(g);
  return {
    key: keyOf(g),
    name: g.session?.name ?? "earlier runs",
    live: g.session?.live ?? false,
    runs: g.runs.length,
    liveRoles: own.reduce((n, r) => n + liveDispatches(r, deps.now()).length, 0),
    landed: own.reduce((n, r) => n + Math.max(0, nonBlankLines(runPaths(r.dir).ledger).length - 1), 0),
    lastActivity: new Date(g.lastActivity).toISOString(),
  };
}

/** The Runs tab's top level: every session, newest activity first, "earlier runs" last. */
export function sessionRows(deps: Deps): { rows: SessionRow[]; warnings: string[] } {
  const { runs, corrupt } = listRuns();
  return {
    rows: groupRuns(runs).map((g) => rowOf(deps, g)),
    warnings: corrupt.map((c) => `skipped run ${c.id}: ${c.reason}`),
  };
}

/**
 * A milestone's line in plan.md: a heading, list item or plain line that opens with its id and a separator
 * (`## M1 — the jobs list`, `- **M2:** export`). The id stops at the separator, so `M1.L1 — …` is a lane's.
 */
const PLAN_LINE =
  /^\s*(?:#{1,6}\s+|[-*]\s+|\d+[.)]\s+)?(?:\*\*)?([A-Za-z0-9_-]+)(?::\*\*|(?:\*\*)?\s*(?:—|–|:|-))\s*(.+?)\s*$/;

/** The description plan.md gives each of `names`, from the first line that opens with it; none for the rest. */
function planWhat(run: Run, names: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const file = runPaths(run.dir).plan;
  if (names.length === 0 || !existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = PLAN_LINE.exec(line);
    const name = m?.[1];
    if (m && name && names.includes(name) && !out.has(name)) out.set(name, (m[2] ?? "").trim());
  }
  return out;
}

const byNumber = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/**
 * The ledger's landed milestones, then each milestone a lane file names that has not landed, whatever its id:
 * lane `<milestone>.<lane>` belongs to the milestone before its first dot, as protocol.ts reads it. An open
 * milestone's description is plan.md's line for it, when there is one.
 */
function milestonesOf(run: Run): Milestone[] {
  const landed = nonBlankLines(runPaths(run.dir).ledger)
    .slice(1)
    .map((l) => l.split(" | "))
    .map(([name, what]) => ({ name: (name ?? "").trim(), landed: true, what: (what ?? "").trim() }));
  const lanes = existsSync(runPaths(run.dir).lanes) ? readdirSync(runPaths(run.dir).lanes) : [];
  const names = [
    ...new Set(
      lanes
        .filter((f) => f.endsWith(".md") && f.slice(0, -".md".length).includes("."))
        .map((f) => f.split(".")[0] as string),
    ),
  ]
    .filter((m) => m !== "" && !landed.some((l) => l.name === m))
    .sort(byNumber);
  const what = planWhat(run, names);
  return [...landed, ...names.map((name) => ({ name, landed: false, what: what.get(name) ?? "" }))];
}

/** Each role's latest dispatch, live ones first, then the newest finished first. */
function rolesOf(deps: Deps, run: Run): RoleRow[] {
  const now = deps.now();
  const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
  const latest = new Map<string, ReturnType<typeof listDispatches>[number]>();
  for (const d of listDispatches(run)) latest.set(d.admit.name, d);
  const rows = [...latest.values()].map((d): RoleRow => {
    const r = records.get(d.admit.dispatchId);
    const state = r ? "finished" : dispatchState(d, now);
    const live = state !== "finished";
    return {
      run: run.id,
      dispatchId: d.admit.dispatchId,
      name: d.admit.name,
      role: d.admit.role,
      rung: d.admit.rung,
      status: r?.status ?? state,
      live,
      since: d.admit.admittedAt,
      secs: r?.secs ?? null,
      lastEvent: live ? lastActivity(d) : null,
      replyStatus: r?.replyStatus ?? null,
    };
  });
  return rows.sort((a, b) =>
    a.live !== b.live ? (a.live ? -1 : 1) : b.dispatchId.localeCompare(a.dispatchId),
  );
}

function sessionRun(deps: Deps, x: SessionGroup["runs"][number]): SessionRun {
  const run = x.run;
  let budget: number | null = null;
  try {
    const b = budgetStatus(
      spendOf(run, readRecords(run).records, liveDispatches(run, deps.now()), deps.now()),
      deps.profiles.budgetFor?.(run.meta.repo) ?? deps.profiles.forRepo(run.meta.repo).budget,
    );
    budget = b?.fraction ?? null;
  } catch {
    // an unreadable profile: no bar, the rest of the page stands
  }
  return {
    id: run.id,
    waiting: orchestratorWait(run, deps.now()),
    title: run.meta.title,
    repo: run.meta.repo,
    createdAt: run.meta.createdAt,
    continued: x.continued,
    continuedIn: x.continuedIn,
    budget,
    milestones: milestonesOf(run),
    roles: rolesOf(deps, run),
  };
}

/** A session's screen: its runs, newest first, each with its milestones and roles. */
export function sessionDetail(deps: Deps, key: string | null): SessionDetail {
  const g = groupRuns(listRuns().runs).find((x) => keyOf(x) === key);
  if (!g) throw new Error(key === null ? "no earlier runs" : `no session "${key}" in the runs`);
  return {
    session: rowOf(deps, g),
    runs: g.runs.map((x) => sessionRun(deps, x)),
    dirs: g.runs.map((x) => x.run.dir),
  };
}

const text = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/** A role's screen: its brief, its reply and its record. */
export function roleDetail(deps: Deps, runId: string, dispatchId: string): RoleDetail {
  const run = findRun(runId);
  const d = listDispatches(run).find((x) => x.admit.dispatchId === dispatchId);
  if (!d) throw new Error(`no dispatch ${dispatchId} in run ${runId}`);
  const record = readRecords(run).records.find((r) => r.dispatchId === dispatchId) ?? null;
  const p = dispatchPaths(d.dir);
  return {
    run: run.id,
    runTitle: run.meta.title,
    dispatchId,
    name: d.admit.name,
    role: d.admit.role,
    rung: d.admit.rung,
    state: record ? "finished" : dispatchState(d, deps.now()),
    brief: text(p.brief),
    reply: text(p.reply),
    record,
  };
}

/** Spec 1.1 §10: a milestone's screen, its digest. */
export function milestoneDetail(runId: string, name: string): MilestoneDetail {
  const run = findRun(runId);
  // the id rule land writes digests under (assertId): never a path out of the run folder
  const valid = ID_PATTERN.test(name) && !name.includes("..");
  const m = valid ? milestonesOf(run).find((x) => x.name === name) : undefined;
  if (!m) throw new Error(`no milestone "${name}" in run ${runId}`);
  const file = join(run.dir, "digests", `${name}.md`);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  return {
    run: run.id,
    runTitle: run.meta.title,
    name,
    landed: m.landed,
    what: m.what,
    // an empty file is no digest either: land writes the whole digest at once
    digest: text.trim() ? text : null,
  };
}
