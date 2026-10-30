import {
  type ArchState,
  architectName,
  isStanding,
  rungHeld,
  STANDING_CAP,
  unheldRung,
  WRITER_CAP,
} from "./architect-state.ts";
import { RUN_UNIT, type RunEvent } from "./run-events.ts";
import { type Action, type DispatchAction, owedActions } from "./run-machine.ts";
import { liveDispatches, MAX_TRIES, type RunState } from "./run-state.ts";

/** Spec D10's verdicts as the run's outcome: only `done` is done. */
const OUTCOME = { done: "done", impossible: "failed", stopped: "failed" } as const;

const failed = (s: RunState, action: "cancel" | "finish"): boolean =>
  (s.failedEffects[`${action}@${RUN_UNIT}`] ?? 0) >= MAX_TRIES;

/**
 * The architect's next turn on `rung`: its thread resumed unless `fresh` says why not or the rung moved (a thread
 * does not carry across backends), the digest up to the last item.
 */
function wake(a: ArchState, s: RunState, rung: string | null): DispatchAction {
  const moved = rung !== a.rung && a.rung !== null;
  // only a rung whose quota is held now is "held": a lapsed hold sends the architect back to its default
  const why =
    a.fresh ??
    (moved && a.rung !== null
      ? rungHeld(a.rung, s)
        ? `the quota of ${a.rung} is held: this turn runs on ${rung}`
        : rung === s.architectRungs[0]
          ? `back on the default rung ${rung}`
          : `the architect's rung moved to ${rung}`
      : null);
  return {
    type: "dispatch",
    unit: RUN_UNIT,
    name: architectName(a.turns + 1),
    role: "architect",
    lane: null,
    rung,
    thread: why === null ? a.thread : null,
    failoverFrom: null,
    brief: "wake",
    notes: why === null ? [] : [why],

    upTo: a.inbox.at(-1)?.seq ?? 0,
  };
}

/**
 * Spec D4, the architect engine's machine: run what the architect asked for and wake it when something happened.
 * It decides nothing else. Level-triggered like `next`: the daemon drops what it issued already.
 */
export function architectNext(s: RunState, e: RunEvent): Action[] {
  const a = s.arch;
  if (s.earlier || s.phase === "ended") return [];
  const live = liveDispatches(s);
  const out: Action[] = [
    ...(e.type === "daemon.started"
      ? live.map((d) => ({ type: "watch" as const, dispatchId: d.dispatchId }))
      : []),
    ...owedActions(s),
  ];
  const finish = (outcome: "done" | "cancelled" | "failed", bare = failed(s, "finish")): Action =>
    bare ? { type: "finish", outcome, bare: true } : { type: "finish", outcome };
  if (s.cancelling)
    return [
      ...out,
      ...(live.length && !failed(s, "cancel")
        ? [{ type: "cancel" as const, dispatchIds: live.map((d) => d.dispatchId) }]
        : // a cancel that gave up must not leave the run cancelling: finish without the stop
          [finish("cancelled", live.length > 0 || failed(s, "finish"))]),
    ];
  if (a.finishing) {
    // the architect's own turn ends by itself; every task it left running is stopped
    const tasks = live.filter((d) => d.role !== "architect");
    return [
      ...out,
      ...(tasks.length && !failed(s, "cancel")
        ? [{ type: "cancel" as const, dispatchIds: tasks.map((d) => d.dispatchId) }]
        : // a cancel that gave up must not leave the run unfinished: finish without the stop
          [finish(OUTCOME[a.finishing.verdict], tasks.length > 0 || failed(s, "finish"))]),
    ];
  }
  const strays = live.filter((d) => a.tasks[d.name]?.state === "cancelled");
  if (strays.length) out.push({ type: "cancel", dispatchIds: strays.map((d) => d.dispatchId) });
  // plan 53: a full check is proof of the tree as it stands, so it waits for catherd's own fast checks and (plan 55)
  // the merges asked for to come in
  const queuedMerges = Object.values(a.merges).filter((m) => m.state === "queued");
  const pending =
    queuedMerges.length > 0 || Object.values(a.checks).some((c) => c.task && c.state === "queued");
  for (const c of Object.values(a.checks))
    if (c.state === "queued" && !(pending && c.scope === "full"))
      out.push({ type: "runCheck", checkId: c.checkId });
  // spec D5: merges into the run's branch go one at a time, in the order they were asked for
  const merge = queuedMerges[0];
  if (merge) out.push({ type: "merge", mergeId: merge.mergeId });
  for (const l of Object.values(a.lands))
    if (l.state === "queued") out.push({ type: "land", landId: l.landId });
  if (s.paused !== null || s.held !== null) return out;
  const running = Object.values(a.tasks).filter((t) => t.state === "working");
  let standing = running.filter((t) => isStanding(t.role)).length;
  let writers = running.length - standing;
  // spec D10: past the wall cap no new task starts; the architect is still woken to finish
  for (const t of a.wall === "capped" ? [] : Object.values(a.tasks)) {
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
    });
  }
  // plan 52: a turn that ended on a quota limit climbs to a rung on a free quota; with every rung held it waits for
  // the hold (recomputeWake ticks when it lapses). A run an earlier build started waits on its last rung.
  const ladder = s.architectRungs.length ? s.architectRungs : a.rung === null ? [] : [a.rung];
  const rung = ladder.length ? unheldRung(ladder, ladder[0] as string, s) : null;
  const held = ladder.length > 0 && rung === null;
  if (a.turn === null && !held && a.inbox.some((i) => i.wakes))
    out.push(wake(a, s, s.architectRungs.length ? rung : a.rung));
  return out;
}
