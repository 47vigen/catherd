import type { BlockedReason } from "../../src/domain/blocked.ts";
import { EVENTS_SCHEMA, type RunEvent, type RunEventType } from "../../src/domain/run-events.ts";
import { type RunState, replay } from "../../src/domain/run-state.ts";

type Fields<T extends RunEventType> = Omit<Extract<RunEvent, { type: T }>, "v" | "seq" | "at" | "type">;

export const START = "2026-10-21T10:00:00.000Z";

/** An event log in memory: each `add` gives the next seq and a time one second later (or `at`). */
export function makeLog(start = START, v: number = EVENTS_SCHEMA) {
  const events: RunEvent[] = [];
  let ms = Date.parse(start);
  const add = <T extends RunEventType>(
    type: T,
    fields: Fields<T>,
    at?: string,
  ): Extract<RunEvent, { type: T }> => {
    ms += 1000;
    const e = {
      v,
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

export const startedFields = {
  repo: "/repo",
  title: "wallet",
  aLines: ["A1 it works"],
  plan: [] as string[],
  base: null,
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
    upTo?: number;
  },
): string {
  const dispatchId = newId();
  log.add("dispatch.started", {
    dispatchId,
    name: o.name,
    role: (o.role ?? "worker") as never,
    unit: o.unit,
    lane: o.lane === undefined ? null : o.lane,
    rung: o.rung ?? "codex:gpt-6-sol#medium",
    thread: o.thread ?? null,
    ...(o.upTo === undefined ? {} : { upTo: o.upTo }),
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
      replyPath: `roles/${o.name}/${dispatchId}/reply.md`,
    },
    o.at,
  );
}
