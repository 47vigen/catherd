import type { HostContext, HostSessionRef, KnownHost } from "../domain/host.ts";
import { assertId } from "../domain/ids.ts";
import { noticeHeader } from "../domain/notice.ts";
import { knownQueueCapability, type QueueCapability } from "../infra/codex-queue.ts";
import type { DeliveryState } from "../infra/delivery.ts";
import { inspectionHost, inspectDelivery, inspectDeliveries, type DeliveryInspection } from "./run-debug.ts";
import { awaitsCollect } from "../infra/dispatch-dir.ts";
import { claim } from "./dispatch-service.ts";
import { type Dispatch, type DispatchState, listDispatches, liveDispatches } from "./dispatches.ts";
import { lastActivity } from "./finalize.ts";
import { finishedNotice } from "./notifier.ts";
import type { Deps } from "./ports.ts";
import { type Reentry, reentry } from "./reentry.ts";
import { findRun, listRuns, readAgentRuns, readRecords, type Run } from "./run-store.ts";
import { ownsRun, runOwner } from "./sessions.ts";
import { readNotes } from "./state.ts";

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

/** Spec 1.1 §8/§10: the open owner questions come first, then the run, its protocol step and the verifier's step. */
export interface PeekRun extends Reentry {
  run: string;
  title: string;
  /** the session that owns the run now, null when none has */
  owner: string | null;
  ownerHost: KnownHost | null;
  live: PeekRole[];
  /** Stalled notices are separate from unread finished role results. */
  delivery: (DeliveryInspection & { name: string; dispatchId: string })[];
  /** each finished record not yet read, as the first line of its message */
  unread: {
    name: string;
    dispatchId: string;
    header: string;
    eventId: string;
    delivery: Exclude<DeliveryState, "collected">;
    receipt: { msgId: string; target: HostSessionRef; at: string } | null;
  }[];
  /** the latest native Claude run recorded with record_agent_run */
  native: { name: string; role: string; rung: string; status: string; at: string } | null;
  /** the run's next step (state.md's last line) */
  next: string;
  /** plan 22, goal mode: whether anything in this run is the coordinator's to do now, and why (not) */
  actionable: boolean;
  reason: string;
}

/**
 * Plan 22, goal mode: whether the run holds anything for the coordinator. An unread record is its to read; with
 * roles live, a protocol step one of them is doing (lanes running, the reviewer or verifier step with that role
 * live, the plan while an architect or researcher runs) or the owner's question is nobody's to act on, so the
 * coordinator ends its turn with no tool call and the next catherd message wakes it.
 */
export function actionability(
  live: { name: string; role: string }[],
  unread: { name: string }[],
  protocolNext: string,
): { actionable: boolean; reason: string } {
  if (unread.length)
    return {
      actionable: true,
      reason: `unread: ${unread.map((u) => `result(run, "${u.name}")`).join(", ")}`,
    };
  if (protocolNext.endsWith(" parked: wait for the owner"))
    return {
      actionable: false,
      reason: `${protocolNext.replace(/: wait for the owner$/, "")}: the owner's answer comes first; end the turn with no tool call`,
    };
  const running = (role: string) => live.some((l) => l.role === role);
  const covered =
    /: lanes running \(/.test(protocolNext) ||
    (protocolNext.endsWith(": reviewer") && running("reviewer")) ||
    (protocolNext.endsWith(": verifier") && running("verifier")) ||
    (protocolNext.startsWith("plan:") && (running("architect") || running("researcher"))) ||
    (protocolNext.startsWith("finish:") && (running("verifier") || running("writer")));
  if (live.length && covered)
    return {
      actionable: false,
      reason: `only roles are live (${live.map((l) => l.name).join(", ")}): their results arrive as catherd messages; end the turn with no tool call`,
    };
  return { actionable: true, reason: protocolNext };
}

function peekRun(deps: Deps, run: Run, name: string | undefined): PeekRun {
  const now = deps.now();
  const mine = (d: Dispatch) => name === undefined || d.admit.name === name;
  const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
  const agents = readAgentRuns(run).filter((a) => name === undefined || a.name === name);
  const native = agents.at(-1);
  const notes = readNotes(run);
  const re = reentry(run, now, notes);
  const live = liveDispatches(run, now);
  // the whole run decides it, whatever `name` narrows the view to
  const act = actionability(
    live.map((d) => ({ name: d.admit.name, role: d.admit.role })),
    listDispatches(run).flatMap((d) =>
      records.has(d.admit.dispatchId) && awaitsCollect(d.dir) ? [{ name: d.admit.name }] : [],
    ),
    re.protocol.next,
  );
  return {
    questions: re.questions,
    run: run.id,
    title: run.meta.title,
    owner: runOwner(run)?.sessionId ?? null,
    ownerHost: runOwner(run)?.host ?? null,
    live: live.filter(mine).map((d) => ({
      name: d.admit.name,
      role: d.admit.role,
      rung: d.admit.rung,
      state: d.state,
      secs: Math.max(0, Math.round((now - Date.parse(d.admit.admittedAt)) / 1000)),
      lastEvent: lastActivity(d),
    })),
    delivery: listDispatches(run)
      .filter(mine)
      .flatMap((d) =>
        inspectDeliveries(run, d, false).map((inspection) => ({
          name: d.admit.name,
          dispatchId: d.admit.dispatchId,
          ...inspection,
        })),
      ),
    unread: listDispatches(run)
      .filter(mine)
      .flatMap((d) => {
        const r = records.get(d.admit.dispatchId);
        if (!r || !awaitsCollect(d.dir)) return [];
        const delivery = inspectDelivery(run, d, true);
        if (delivery.delivery === "collected") return [];
        return [
          {
            ...delivery,
            delivery: delivery.delivery,
            name: r.name,
            dispatchId: r.dispatchId,
            header: noticeHeader(finishedNotice(run, d, r)),
          },
        ];
      }),
    native: native
      ? { name: native.name, role: native.role, rung: native.rung, status: native.status, at: native.at }
      : null,
    next: notes.next,
    protocol: re.protocol,
    verifier: re.verifier,
    ...act,
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
): Promise<{
  /** plan 22, goal mode: false when no run holds anything for the coordinator; `reason` says why either way */
  actionable: boolean;
  reason: string;
  runs: PeekRun[];
  hints: string[];
  host: HostContext;
  queue: QueueCapability | null;
}> {
  if (i.name !== undefined) assertId("role name", i.name);
  let runs: Run[];
  if (i.run) {
    const run = findRun(i.run);
    // ownership now; what the run's earlier owner left is taken care of after the call returns
    await claim(deps, run, { background: true });
    runs = [run];
  } else {
    const all = listRuns().runs;
    const owned = all.filter((r) => ownsRun(deps, r));
    runs = owned.length ? owned : all.slice(0, 1);
  }
  const hints = runs.length === 0 ? ["no runs yet: run_start(repo, title, a_lines) starts one"] : [];
  const views = runs.map((r) => peekRun(deps, r, i.name));
  const doing = views.filter((v) => v.actionable);
  const shown = (vs: PeekRun[]) =>
    vs.map((v) => (views.length > 1 ? `${v.title}: ${v.reason}` : v.reason)).join("; ");
  return {
    actionable: views.length === 0 || doing.length > 0,
    reason: views.length === 0 ? "no runs yet" : shown(doing.length ? doing : views),
    runs: views,
    hints,
    host: inspectionHost(deps.host),
    queue: deps.host.host === "codex" && !deps.host.conflict ? knownQueueCapability(process.env) : null,
  };
}
