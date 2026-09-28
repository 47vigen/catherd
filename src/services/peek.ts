import { adapterFor } from "../adapters/registry.ts";
import "../adapters/all.ts";
import { assertId } from "../domain/ids.ts";
import { noticeHeader } from "../domain/notice.ts";
import { awaitsCollect, dispatchPaths } from "../infra/dispatch-dir.ts";
import { adopt } from "./dispatch-service.ts";
import { type Dispatch, type DispatchState, listDispatches, liveDispatches } from "./dispatches.ts";
import { finishedNotice } from "./notifier.ts";
import type { Deps } from "./ports.ts";
import { tail } from "./run-debug.ts";
import { findRun, listRuns, readAgentRuns, readRecords, type Run } from "./run-store.ts";
import { claimRun, currentSession, runOwner } from "./sessions.ts";
import { readNotes } from "./state.ts";

/** How much of a role's last event `peek` shows (spec §3.7). */
export const LAST_EVENT_CHARS = 160;

export interface PeekRole {
  name: string;
  role: string;
  rung: string;
  state: DispatchState;
  /** since admission */
  secs: number;
  /** the last command, file edit or message line, else the last event's name; null before any event */
  lastEvent: string | null;
}

export interface PeekRun {
  run: string;
  title: string;
  /** the session that owns the run now, null when none has */
  owner: string | null;
  live: PeekRole[];
  /** each finished record not yet read, as the first line of its message */
  unread: { name: string; dispatchId: string; header: string }[];
  /** the latest native Claude run recorded with record_agent_run */
  native: { name: string; role: string; rung: string; status: string; at: string } | null;
  /** the run's next step (state.md's last line) */
  next: string;
}

const oneLine = (s: string): string => {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.length > LAST_EVENT_CHARS ? `${line.slice(0, LAST_EVENT_CHARS - 1)}…` : line;
};

/**
 * Spec §3.7: what a live role is doing, from the end of its events.jsonl: the last line an adapter reads as an
 * activity (a command, a file edit, a message line), else the last event's name.
 */
export function lastActivity(d: Dispatch): string | null {
  const a = adapterFor(d.admit.backend);
  if (!a) return null;
  const lines = tail(dispatchPaths(d.dir).events, 200);
  let name: string | null = null;
  for (const line of lines.toReversed()) {
    let delta;
    try {
      delta = a.parse(line);
    } catch {
      continue;
    }
    if (delta.activity) return oneLine(delta.activity);
    name ??= delta.lastEvent ?? null;
  }
  return name;
}

function peekRun(deps: Deps, run: Run, name: string | undefined): PeekRun {
  const now = deps.now();
  const mine = (d: Dispatch) => name === undefined || d.admit.name === name;
  const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
  const agents = readAgentRuns(run).filter((a) => name === undefined || a.name === name);
  const native = agents.at(-1);
  return {
    run: run.id,
    title: run.meta.title,
    owner: runOwner(run)?.sessionId ?? null,
    live: liveDispatches(run, now)
      .filter(mine)
      .map((d) => ({
        name: d.admit.name,
        role: d.admit.role,
        rung: d.admit.rung,
        state: d.state,
        secs: Math.max(0, Math.round((now - Date.parse(d.admit.admittedAt)) / 1000)),
        lastEvent: lastActivity(d),
      })),
    unread: listDispatches(run)
      .filter(mine)
      .flatMap((d) => {
        const r = records.get(d.admit.dispatchId);
        return r && awaitsCollect(d.dir)
          ? [{ name: r.name, dispatchId: r.dispatchId, header: noticeHeader(finishedNotice(run, d, r)) }]
          : [];
      }),
    native: native
      ? { name: native.name, role: native.role, rung: native.rung, status: native.status, at: native.at }
      : null,
    next: readNotes(run).next,
  };
}

/**
 * Spec §3.7 `peek(run?, name?)`: never waits, never marks a record read. With a run it makes this session the
 * run's owner (spec §3.3) and watches the roles another session's server launched; without one it shows every run
 * this session owns, else the newest run.
 */
export async function peek(
  deps: Deps,
  i: { run?: string; name?: string },
): Promise<{ runs: PeekRun[]; hints: string[] }> {
  if (i.name !== undefined) assertId("role name", i.name);
  let runs: Run[];
  if (i.run) {
    const run = findRun(i.run);
    if (await claimRun(deps, run)) adopt(deps, run);
    runs = [run];
  } else {
    const all = listRuns().runs;
    const me = currentSession(deps);
    const owned = me ? all.filter((r) => runOwner(r)?.sessionId === me.sessionId) : [];
    runs = owned.length ? owned : all.slice(0, 1);
  }
  const hints = runs.length === 0 ? ["no runs yet: run_start(repo, title, a_lines) starts one"] : [];
  return { runs: runs.map((r) => peekRun(deps, r, i.name)), hints };
}
