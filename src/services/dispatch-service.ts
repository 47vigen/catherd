import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { CatherdError, isCatherdError } from "../domain/errors.ts";
import { assertId, parseRung } from "../domain/ids.ts";
import { dispatchHints } from "../domain/hints.ts";
import type { RunRecord } from "../domain/record.ts";
import type { Role } from "../domain/roles.ts";
import { dispatchPaths, readExit, requestCancel } from "../infra/dispatch-dir.ts";
import { isAlive, killGroup } from "../infra/proc.ts";
import { writeJsonAtomic } from "../infra/store.ts";
import { admit, KILL_GRACE_MS, laneFile, launch } from "./admission.ts";
import { standInFor } from "./backends.ts";
import { type Dispatch, liveDispatches, readProc } from "./dispatches.ts";
import { finalizeDispatch, waitForFinish } from "./finalize.ts";
import type { Deps } from "./ports.ts";
import { findRun, type Run } from "./run-store.ts";
import { type NotesPatch, refreshState } from "./state.ts";

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

/** Refreshes state.md (spec §4.5 notes kept on a git failure); a refresh that fails adds its hint once. */
async function refresh(run: Run, change: NotesPatch, hints: string[]): Promise<void> {
  for (const h of (await refreshState(run, change)).hints) if (!hints.includes(h)) hints.push(h);
}

/**
 * Launches an admitted dispatch, then refreshes state.md with `change` (after the launch, so nothing
 * delays it), waits for it with progress, and finalizes it. A refresh that fails adds its hint to `stateHints`.
 */
export async function runToEnd(
  deps: Deps,
  run: Run,
  d: Dispatch,
  specPath: string,
  onProgress?: Progress,
  stateHints: string[] = [],
  change: NotesPatch = {},
): Promise<RunRecord> {
  launch(d, specPath);
  await refresh(run, change, stateHints);
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
  const first = await runToEnd(
    deps,
    run,
    d,
    specPath,
    onProgress,
    stateHints,
    i.next ? { next: i.next } : {},
  );
  const out =
    first.status === "limit"
      ? await failover(deps, run, d, first, onProgress, stateHints)
      : { record: first, hints: hintsFor(run, d, first), pause: null };
  await refresh(run, out.pause ? { next: out.pause } : {}, stateHints);
  return { record: out.record, hints: [...out.hints, ...stateHints] };
}

/**
 * The stand-in's brief (spec §4.5, audit C4). A fresh round reruns its own brief; a fix round hands
 * over the lane file and the fix brief by path, since the stand-in cannot resume the old thread.
 */
function standInBrief(run: Run, d: Dispatch): string {
  const own = dispatchPaths(d.dir).brief;
  if (d.admit.thread === null) return readFileSync(own, "utf8");
  return [
    `You take over ${d.admit.name} from ${d.admit.rung}, which hit a usage limit. You start on a fresh thread, so read these first:`,
    ...(d.admit.lane ? [`- the lane file: ${laneFile(run, d.admit.lane)}`] : []),
    `- the fix brief the previous thread was given: ${own}`,
    "The work so far is in the tree. Do what the fix brief asks.",
  ].join("\n");
}

/** Spec §4.5: on a limit, run the rung's stand-in on a fresh thread, through admission again (budget included). */
async function failover(
  deps: Deps,
  run: Run,
  d: Dispatch,
  limited: RunRecord,
  onProgress?: Progress,
  stateHints: string[] = [],
): Promise<DispatchResult & { pause: string | null }> {
  const paused = `paused: ${limited.backend} usage limit; resume when the user says so`;
  const hints = hintsFor(run, d, limited);
  const standIn = standInFor(deps.profiles.forRepo(run.meta.repo).failover, limited.rung);
  if (!standIn) return { record: limited, hints, pause: paused };
  if (parseRung(standIn).backend === "claude") {
    const agent = deps.routing.agentFor(d.admit.role, standIn);
    return {
      record: limited,
      hints: [
        ...hints,
        `failover: run ${d.admit.name} as Agent(subagent_type: "${agent}"), standing in for ${limited.rung}`,
      ],
      pause: null,
    };
  }
  let next: Awaited<ReturnType<typeof admit>>;
  try {
    next = await admit(deps, run, {
      role: d.admit.role,
      name: d.admit.name,
      brief: standInBrief(run, d),
      rung: standIn,
      thread: null,
      lane: d.admit.lane,
      failoverFrom: limited.rung,
    });
  } catch (e) {
    if (!isCatherdError(e)) throw e;
    return {
      record: limited,
      hints: [...hints, `failover: ${standIn} refused: ${e.code} ${e.message}`],
      pause: paused,
    };
  }
  const record = await runToEnd(deps, run, next.d, next.specPath, onProgress, stateHints);
  return {
    record,
    hints: [
      `limit: ${limited.rung} hit a usage limit; failed over to ${standIn}`,
      // the stand-in's before-snapshot already holds the limited run's writes: surface them here
      ...hints.filter((h) => /^(violation|git-unavailable):/.test(h)),
      ...hintsFor(run, next.d, record),
    ],
    pause:
      record.status === "limit"
        ? `paused: ${record.backend} usage limit on ${record.rung} and on ${limited.rung}`
        : null,
  };
}

/**
 * A worker whose supervisor died has no one to read the cancel file: stop its group here (SIGTERM, then
 * SIGKILL after the grace), each signal guarded by the worker's pid and start time, and write the
 * exit.json the supervisor would have. A finalizer that sees the worker gone first reads the cancel file
 * instead (finalize.ts). Nothing happens while the supervisor lives: it acts on the cancel file itself.
 */
async function stopOrphan(deps: Deps, d: Dispatch): Promise<void> {
  const proc = readProc(d.dir);
  if (!proc || readExit(d.dir) || isAlive(proc.supervisorPid, proc.supervisorStartTime)) return;
  const worker = () => isAlive(proc.pid, proc.startTime);
  if (!worker()) return;
  killGroup(proc.pgid ?? proc.pid, "SIGTERM");
  const end = Date.now() + KILL_GRACE_MS;
  while (Date.now() < end && worker()) await Bun.sleep(deps.pollMs);
  if (worker()) killGroup(proc.pgid ?? proc.pid, "SIGKILL");
  writeJsonAtomic(dispatchPaths(d.dir).exit, {
    schema: 1,
    code: null,
    signal: "SIGTERM",
    reason: "cancelled",
    endedAt: new Date().toISOString(),
  });
}

/** Spec §4.7: stop a live dispatch (interrupt, SIGTERM, SIGKILL) and record it as cancelled. */
export async function cancel(deps: Deps, runId: string, name: string): Promise<DispatchResult> {
  const run = findRun(runId);
  assertId("role name", name);
  const live = liveDispatches(run, deps.now()).find((d) => d.admit.name === name);
  if (!live)
    throw new CatherdError("E_RUN_NOT_LIVE", `${name} has no live dispatch`, {
      fix: "status(run) lists the live ones",
    });
  requestCancel(live.dir);
  await stopOrphan(deps, live);
  await waitForFinish(live, { pollMs: deps.pollMs, tickMs: Number.POSITIVE_INFINITY, now: deps.now });
  const record = await finalizeDispatch(run, live);
  const { hints } = await refreshState(run);
  return { record, hints: [...hintsFor(run, live, record), ...hints] };
}
