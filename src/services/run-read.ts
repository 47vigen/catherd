import { z } from "zod";
import { errorMessage } from "../domain/errors.ts";
import { PARK_REASONS, describeEvent } from "../domain/run-events.ts";
import { type RunState, liveDispatches } from "../domain/run-state.ts";
import { log } from "../infra/log.ts";
import { daemonAlive, ensureDaemon, readHeartbeat } from "./daemon.ts";
import { liveDispatches as liveDispatchesOf } from "./dispatches.ts";
import { landedMilestones } from "./milestones.ts";
import type { Deps } from "./ports.ts";
import { openQuestions } from "./questions.ts";
import { isDaemonRun, readEvents, replayRun, tailEvents } from "./run-events-store.ts";
import { findRun, listRuns, type Run } from "./run-store.ts";

/**
 * The read side of a run, for the panel (plan 31) and the session's `status`: each shape has a zod
 * schema, which is its contract. A 1.5 run reads as `engine: "1.5"`, with what its folder says.
 */
export const ParkedViewSchema = z.object({
  run: z.string(),
  runTitle: z.string(),
  unit: z.string(),
  question: z.string(),
  reason: z.enum(PARK_REASONS),
  at: z.string(),
  /** the command that answers it */
  command: z.string(),
});
export type ParkedView = z.infer<typeof ParkedViewSchema>;

export const TimelineEntrySchema = z.object({
  seq: z.number().int(),
  at: z.string(),
  type: z.string(),
  text: z.string(),
});
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

export const RunViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  repo: z.string(),
  engine: z.enum(["2.0", "1.5"]),
  phase: z.enum(["planning", "approval", "running", "ended"]).nullable(),
  outcome: z.enum(["done", "cancelled", "failed"]).nullable(),
  daemon: z.object({
    alive: z.boolean(),
    pid: z.number().int().nullable(),
    beatAgeSec: z.number().nullable(),
  }),
  milestones: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      round: z.number().int(),
      commit: z.string().nullable(),
    }),
  ),
  live: z.array(
    z.object({ name: z.string(), role: z.string(), rung: z.string(), unit: z.string(), since: z.string() }),
  ),
  parked: z.array(ParkedViewSchema),
  holds: z.array(z.object({ quota: z.string(), until: z.string() })),
  /** the latest event, in one line */
  last: z.string().nullable(),
  /** the start of the pause in force */
  paused: z.string().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
});
export type RunView = z.infer<typeof RunViewSchema>;

export { tailEvents };

const answerCommand = (run: string, unit: string): string => `catherd answer ${run} ${unit} "<answer>"`;

function parkedOf(run: Run, s: RunState): ParkedView[] {
  return Object.values(s.questions).map((q) => ({
    run: run.id,
    runTitle: run.meta.title,
    unit: q.unit,
    question: q.question,
    reason: q.reason,
    at: q.at,
    command: answerCommand(run.id, q.unit),
  }));
}

/** A daemon of an unfinished 2.0 run is started again when it is dead; a failure to start never fails a read. */
function revive(run: Run): void {
  try {
    ensureDaemon(run);
  } catch (e) {
    log("warn", "daemon", { run: run.id, revive: errorMessage(e) });
  }
}

function view15(deps: Deps, run: Run): RunView {
  const now = deps.now();
  return {
    id: run.id,
    title: run.meta.title,
    repo: run.meta.repo,
    engine: "1.5",
    phase: null,
    outcome: null,
    daemon: { alive: false, pid: null, beatAgeSec: null },
    milestones: landedMilestones(run).map((id) => ({
      id,
      title: id,
      status: "landed",
      round: 0,
      commit: null,
    })),
    live: liveDispatchesOf(run, now).map((d) => ({
      name: d.admit.name,
      role: d.admit.role,
      rung: d.admit.rung,
      unit: d.admit.lane ?? d.admit.name,
      since: d.admit.admittedAt,
    })),
    parked: openQuestions(run).map((q) => ({
      run: run.id,
      runTitle: run.meta.title,
      unit: q.milestone,
      question: q.question,
      reason: "needs_user" as const,
      at: q.at,
      command: `answer(run: "${run.id}", milestone: "${q.milestone}", answer: "<answer>")`,
    })),
    holds: [],
    last: null,
    paused: null,
    startedAt: run.meta.createdAt,
    updatedAt: run.meta.createdAt,
  };
}

/** One run at a glance. Reading an unfinished 2.0 run starts its daemon again if it died. */
export function runView(deps: Deps, runId: string): RunView {
  const run = findRun(runId);
  if (!isDaemonRun(run)) return view15(deps, run);
  revive(run);
  const s = replayRun(run);
  const beat = readHeartbeat(run);
  const events = readEvents(run);
  const last = events.at(-1);
  return {
    id: run.id,
    title: run.meta.title,
    repo: run.meta.repo,
    engine: "2.0",
    phase: s.phase,
    outcome: s.outcome,
    daemon: {
      alive: daemonAlive(run),
      pid: beat?.pid ?? null,
      beatAgeSec: beat ? Math.max(0, Math.round((deps.now() - Date.parse(beat.beatAt)) / 1000)) : null,
    },
    milestones: s.milestones.map((m) => ({
      id: m.id,
      title: m.title,
      status: m.status,
      round: m.round,
      commit: m.commit,
    })),
    live: liveDispatches(s).map((d) => ({
      name: d.name,
      role: d.role,
      rung: d.rung,
      unit: d.unit,
      since: d.startedAt,
    })),
    parked: parkedOf(run, s),
    holds: Object.entries(s.holds).map(([quota, until]) => ({ quota, until })),
    last: last ? describeEvent(last, (id) => s.dispatches[id]?.rung) : null,
    paused: s.paused,
    startedAt: run.meta.createdAt,
    updatedAt: last?.at ?? run.meta.createdAt,
  };
}

/** Every run, newest first (one repo's with `repo`), at most `limit` (default 50). */
export function listRunViews(deps: Deps, o: { repo?: string; limit?: number } = {}): RunView[] {
  const runs = listRuns(o.repo ? [o.repo] : undefined).runs.slice(0, o.limit ?? 50);
  const out: RunView[] = [];
  for (const r of runs) {
    try {
      out.push(runView(deps, r.id));
    } catch (e) {
      log("warn", "read", { run: r.id, error: errorMessage(e) });
    }
  }
  return out;
}

/** The run's events from `fromSeq`, one line each (never a reply's body), at most `limit` (default 200). */
export function runTimeline(runId: string, fromSeq = 1, limit = 200): TimelineEntry[] {
  const run = findRun(runId);
  if (!isDaemonRun(run)) return [];
  const s = replayRun(run);
  return readEvents(run, fromSeq)
    .slice(0, limit)
    .map((e) => ({
      seq: e.seq,
      at: e.at,
      type: e.type,
      text: describeEvent(e, (id) => s.dispatches[id]?.rung),
    }));
}

/** Every unfinished 2.0 run's open questions (one run's with `run`), each with the command that answers it. */
export function parkedQuestions(o: { run?: string } = {}): ParkedView[] {
  const runs = o.run ? [findRun(o.run)] : listRuns().runs;
  return runs.flatMap((run) => {
    try {
      if (!isDaemonRun(run)) return [];
      const s = replayRun(run);
      return s.phase === "ended" ? [] : parkedOf(run, s);
    } catch (e) {
      log("warn", "read", { run: run.id, error: errorMessage(e) });
      return [];
    }
  });
}
