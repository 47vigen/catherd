import { statSync } from "node:fs";
import { liveSessionFile, readSessionFiles, type SessionFile } from "../infra/claude-session.ts";
import { type Run, runPaths } from "./run-store.ts";
import { readSessionRows } from "./sessions.ts";

/**
 * Spec §4: runs grouped by the Claude Code session that drove them. A run belongs to the session that started it
 * (`meta.startedBy`); a run listed in another session's rows of `sessions.jsonl` also appears under that session,
 * as "continued here", and under its starting session it says "continued in <name>". Runs from 1.0 (no
 * `startedBy`) go under "earlier runs".
 */

/** A session as the runs page shows it: its name read live while it runs, else the last one recorded. */
export interface RunSession {
  sessionId: string;
  hostSessionId: string | null;
  name: string;
  /** the session's process runs now */
  live: boolean;
}

export interface GroupedRun {
  run: Run;
  /** "here": this session continued a run another started; "elsewhere": another session continued it */
  continued: "here" | "elsewhere" | null;
  /** the session that continued it, for "elsewhere" */
  continuedIn: string | null;
}

export interface SessionGroup {
  /** null: "earlier runs", the 1.0 runs no session is recorded for */
  session: RunSession | null;
  runs: GroupedRun[];
  /** when anything last happened in one of its runs, ms since the epoch */
  lastActivity: number;
}

/** Newest of the run's creation and its state and record files' last writes. */
export function runActivity(run: Run): number {
  const p = runPaths(run.dir);
  let t = Date.parse(run.meta.createdAt) || 0;
  for (const f of [p.stateJson, p.runs, p.state, p.agents]) {
    try {
      t = Math.max(t, statSync(f).mtimeMs);
    } catch {
      // not written yet
    }
  }
  return t;
}

/** The sessions each run has had, oldest first: its starter, then each one that took it over. */
function trailOf(
  run: Run,
): { sessionId: string; hostSessionId: string | null; name: string | null; at: string }[] {
  const rows = readSessionRows(run);
  const s = run.meta.startedBy;
  if (s && !rows.some((r) => r.sessionId === s.sessionId)) return [{ ...s, at: run.meta.createdAt }, ...rows];
  return rows;
}

/** Every run grouped by session, the groups newest activity first, the runs in each newest first. */
export function groupRuns(runs: Run[], files: SessionFile[] = readSessionFiles()): SessionGroup[] {
  // the last name recorded for each session, in any run
  const recorded = new Map<string, { name: string | null; host: string | null; at: string }>();
  const trails = new Map(runs.map((r) => [r.id, trailOf(r)]));
  for (const t of trails.values())
    for (const row of t) {
      const was = recorded.get(row.sessionId);
      if (!was || row.at >= was.at)
        recorded.set(row.sessionId, {
          name: row.name ?? was?.name ?? null,
          host: row.hostSessionId ?? was?.host ?? null,
          at: row.at,
        });
    }
  const sessionOf = (id: string): RunSession => {
    const live = liveSessionFile(id, files);
    const rec = recorded.get(id);
    return {
      sessionId: id,
      hostSessionId: live?.hostSessionId ?? rec?.host ?? null,
      name: live?.name ?? rec?.name ?? `session ${id.slice(0, 8)}`,
      live: live !== null,
    };
  };
  const groups = new Map<string | null, SessionGroup>();
  const add = (id: string | null, g: GroupedRun, at: number) => {
    let group = groups.get(id);
    if (!group) {
      group = { session: id === null ? null : sessionOf(id), runs: [], lastActivity: 0 };
      groups.set(id, group);
    }
    group.runs.push(g);
    group.lastActivity = Math.max(group.lastActivity, at);
  };
  for (const run of runs) {
    const at = runActivity(run);
    const trail = trails.get(run.id) ?? [];
    const starter = run.meta.startedBy?.sessionId ?? null;
    const others = [...new Set(trail.map((t) => t.sessionId))].filter((id) => id !== starter);
    const last = others.at(-1);
    // a run continued elsewhere lives on there: here it counts from when it started, not from its latest write
    add(
      starter,
      { run, continued: last ? "elsewhere" : null, continuedIn: last ? sessionOf(last).name : null },
      last ? Date.parse(run.meta.createdAt) || 0 : at,
    );
    for (const id of others) add(id, { run, continued: "here", continuedIn: null }, at);
  }
  const out = [...groups.values()];
  for (const g of out)
    g.runs.sort(
      (a, b) =>
        runActivity(b.run) - runActivity(a.run) || b.run.meta.createdAt.localeCompare(a.run.meta.createdAt),
    );
  // "earlier runs" last, whatever its activity: 1.0 runs are history
  return out.sort((a, b) =>
    a.session === null ? 1 : b.session === null ? -1 : b.lastActivity - a.lastActivity,
  );
}

/**
 * The session a run started in, as the runs page names it now (null for a run from before 1.1), and the session
 * that continued it, if another did.
 */
export function sessionFacts(
  run: Run,
  files: SessionFile[] = readSessionFiles(),
): { session: RunSession | null; continuedIn: string | null } {
  const starter = run.meta.startedBy?.sessionId ?? null;
  const own = groupRuns([run], files).find((g) => (g.session?.sessionId ?? null) === starter);
  return { session: own?.session ?? null, continuedIn: own?.runs[0]?.continuedIn ?? null };
}
