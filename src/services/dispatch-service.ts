import { relative } from "node:path";
import { dispatchHints } from "../domain/hints.ts";
import type { RunRecord } from "../domain/record.ts";
import type { Role } from "../domain/roles.ts";
import { admit, launch } from "./admission.ts";
import type { Dispatch } from "./dispatches.ts";
import { finalizeDispatch, waitForFinish } from "./finalize.ts";
import type { Deps } from "./ports.ts";
import { findRun, type Run } from "./run-store.ts";
import { type NotesPatch, updateState } from "./state.ts";

export interface DispatchInput {
  run: string;
  role: Role;
  name: string;
  brief: string;
  rung: string;
  thread?: string;
  lane?: string;
  next?: string;
}

export interface DispatchResult {
  record: RunRecord;
  hints: string[];
}

export type Progress = (message: string) => void;

const hintsFor = (run: Run, d: Dispatch, r: RunRecord) =>
  dispatchHints(r, d.admit.owns, relative(run.dir, d.dir));

/** Rewrites state.md; a refresh that fails (git broken) never fails the dispatch, it adds one hint instead. */
async function refreshState(run: Run, change: NotesPatch, hints: string[]): Promise<void> {
  try {
    await updateState(run, change);
  } catch (e) {
    const hint = `state.md not refreshed: ${e instanceof Error ? e.message : String(e)}`;
    if (!hints.includes(hint)) hints.push(hint);
  }
}

/**
 * Launches an admitted dispatch, waits for it with progress, and finalizes it. A state.md refresh that
 * fails adds its hint to `stateHints`.
 */
export async function runToEnd(
  deps: Deps,
  run: Run,
  d: Dispatch,
  specPath: string,
  onProgress?: Progress,
  stateHints: string[] = [],
): Promise<RunRecord> {
  launch(d, specPath);
  await refreshState(run, {}, stateHints);
  await waitForFinish(d, {
    pollMs: deps.pollMs,
    tickMs: deps.tickMs,
    now: deps.now,
    onTick:
      onProgress &&
      ((secs, ev) => onProgress(`${d.admit.name} · ${d.admit.rung} · ${secs}s${ev ? ` · ${ev}` : ""}`)),
  });
  return finalizeDispatch(run, d);
}

/** Spec §4.4: admit, run and finalize one role; returns its record and what to do next. */
export async function dispatch(deps: Deps, i: DispatchInput, onProgress?: Progress): Promise<DispatchResult> {
  const run = findRun(i.run);
  const { d, specPath } = await admit(deps, run, {
    role: i.role,
    name: i.name,
    brief: i.brief,
    rung: i.rung,
    thread: i.thread ?? null,
    lane: i.lane ?? null,
    failoverFrom: null,
  });
  const stateHints: string[] = [];
  if (i.next) await refreshState(run, { next: i.next }, stateHints);
  const record = await runToEnd(deps, run, d, specPath, onProgress, stateHints);
  await refreshState(
    run,
    record.status === "limit"
      ? { next: `paused: ${record.backend} usage limit; resume when the user says so` }
      : {},
    stateHints,
  );
  return { record, hints: [...hintsFor(run, d, record), ...stateHints] };
}
