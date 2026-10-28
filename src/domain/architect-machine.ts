import { type ArchState, architectName, isStanding, STANDING_CAP, WRITER_CAP } from "./architect-state.ts";
import { RUN_UNIT, type RunEvent } from "./run-events.ts";
import { type Action, type DispatchAction, owedActions } from "./run-machine.ts";
import { liveDispatches, type RunState } from "./run-state.ts";

/** Spec D10's verdicts as the run's outcome: only `done` is done. */
const OUTCOME = { done: "done", impossible: "failed", stopped: "failed" } as const;

/** The architect's next turn: its thread resumed unless `fresh` says why not, the digest up to the last item. */
function wake(a: ArchState): DispatchAction {
  return {
    type: "dispatch",
    unit: RUN_UNIT,
    name: architectName(a.turns + 1),
    role: "architect",
    lane: null,
    rung: a.rung,
    thread: a.fresh === null ? a.thread : null,
    failoverFrom: null,
    brief: "wake",
    notes: a.fresh === null ? [] : [a.fresh],
    decision: null,
    upTo: a.inbox.at(-1)?.seq ?? 0,
  };
}

/**
 * Spec D4, the architect engine's machine: run what the architect asked for and wake it when something happened.
 * It decides nothing else. Level-triggered like `next`: the daemon drops what it issued already.
 */
export function architectNext(s: RunState, e: RunEvent): Action[] {
  const a = s.arch;
  if (!a || s.phase === "ended") return [];
  const live = liveDispatches(s);
  const out: Action[] = [
    ...(e.type === "daemon.started"
      ? live.map((d) => ({ type: "watch" as const, dispatchId: d.dispatchId }))
      : []),
    ...owedActions(s),
  ];
  if (s.cancelling)
    return [
      ...out,
      live.length
        ? { type: "cancel", dispatchIds: live.map((d) => d.dispatchId) }
        : { type: "finish", outcome: "cancelled" },
    ];
  if (a.finishing) {
    // the architect's own turn ends by itself; every task it left running is stopped
    const tasks = live.filter((d) => d.role !== "architect");
    return [
      ...out,
      tasks.length
        ? { type: "cancel", dispatchIds: tasks.map((d) => d.dispatchId) }
        : { type: "finish", outcome: OUTCOME[a.finishing.verdict] },
    ];
  }
  const strays = live.filter((d) => a.tasks[d.name]?.state === "cancelled");
  if (strays.length) out.push({ type: "cancel", dispatchIds: strays.map((d) => d.dispatchId) });
  for (const c of Object.values(a.checks))
    if (c.state === "queued") out.push({ type: "runCheck", checkId: c.checkId });
  if (s.paused !== null) return out;
  const running = Object.values(a.tasks).filter((t) => t.state === "working");
  let standing = running.filter((t) => isStanding(t.role)).length;
  let writers = running.length - standing;
  for (const t of Object.values(a.tasks)) {
    if (t.state !== "queued") continue;
    if (isStanding(t.role) ? standing >= STANDING_CAP : writers >= WRITER_CAP) continue;
    if (isStanding(t.role)) standing += 1;
    else writers += 1;
    out.push({
      type: "dispatch",
      unit: t.taskId,
      name: t.taskId,
      role: t.role,
      lane: null,
      rung: t.rung,
      thread: t.thread,
      failoverFrom: null,
      brief: "task",
      notes: [],
      decision: null,
    });
  }
  if (a.turn === null && a.inbox.some((i) => i.wakes)) out.push(wake(a));
  return out;
}
