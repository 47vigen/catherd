import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { errorMessage, isCatherdError } from "../domain/errors.ts";
import { parseBlockedReason } from "../domain/blocked.ts";
import { quotaOf } from "../domain/failover.ts";
import { parseFailLines, parseFindings, unlistedFail } from "../domain/findings.ts";
import { headlessRung, tryParseRung } from "../domain/ids.ts";
import { parseRanLines, parseRunLines, verifierShortfall } from "../domain/ran-lines.ts";
import type { RunRecord } from "../domain/record.ts";
import type { Role } from "../domain/roles.ts";
import { RUN_UNIT, type RunEventInput } from "../domain/run-events.ts";
import { type Action, type DispatchAction, unitOf } from "../domain/run-machine.ts";
import { rungHeld, taskAttempts } from "../domain/architect-state.ts";
import type { RunState } from "../domain/run-state.ts";
import { endCollect, requestCancel, tryCollect } from "../infra/dispatch-dir.ts";
import type { LockWait } from "../infra/heavy-lock.ts";
import { backupDb } from "../infra/db.ts";
import { log } from "../infra/log.ts";
import { admit } from "./admission.ts";
import { cancel, launcher } from "./dispatch-service.ts";
import { type Dispatch, listDispatches } from "./dispatches.ts";
import { finalizeDispatch, waitForFinish } from "./finalize.ts";
import { blockedByEnvironment, replyVerdict } from "./verifier-reply.ts";
import { sendRunNotice } from "./notify-service.ts";
import type { Deps } from "./ports.ts";
import { runArchitectCheck } from "./architect-check.ts";
import { runLand } from "./land.ts";
import { claimRunTree } from "./run-tree.ts";
import { writeArchitectReport } from "./architect-run.ts";
import { renderLedger } from "./ledger-store.ts";
import { renderBrief } from "./run-briefs.ts";
import { appendEvent, readEvents, replayRun, withEventsLock } from "./run-events-store.ts";
import { runProfile } from "./run-pin.ts";
import { readRecords, type Run } from "./run-store.ts";
import { refreshState } from "./state.ts";
import { teamLast } from "./team.ts";

/**
 * What carries the reducer's actions out. `run` appends the events the action produces (a long one when it is
 * done); a failure becomes an `effect.failed` event, and it throws only when that event cannot be written.
 */
export interface Effects {
  run(a: Action, state: RunState): Promise<void>;
}

/** Limits a test shortens. */
export const effectLimits = { checkMs: 600_000 };

const read = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

const FIRST_LINE = /^VERDICT:\s*FAIL\b/i;
const PASS_LINE = /^VERDICT: PASS\b/;

/**
 * The `dispatch.ended` event of a finished dispatch: the record's status, the reply's findings (a reviewer's
 * BLOCKER, BUG and NIT lines, a failing verifier's lines) and the verifier's verdict, the reason a blocked reply
 * names, and the HEAD a verifier checked.
 */
export function endedEvent(run: Run, record: RunRecord, unit: string): RunEventInput {
  const reply = record.replyPath ? read(join(run.dir, record.replyPath)) : "";
  let verdict: "pass" | "fail" | "blocked" | null = null;
  let probe: string | null = null;
  let noVerdict = false;
  let shortfall: string[] = [];
  let findings = record.role === "reviewer" ? parseFindings(reply) : [];
  if (record.role === "verifier") {
    const first = replyVerdict(run, record) ?? "";
    probe = blockedByEnvironment(first);
    if (probe !== null) verdict = "blocked";
    else if (PASS_LINE.test(first)) {
      shortfall = ranShortfall(run, record, reply);
      verdict = shortfall.length ? "fail" : "pass";
      findings = shortfall.length ? [] : parseFindings(reply).filter((f) => f.label === "NIT");
    }
    // a reply with no readable verdict is not a pass
    else if (record.status === "ok") {
      verdict = "fail";
      noVerdict = !FIRST_LINE.test(first);
    }
    if (shortfall.length)
      findings = shortfall.map((text) => ({ label: "BLOCKER" as const, text, file: null }));
    else if (verdict === "fail") {
      findings = parseFailLines(reply);
      if (findings.length === 0)
        findings = FIRST_LINE.test(first)
          ? [unlistedFail(reply)]
          : [{ label: "BLOCKER", text: `no VERDICT line: ${first || "empty reply"}`, file: null }];
    }
  }
  const stopped = record.replyStatus === "blocked" || record.replyStatus === "refused";
  const reason = stopped ? (parseBlockedReason(record.replyWhy)?.reason ?? null) : null;
  return {
    type: "dispatch.ended",
    dispatchId: record.dispatchId,
    name: record.name,
    unit,
    status: record.status,
    replyStatus: record.replyStatus,
    reason,
    why: record.replyWhy ?? record.error?.message ?? "",
    thread: record.thread,
    head: record.head ?? null,
    environment: record.environment ?? (probe ? probe : null),
    verdict,
    findings,
    replyPath: record.replyPath,
    ...(noVerdict ? { noVerdict: true as const } : {}),
    ...(record.error?.code === "E_LOST" || record.error?.code === "E_BACKEND_MISSING"
      ? { lost: true as const }
      : {}),
  };
}

/** The line a verifier's PASS gets when it ran nothing (plan 50, spec D8). */
export const NO_COMMAND_RUN = "FAIL the verdict ran no command: no RAN: line with exit 0";

/**
 * Plan 44 D8: the RUN commands of the dispatch's brief that the reply's RAN lines do not show run, clean and logged.
 * Plan 50, spec D8: a PASS with no RAN line that exited 0 is not a PASS.
 */
function ranShortfall(run: Run, record: RunRecord, reply: string): string[] {
  const brief = record.replyPath ? read(join(run.dir, dirname(record.replyPath), "brief.md")) : "";
  const required = parseRunLines(brief);
  if (!parseRanLines(reply).some((r) => r.exit === 0)) return [NO_COMMAND_RUN];
  if (required.length === 0) return [];
  const logOk = (path: string): boolean => {
    try {
      return statSync(isAbsolute(path) ? path : join(run.meta.repo, path)).size > 0;
    } catch {
      return false;
    }
  };
  return verifierShortfall(required, parseRanLines(reply), logOk);
}

const outcomeNext = (outcome: "done" | "cancelled" | "failed"): string =>
  `the run ${outcome === "done" ? "finished" : outcome}; read report.md for what it did and what remains`;

/** The effects that carry a run's actions out through the existing services. */
export function realEffects(deps: Deps, run: Run): Effects {
  const at = (): Date => new Date(deps.now());
  const append = (e: RunEventInput) => appendEvent(run, e, at());
  /** A step's first lock wait, as one `lock.waiting` event; the event is written while the wait goes on. */
  const waitingOnce = (unit: string): ((w: LockWait | null) => void) => {
    let told = false;
    return (w) => {
      if (!w || told) return;
      told = true;
      append({
        type: "lock.waiting",
        unit,
        lock: w.lock,
        holder: w.holder,
        ahead: w.ahead,
      }).catch((e) => log("warn", "daemon", { run: run.id, unit, error: errorMessage(e) }));
    };
  };
  const watching = new Set<string>();

  const heldQuotas = (s: RunState): string[] =>
    Object.entries(s.holds)
      .filter(([, until]) => until > s.at)
      .map(([q]) => q);

  /** Waits for a dispatch to end, then appends `dispatch.ended`. */
  async function settle(d: Dispatch, unit: string): Promise<void> {
    const id = d.admit.dispatchId;
    if (watching.has(id)) return;
    watching.add(id);
    try {
      await waitForFinish(d, { pollMs: deps.pollMs, now: deps.now });
      const record = await finalizeDispatch(run, d);
      // under the lock: a settle of an earlier daemon in this process may still be running, and the second is a no-op
      const ended = await withEventsLock(run, (add) => {
        if (replayRun(run).dispatches[id]?.ended) return false;
        add(endedEvent(run, record, unit), at());
        return true;
      });
      if (!ended) return;
      // catherd announces nothing about a role of a daemon run: the run's reports do
      if (await tryCollect(d.dir)) endCollect(d.dir);
    } finally {
      watching.delete(id);
    }
  }

  /** An admitted dispatch of `name` that the log never heard of. */
  const orphanOf = (name: string, s: RunState): Dispatch | undefined =>
    listDispatches(run).find((d) => d.admit.name === name && !s.dispatches[d.admit.dispatchId]);

  async function start(
    a: {
      unit: string;
      name: string;
      role: Role;
      lane: string | null;
      rung: string | null;
      thread: string | null;
      failoverFrom: string | null;
      upTo?: number;
    },
    // the brief as it is now: a resumed thread gets its `<this-round>` only (plan 44 R3)
    render: (resumed: boolean) => Promise<string>,
    s: RunState,
  ): Promise<void> {
    const refuse = (code: string, message: string, rung?: string) =>
      append({
        type: "dispatch.refused",
        name: a.name,
        unit: a.unit,
        code,
        message,
        ...(rung ? { rung } : {}),
      });
    // the daemon died between its admission and its event: the dispatch is recorded and watched, never launched twice
    const adopt = async (found: Dispatch): Promise<void> => {
      await append({
        type: "dispatch.started",
        dispatchId: found.admit.dispatchId,
        name: a.name,
        role: a.role,
        unit: a.unit,
        lane: a.lane,
        rung: found.admit.rung,
        thread: found.admit.thread,
      });
      await settle(found, a.unit);
    };
    const orphan = orphanOf(a.name, s);
    if (orphan) return adopt(orphan);
    const rung = a.rung;
    if (!rung) return void (await refuse("E_ADMIT_RUNG", `no rung was given for ${a.name}`));
    // read before rendering: a message sent while it renders is delivered next time, never skipped
    const teamSeen = teamLast(run);
    const full = await render(false);
    const parsed = tryParseRung(rung);
    if (parsed !== null && heldQuotas(s).includes(quotaOf(parsed)))
      return void (await refuse("E_RUNG_HELD", `the quota of ${rung} is held`));
    const resumed = a.thread === null ? full : await render(true);
    let admitted: Awaited<ReturnType<typeof admit>>;
    try {
      admitted = await admit(deps, run, {
        role: a.role,
        name: a.name,
        brief: resumed,
        composed: true,
        ...(a.thread === null ? {} : { fullBrief: full }),
        rung: headlessRung(rung),
        thread: a.thread,
        lane: a.lane,
        failoverFrom: a.failoverFrom,
      });
    } catch (e) {
      if (!isCatherdError(e)) throw e;
      if (e.code === "E_ADMIT_DUPLICATE") {
        const orphan = orphanOf(a.name, s);
        if (orphan) return await adopt(orphan);
      }
      return void (await refuse(e.code, e.message, e.code === "E_ADMIT_RUNG" ? rung : undefined));
    }
    const { d, specPath } = admitted;
    // a cancel that landed while this start was in flight: the role must not start after the run is cancelled
    const now = replayRun(run);
    const taskCancelled = now.arch.tasks[a.name]?.state === "cancelled";
    if (now.cancelling || now.phase === "ended" || taskCancelled) {
      requestCancel(d.dir);
      await finalizeDispatch(run, d);
      if (await tryCollect(d.dir)) endCollect(d.dir);
      return void (await refuse(
        "E_RUN_CANCELLED",
        taskCancelled
          ? "the task was cancelled before it started"
          : "the run was cancelled before the role started",
      ));
    }
    try {
      launcher.launch(d, specPath);
    } catch (e) {
      // watched all the same: a dispatch that never started is recorded as lost once its start grace passes
      log("warn", "daemon", { run: run.id, name: a.name, launch: errorMessage(e) });
    }
    await append({
      type: "dispatch.started",
      dispatchId: d.admit.dispatchId,
      name: a.name,
      role: a.role,
      unit: a.unit,
      lane: a.lane,
      rung: d.admit.rung,
      thread: a.thread,
      ...(teamSeen === undefined ? {} : { teamSeen }),
      ...(a.upTo === undefined ? {} : { upTo: a.upTo }),
    });
    await settle(d, a.unit);
  }

  /**
   * An architect turn (spec D1, plan 47 R7): the machine's rung when it climbed to a free one of the ladder (plan 52), else the profile's;
   * a fresh thread when it is spent or the rung moved.
   */
  async function wake(a: DispatchAction, s: RunState): Promise<void> {
    const rc = runProfile(deps, run).roles.architect;
    const want = rc?.defaultRung ?? rc?.rungs[0];
    if (!want) throw new Error("the profile's architect has no rung");
    // the machine's rung when it climbed off the run's pinned default, or when the profile's new default is held;
    // else a profile edit mid-run still counts
    const climbed = a.rung !== null && s.architectRungs.length > 0 && a.rung !== s.architectRungs[0];
    const rung = headlessRung(climbed || (a.rung !== null && rungHeld(want, s)) ? (a.rung as string) : want);
    const last = readRecords(run)
      .records.filter((r) => r.role === "architect")
      .at(-1);
    const why = [
      ...a.notes,
      ...(a.thread !== null && last?.threadHeavy ? ["your last thread is spent"] : []),
      ...(a.thread !== null && last && headlessRung(last.rung) !== rung
        ? ["the architect's rung changed"]
        : []),
    ];
    const thread = why.length > a.notes.length ? null : a.thread;
    const turn: DispatchAction = { ...a, rung, thread, notes: why };
    renderLedger(run, taskAttempts(s.arch));
    return start(turn, (resumed) => renderBrief(run, s, turn, resumed), s);
  }

  async function perform(a: Action, s: RunState): Promise<void> {
    // spec D5, stage 1: a base run works in its own tree, made before the first thing that needs it
    if (run.meta.base && (a.type === "dispatch" || a.type === "runCheck" || a.type === "land"))
      await claimRunTree(deps, run);
    switch (a.type) {
      case "dispatch":
        if (a.brief === "wake") return wake(a, s);
        return start(a, (resumed) => renderBrief(run, s, a, resumed), s);
      case "runCheck": {
        const c = s.arch.checks[a.checkId];
        if (!c) throw new Error(`no check ${a.checkId} was asked for`);
        return void (await append(
          await runArchitectCheck(deps, run, c, {
            timeoutMs: effectLimits.checkMs,
            onWait: waitingOnce(a.checkId),
          }),
        ));
      }
      case "land": {
        const l = s.arch.lands[a.landId];
        if (!l) throw new Error(`no land ${a.landId} was asked for`);
        const r = await runLand(run, l);
        await append(r.done);
        if (r.question)
          await append({
            type: "question.parked",
            unit: RUN_UNIT,
            question: r.question,
            reason: "land",
            why: l.why,
          });
        return;
      }
      case "watch": {
        const v = s.dispatches[a.dispatchId];
        if (!v || v.ended) return;
        const d = listDispatches(run).find((x) => x.admit.dispatchId === a.dispatchId);
        if (!d) throw new Error(`dispatch ${a.dispatchId} has no folder`);
        return settle(d, v.unit);
      }
      case "cancel": {
        for (const id of a.dispatchIds) {
          const d = listDispatches(run).find((x) => x.admit.dispatchId === id);
          if (!d) continue;
          try {
            await cancel(deps, run.id, d.admit.name);
          } catch (e) {
            if (!(isCatherdError(e) && e.code === "E_RUN_NOT_LIVE")) throw e;
          }
        }
        return;
      }
      case "report":
        return void (await append({ type: "report.posted", kind: a.kind, unit: a.unit, text: a.text }));
      case "notify":
        // the phone; the session hears the run's reports through its notifier
        await sendRunNotice(deps, run, { unit: a.unit, moment: a.moment });
        return;
      case "remind": {
        // The action's snapshot binds it to the parked event, even if a replacement has identical text/time.
        const pending = (): boolean => {
          const current = replayRun(run);
          const question = current.questions[a.unit];
          return (
            current.phase !== "ended" &&
            !!s.questions[a.unit] &&
            !!question &&
            question.reminded < a.n &&
            !readEvents(run, s.seq + 1).some(
              (e) => (e.type === "question.parked" || e.type === "question.answered") && e.unit === a.unit,
            )
          );
        };
        if (!pending()) return;
        await sendRunNotice(deps, run, { unit: a.unit, moment: "blocked" });
        // Answer/replacement and the reminder append cannot interleave after this identity check.
        await withEventsLock(run, (add) => {
          if (pending()) add({ type: "question.reminded", unit: a.unit, n: a.n }, at());
        });
        return;
      }
      case "finish": {
        const reportPath = a.bare ? null : writeArchitectReport(run, s, readEvents(run));
        await append({ type: "run.ended", outcome: a.outcome, reportPath });
        await refreshState(run, { next: outcomeNext(a.outcome), parked: [] });
        try {
          backupDb();
        } catch (e) {
          log("warn", "backup", { run: run.id, error: errorMessage(e) });
        }
        return;
      }
    }
  }

  return {
    async run(a, s) {
      try {
        await perform(a, s);
      } catch (e) {
        log("warn", "daemon", { run: run.id, action: a.type, error: errorMessage(e) });
        try {
          await append({
            type: "effect.failed",
            action: a.type,
            unit: unitOf(a, s),
            message: errorMessage(e),
          });
        } catch (inner) {
          log("error", "daemon", { run: run.id, action: a.type, lost: errorMessage(inner) });
          // no event frees the action's key: the daemon must hear of it, stop, and let a new one replay
          throw inner;
        }
      }
    },
  };
}
