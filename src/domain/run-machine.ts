import type { NotifyMoment } from "./profile.ts";
import type { Role } from "./roles.ts";
import { ACTION_TYPES, type ReportKind, RUN_UNIT, type RunEvent } from "./run-events.ts";
import { MAX_TRIES, remindDue, type RunState } from "./run-state.ts";

/** `wake` is an architect turn, `task` a task the architect (or a worker, for a standing role) delegated */
export type BriefKind = "wake" | "task";

export type RemindAction = { type: "remind"; unit: string; n: number };

export type DispatchAction = {
  type: "dispatch";
  unit: string;
  name: string;
  role: Role;
  lane: string | null;
  /** null for an architect turn: the effect takes the profile's architect rung */
  rung: string | null;
  thread: string | null;
  failoverFrom: string | null;
  brief: BriefKind;
  notes: string[];
  /** plan 47: an architect turn's digest covers the events up to this seq */
  upTo?: number;
};

/**
 * Spec D4: what the reducer asks the daemon to do. Run a dispatch the architect asked for (or its next turn), watch
 * one, cancel, run a check, post a report or a notice, remind the owner, end the run.
 */
export type Action =
  | RemindAction
  | DispatchAction
  | { type: "watch"; dispatchId: string }
  | { type: "cancel"; dispatchIds: string[] }
  | { type: "report"; kind: ReportKind; unit: string; text: string }
  | { type: "notify"; unit: string; moment: NotifyMoment }
  | {
      type: "finish";
      outcome: "done" | "cancelled" | "failed";
      /** a finish that failed MAX_TRIES times: the run ends with no report */
      bare?: true;
    }
  | { type: "runCheck"; checkId: string }
  | { type: "land"; landId: string };

// every action type is one `effect.failed` can name, and the other way round
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const ACTIONS_MATCH_EVENTS: Same<Action["type"], (typeof ACTION_TYPES)[number]> = true;

/** The key an issued action is remembered by until an event confirms it; the daemon never issues one twice. */
export function actionKey(a: Action): string {
  switch (a.type) {
    case "dispatch":
      return `dispatch:${a.name}`;
    case "watch":
      return `watch:${a.dispatchId}`;
    case "remind":
      return `remind:${a.unit}:${a.n}`;
    case "cancel":
      return "cancel:run";
    case "report":
      return `report:${a.kind}:${a.unit}`;
    case "notify":
      return `notify:${a.unit}:${a.moment}`;
    case "finish":
      return "finish:run";
    case "runCheck":
      return `runCheck:${a.checkId}`;
    case "land":
      return `land:${a.landId}`;
  }
}

/** The unit an action works on: what `effect.failed` names it by. */
export function unitOf(a: Action, s?: RunState): string {
  switch (a.type) {
    case "dispatch":
    case "report":
    case "notify":
    case "remind":
      return a.unit;
    case "watch":
      return s?.dispatches[a.dispatchId]?.unit ?? RUN_UNIT;
    case "cancel":
    case "finish":
      return RUN_UNIT;
    case "runCheck":
      return a.checkId;
    case "land":
      return a.landId;
  }
}

/** What `effect.failed` carries to name an action: its type and unit. The daemon frees the matching key. */
export const failKey = (a: Action, s?: RunState): string => `${a.type}@${unitOf(a, s)}`;

/** The keys an event settles: what the daemon forgets, so a still-ready action may be issued again. */
export function confirms(e: RunEvent): string[] {
  switch (e.type) {
    case "dispatch.started":
    case "dispatch.refused":
      return [`dispatch:${e.name}`];
    case "dispatch.ended":
      return [`watch:${e.dispatchId}`, "cancel:run"];
    case "question.reminded":
      return [`remind:${e.unit}:${e.n}`];
    case "run.ended":
      return ["finish:run", "cancel:run"];
    case "report.posted":
      return [`report:${e.kind}:${e.unit}`];
    case "effect.failed":
      return [`${e.action}@${e.unit}`];
    case "check.done":
      return [`runCheck:${e.checkId}`];
    case "land.done":
      return [`land:${e.landId}`];
    default:
      return [];
  }
}

/** The reminders, reports and notices still owed: a park's, until their `report.posted`. */
export function owedActions(s: RunState): Action[] {
  const reminders: RemindAction[] =
    s.phase === "ended"
      ? []
      : Object.values(s.questions)
          .filter((q) => remindDue(q) <= s.at)
          .map((q) => ({ type: "remind", unit: q.unit, n: (q.reminded ?? 0) + 1 }));
  return [
    ...reminders,
    ...Object.values(s.owed)
      .filter((o) => (s.failedEffects[`report@${o.unit}`] ?? 0) < MAX_TRIES)
      .flatMap((o): Action[] => [
        { type: "report", kind: o.kind, unit: o.unit, text: o.text },
        ...(o.moment !== null ? [{ type: "notify" as const, unit: o.unit, moment: o.moment }] : []),
      ]),
  ];
}
