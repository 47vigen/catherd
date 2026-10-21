import type { BlockedReason } from "../../src/domain/blocked.ts";
import type { RunEvent, RunEventType, MilestonePlan } from "../../src/domain/run-events.ts";
import { type RunState, replay } from "../../src/domain/run-state.ts";

type Fields<T extends RunEventType> = Omit<Extract<RunEvent, { type: T }>, "v" | "seq" | "at" | "type">;

export const START = "2026-10-21T10:00:00.000Z";

/** An events.jsonl in memory: each `add` gives the next seq and a time one second later (or `at`). */
export function makeLog(start = START) {
  const events: RunEvent[] = [];
  let ms = Date.parse(start);
  const add = <T extends RunEventType>(
    type: T,
    fields: Fields<T>,
    at?: string,
  ): Extract<RunEvent, { type: T }> => {
    ms += 1000;
    const e = {
      v: 1,
      seq: events.length + 1,
      at: at ?? new Date(ms).toISOString(),
      type,
      ...fields,
    } as Extract<RunEvent, { type: T }>;
    events.push(e);
    return e;
  };
  return { events, add, state: (): RunState => replay(events, "r1") };
}
export type Log = ReturnType<typeof makeLog>;

export const PLAN: MilestonePlan[] = [
  {
    id: "M1",
    title: "the wallet core",
    after: [],
    lanes: [
      { id: "M1.L1", role: "worker", kind: "repo_code", after: [], owns: ["src/a/"] },
      { id: "M1.L2", role: "worker", kind: "repo_code", after: ["M1.L1"], owns: ["src/b/", "src/b2.ts"] },
    ],
  },
  {
    id: "M2",
    title: "the docs",
    after: ["M1"],
    lanes: [{ id: "M2.L1", role: "writer", kind: "prose", after: [], owns: ["docs/"] }],
  },
];

export const startedFields = {
  repo: "/repo",
  title: "wallet",
  aLines: ["A1 it works"],
  plan: [] as string[],
  base: null,
  engine: "2.0" as const,
};

let n = 0;
export const newId = (): string => `D${String(++n).padStart(4, "0")}`;

/** A dispatch.started followed by nothing: returns its id. */
export function startDispatch(
  log: Log,
  o: {
    name: string;
    role?: string;
    unit: string;
    lane?: string | null;
    rung?: string;
    thread?: string | null;
    judgeKind?: "triage" | "question" | "unexpected";
  },
): string {
  const dispatchId = newId();
  log.add("dispatch.started", {
    dispatchId,
    name: o.name,
    role: (o.role ?? "worker") as never,
    unit: o.unit,
    lane: o.lane === undefined ? o.unit : o.lane,
    rung: o.rung ?? "codex:gpt-6-sol#medium",
    thread: o.thread ?? null,
    ...(o.judgeKind ? { judgeKind: o.judgeKind } : {}),
  });
  return dispatchId;
}

export function endDispatch(
  log: Log,
  dispatchId: string,
  o: {
    name: string;
    unit: string;
    status?: "ok" | "failed" | "limit" | "timeout" | "cancelled" | "cli-too-old";
    replyStatus?: "complete" | "partial" | "blocked" | "refused" | "flaky" | null;
    thread?: string | null;
    verdict?: "pass" | "fail" | "blocked" | null;
    findings?: { label: "BLOCKER" | "BUG" | "NIT"; text: string; file: string | null }[];
    why?: string;
    environment?: string | null;
    reason?: BlockedReason | null;
    head?: string | null;
    foreign?: string[];
    at?: string;
  },
) {
  return log.add(
    "dispatch.ended",
    {
      dispatchId,
      name: o.name,
      unit: o.unit,
      status: o.status ?? "ok",
      replyStatus: o.replyStatus === undefined ? "complete" : o.replyStatus,
      reason: o.reason ?? null,
      why: o.why ?? "done",
      thread: o.thread === undefined ? "t-1" : o.thread,
      head: o.head ?? null,
      environment: o.environment ?? null,
      verdict: o.verdict ?? null,
      findings: o.findings ?? [],
      foreign: o.foreign ?? [],
      replyPath: `roles/${o.name}/${dispatchId}/reply.md`,
    },
    o.at,
  );
}

/** A run that has its plan, routed M1 and passed its preflight: M1's lanes wait to be dispatched. */
/** `start` is the whole `run.started` payload, or just the run's base branch. */
export function runningLog(
  plan: MilestonePlan[] = PLAN,
  start: Fields<"run.started"> | string | null = null,
): Log {
  const log = makeLog();
  log.add(
    "run.started",
    typeof start === "object" && start !== null ? start : { ...startedFields, base: start },
  );
  log.add("plan.ready", { milestones: plan });
  routeMilestone(log, plan[0] as MilestonePlan);
  return log;
}

export function routeMilestone(log: Log, mp: MilestonePlan, rung = "codex:gpt-6-sol#medium"): void {
  log.add("lanes.routed", {
    milestone: mp.id,
    lanes: mp.lanes.map((l) => ({ lane: l.id, rung, ladder: [rung, "codex:gpt-6-sol#high"] })),
  });
  log.add("preflight.done", { milestone: mp.id, blocking: [], confirm: null });
}

/** Runs one lane dispatch to a passing fast check. */
export function finishLane(log: Log, lane: string, o: { thread?: string; role?: string } = {}): void {
  const name = `${o.role ?? "worker"}-${lane}`;
  const id = startDispatch(log, { name, role: o.role ?? "worker", unit: lane });
  endDispatch(log, id, { name, unit: lane, thread: o.thread ?? `t-${lane}` });
  log.add("check.ran", { lane, exit: 0, tail: "", foreign: [] });
}
