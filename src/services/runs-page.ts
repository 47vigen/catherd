import { existsSync, readdirSync, readFileSync } from "node:fs";
import { budgetStatus } from "../domain/budget.ts";
import type { RunRecord } from "../domain/record.ts";
import { dispatchPaths } from "../infra/dispatch-dir.ts";
import { nonBlankLines } from "../infra/store.ts";
import { spendOf } from "./budget.ts";
import { dispatchState, listDispatches, liveDispatches } from "./dispatches.ts";
import { lastActivity } from "./finalize.ts";
import type { Deps } from "./ports.ts";
import { findRun, listRuns, readRecords, type Run, runPaths } from "./run-store.ts";
import { groupRuns, type SessionGroup } from "./session-view.ts";

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
  /** the ledger's "what" once landed */
  what: string;
}

export interface SessionRun {
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

const keyOf = (g: SessionGroup): string | null => g.session?.sessionId ?? null;

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

/** The ledger's landed milestones, then each milestone a lane file names that has not landed. */
function milestonesOf(run: Run): Milestone[] {
  const landed = nonBlankLines(runPaths(run.dir).ledger)
    .slice(1)
    .map((l) => l.split(" | "))
    .map(([name, what]) => ({ name: (name ?? "").trim(), landed: true, what: (what ?? "").trim() }));
  const lanes = existsSync(runPaths(run.dir).lanes) ? readdirSync(runPaths(run.dir).lanes) : [];
  const open = [...new Set(lanes.map((f) => /^(M\d+)\./.exec(f)?.[1]).filter((m): m is string => !!m))]
    .filter((m) => !landed.some((l) => l.name === m))
    .map((name) => ({ name, landed: false, what: "" }));
  const n = (m: string) => Number(/\d+/.exec(m)?.[0] ?? 0);
  return [...landed, ...open.sort((a, b) => n(a.name) - n(b.name))];
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
      deps.profiles.forRepo(run.meta.repo).budget,
    );
    budget = b?.fraction ?? null;
  } catch {
    // an unreadable profile: no bar, the rest of the page stands
  }
  return {
    id: run.id,
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
