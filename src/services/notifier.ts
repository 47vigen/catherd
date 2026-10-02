import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CatherdError, errorMessage } from "../domain/errors.ts";
import { envelope, formatNotices, type Notice, type NoticePriority, priorityOf } from "../domain/notice.ts";
import { sessionKey, type HostSessionRef } from "../domain/host.ts";
import { sendToCodexQueue, type QueueSendResult } from "../infra/codex-queue.ts";
import {
  deliveryState,
  readDelivery,
  ROLE_THREAD_REFUSAL,
  writeDeliveryAttempt,
  type DeliveryAttempt,
} from "../infra/delivery.ts";
import type { RunRecord } from "../domain/record.ts";
import { awaitsCollect, dispatchPaths } from "../infra/dispatch-dir.ts";
import { tryLock } from "../infra/filelock.ts";
import { log } from "../infra/log.ts";
import { type SendResult, sendToInbox } from "../infra/peer-inbox.ts";
import { writeJsonAtomic } from "../infra/store.ts";
import {
  readStallQuietMs,
  type Settled,
  settledHooks,
  type Stalled,
  stallHooks,
} from "./dispatch-service.ts";
import { type Dispatch, listDispatches, readFailover, roleThreadOf } from "./dispatches.ts";
import type { Deps } from "./ports.ts";
import { listRuns, readRecords, type Run } from "./run-store.ts";
import { currentSession, ownsRun, readSessionRows, runOwner } from "./sessions.ts";

export interface NotifierOptions {
  /** notices this close to each other go as one message (spec: 3 s); tests shorten it */
  coalesceMs?: number;
  sendCodex?: (target: HostSessionRef, content: string) => Promise<QueueSendResult>;
  /** the sender; tests may replace it */
  send?: (
    target: { socketPath: string | null; token: string | null },
    content: string,
    p: NoticePriority,
  ) => Promise<SendResult>;
}

export interface Notifier {
  /** the settled hook: queues the dispatch's notice when this session should hear of it */
  onSettled(s: Settled): void;
  /** the stall hook: queues a stalled role's notice, once per dispatch */
  onStall(s: Stalled): void;
  /** spec §3.4 "a scan on start": every unread, un-notified record of a run this session owns */
  scan(): Promise<void>;
  /** resolves once nothing is queued and no message is on its way */
  idle(): Promise<void>;
  /** removes the hook and drops what is queued */
  stop(): void;
}

function legacyNotified(q: Queued, target: HostSessionRef): boolean {
  if (target.host !== "claude-code") return false;
  try {
    const marker = JSON.parse(readFileSync(q.mark, "utf8")) as {
      schema?: unknown;
      at?: unknown;
      msgId?: unknown;
    };
    if (marker.schema !== 1 || typeof marker.at !== "string" || typeof marker.msgId !== "string")
      return false;
    const at = Date.parse(marker.at);
    if (!Number.isFinite(at)) return false;
    const historical = readSessionRows(q.run)
      .filter((row) => Date.parse(row.at) <= at)
      .at(-1);
    const owner = runOwner(q.run);
    const attributed = historical ?? (owner && Date.parse(owner.since) <= at ? owner : null);
    return attributed !== null && sessionKey(attributed) === sessionKey(target);
  } catch {
    return false;
  }
}

function recoverSubmission(dir: string, eventId: string): void {
  for (const a of readDelivery(dir)) {
    if (a.status === "submitting" && a.eventIds.includes(eventId))
      writeDeliveryAttempt(dir, {
        ...a,
        status: "ambiguous",
        reason: "Sender ended without a verified receipt; retry may duplicate input. Use peek/result.",
      });
  }
}

function replyOf(run: Run, r: RunRecord): string {
  try {
    return readFileSync(join(run.dir, r.replyPath), "utf8");
  } catch {
    return "";
  }
}

/** Spec §3.5/§3.6: one finished role's notice, with what failover did in place of a limit's status. */
export function finishedNotice(run: Run, d: Dispatch, r: RunRecord): Notice {
  const fo = readFailover(d.dir);
  let status: string = r.status;
  if (r.status === "limit") {
    const why = fo?.standIn
      ? `failed over to ${fo.standIn.rung}`
      : fo?.hints.some((h) => h.startsWith("failover: run "))
        ? "its stand-in is a Claude agent: result(run, name) has the hint"
        : fo?.hints.some((h) => h.startsWith("failover: "))
          ? "paused: the stand-in was refused"
          : "paused: no stand-in";
    status = `limit on ${r.rung}; ${why}`;
  }
  const urgent = r.status === "limit" || r.replyStatus === "blocked" || r.replyStatus === "refused";
  return {
    kind: "finished",
    eventId: JSON.stringify([run.id, r.dispatchId, "finished"]),
    runId: run.id,
    runTitle: run.meta.title,
    dispatchId: r.dispatchId,
    name: r.name,
    role: r.role,
    lane: r.lane,
    rung: r.rung,
    status,
    replyStatus: r.replyStatus,
    secs: r.secs,
    changedOwned: r.changedOwned.length,
    reply: replyOf(run, r),
    priority: urgent ? "next" : "later",
  };
}

/** Spec §3.6: a live role that went quiet, once, at `next`. */
export function stalledNotice(run: Run, d: Dispatch, quietMs: number, now: number): Notice {
  return {
    kind: "stalled",
    eventId: JSON.stringify([run.id, d.admit.dispatchId, "stalled"]),
    runId: run.id,
    runTitle: run.meta.title,
    dispatchId: d.admit.dispatchId,
    name: d.admit.name,
    role: d.admit.role,
    lane: d.admit.lane,
    rung: d.admit.rung,
    status: `stalled: no output for ${Math.max(1, Math.round(quietMs / 60_000))} min`,
    replyStatus: null,
    secs: Math.max(0, Math.round((now - Date.parse(d.admit.admittedAt)) / 1000)),
    changedOwned: 0,
    reply: "",
    priority: "next",
  };
}

interface Queued {
  /** its key in the queue */
  key: string;
  /** the run it is about: its owner may change before the message goes */
  run: Run;
  notice: Notice;
  dir: string;
  /** the mark a message that went out leaves */
  mark: string;
  /** whether it is still news when the message goes */
  due: () => boolean;
  /** how many passes could not write its delivery claim */
  claimFailures?: number;
  /** how many sends the transport provably did not submit */
  sendFailures?: number;
}

/** Passes a notice whose delivery claim cannot be written is kept for before it is given up (and logged). */
const MAX_CLAIM_FAILURES = 5;

/** Sends a notice the transport provably did not submit is tried, a coalescing window apart, before peek/result. */
const MAX_SEND_FAILURES = 5;

/** Starts the notifier for this process's session and hooks it to every settled dispatch. */
export function startNotifier(deps: Deps, o: NotifierOptions = {}): Notifier {
  return notifierFor(deps, o);
}

function notifierFor(deps: Deps, o: NotifierOptions, retryEvent?: string): Notifier {
  const window = o.coalesceMs ?? 3_000;
  const send = o.send ?? sendToInbox;
  const sendCodex = o.sendCodex ?? ((target, content) => sendToCodexQueue(target, content, process.env));
  const queue = new Map<string, Queued>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstAt = 0;
  let flight: Promise<void> = Promise.resolve();
  let stopped = false;

  /** This session's id, when there is one and it owns the run. */
  const owned = (run: Run): boolean => ownsRun(deps, run);

  const flush = (): void => {
    timer = null;
    const batch = [...queue.values()];
    queue.clear();
    // a delivery that throws (the notified.json write, say) is logged and never stops the ones after it
    flight = flight
      .then(() => deliver(batch))
      .catch((e: unknown) =>
        log("warn", "notify", { error: errorMessage(e), dispatches: batch.map((q) => q.notice.dispatchId) }),
      );
  };

  const schedule = (): void => {
    const now = Date.now();
    if (timer === null) firstAt = now;
    else clearTimeout(timer);
    // quiet for `window`, but never held past five windows: a steady trickle still goes out
    timer = setTimeout(flush, Math.max(0, Math.min(window, firstAt + 5 * window - now)));
  };

  const pending = (q: Queued, target: HostSessionRef): boolean => {
    if (!q.due() || legacyNotified(q, target)) return false;
    const state = deliveryState(q.dir, target, q.notice.eventId);
    return state === "pending" || (q.notice.eventId === retryEvent && state === "ambiguous");
  };

  async function deliver(batch: Queued[]): Promise<void> {
    const target = currentSession(deps);
    if (stopped || !target || (target.host === "claude-code" && !deps.session)) return;
    const claims: (() => void)[] = [];
    const due: Queued[] = [];
    const busy: Queued[] = [];
    try {
      for (const q of batch) {
        // one notice's damaged evidence drops that notice alone, never the rest of the batch
        try {
          if (!q.due() || !owned(q.run)) continue;
          const release = tryLock(q.mark);
          if (!release) {
            busy.push(q);
            continue;
          }
          claims.push(release);
          const live = currentSession(deps);
          if (stopped || !live || sessionKey(live) !== sessionKey(target) || !owned(q.run)) continue;
          recoverSubmission(q.dir, q.notice.eventId);
          if (pending(q, target)) due.push(q);
        } catch (e) {
          log("warn", "notify", { error: errorMessage(e), dispatch: q.notice.dispatchId });
        }
      }
      // spec 1.5 plan 21: a notice never goes to a role's own thread (a `codex exec` thread exits after its turn,
      // so what is queued there is lost). It fails loudly, and `status` says so, instead of enqueue-accepted.
      const roles = new Map(due.map((q) => [q, roleThreadOf(q.run, target.sessionId)]));
      for (const [q, role] of roles) {
        if (role === null) continue;
        due.splice(due.indexOf(q), 1);
        const reason = `${ROLE_THREAD_REFUSAL} (${role}, ${target.host} ${target.sessionId}), not the orchestrator's; peek(run) from the orchestrator's session takes the run back`;
        log("error", "notify", {
          run: q.run.id,
          dispatch: q.notice.dispatchId,
          target: target.sessionId,
          reason,
        });
        try {
          writeDeliveryAttempt(q.dir, {
            attemptId: crypto.randomUUID(),
            target: {
              host: target.host,
              sessionId: target.sessionId,
              hostSessionId: target.hostSessionId,
              name: target.name,
            },
            eventIds: [q.notice.eventId],
            at: new Date(deps.now()).toISOString(),
            status: "failed",
            msgId: null,
            reason,
          });
        } catch (e) {
          log("warn", "notify", { error: errorMessage(e), dispatch: q.notice.dispatchId });
        }
      }
      // nothing is sent unless every notice's claim is on disk. A claim that cannot be written rolls the batch's
      // written claims back to failed (provably not submitted, so still deliverable), keeps that notice for a
      // later pass, and claims the rest again at once: one bad file never holds back the others
      let attempt: DeliveryAttempt;
      for (;;) {
        if (!due.length) return;
        attempt = {
          attemptId: crypto.randomUUID(),
          target: {
            host: target.host,
            sessionId: target.sessionId,
            hostSessionId: target.hostSessionId,
            name: target.name,
          },
          eventIds: due.map((q) => q.notice.eventId),
          at: new Date(deps.now()).toISOString(),
          status: "submitting",
          msgId: null,
          reason: null,
        };
        const claimed: Queued[] = [];
        const broken = due.find((q) => {
          try {
            writeDeliveryAttempt(q.dir, attempt);
            claimed.push(q);
            return false;
          } catch (e) {
            log("warn", "notify", { error: errorMessage(e), dispatch: q.notice.dispatchId });
            return true;
          }
        });
        if (!broken) break;
        const undone: DeliveryAttempt = {
          ...attempt,
          status: "failed",
          reason: "A claim in this batch was not persisted; nothing was submitted.",
        };
        for (const c of claimed)
          try {
            writeDeliveryAttempt(c.dir, undone);
          } catch (u) {
            log("warn", "notify", { error: errorMessage(u), dispatch: c.notice.dispatchId });
          }
        // a claim that fails again and again is a damaged file, not a passing fault: it is given up then
        broken.claimFailures = (broken.claimFailures ?? 0) + 1;
        if (broken.claimFailures < MAX_CLAIM_FAILURES) busy.push(broken);
        due.splice(due.indexOf(broken), 1);
      }
      const notices = due.map((q) => q.notice);
      let outcome: QueueSendResult;
      const content = envelope(formatNotices(notices));
      try {
        if (target.host === "codex") outcome = await sendCodex(target, content);
        else {
          const r = await send(
            { socketPath: deps.session!.socketPath, token: deps.session!.token },
            content,
            priorityOf(notices),
          );
          outcome =
            r.outcome === "sent" && r.msgId
              ? { outcome: "accepted", msgId: r.msgId }
              : {
                  // an error before any frame was written (no msg_id) provably submitted nothing: retried later
                  outcome:
                    r.outcome === "no-session" ||
                    r.outcome === "refused" ||
                    (r.outcome === "error" && !r.msgId)
                      ? "not-submitted"
                      : "ambiguous",
                  reason: "Claude inbox has no verified receipt; use peek/result.",
                };
        }
      } catch {
        outcome = {
          outcome: "ambiguous",
          reason: "Sender ended without a verified receipt; retry may duplicate input. Use peek/result.",
        };
      }
      const receipt: DeliveryAttempt = {
        ...attempt,
        status:
          outcome.outcome === "accepted"
            ? "accepted"
            : outcome.outcome === "not-submitted"
              ? "failed"
              : "ambiguous",
        msgId: outcome.outcome === "accepted" ? outcome.msgId : null,
        reason:
          outcome.outcome === "accepted"
            ? null
            : outcome.outcome === "not-submitted"
              ? "Transport did not submit input; check native transport and use peek/result."
              : "No verified receipt; retry may duplicate input. Use peek/result.",
      };
      // the outcome is known for every notice: one damaged delivery file never discards it for the others
      for (const q of due)
        try {
          writeDeliveryAttempt(q.dir, receipt);
        } catch (e) {
          log("warn", "notify", { error: errorMessage(e), dispatch: q.notice.dispatchId });
        }
      const live = currentSession(deps);
      const stillHere = !stopped && live !== null && sessionKey(live) === sessionKey(target);
      const marked = due.filter((q) => stillHere && owned(q.run));
      // provably not submitted, so a retry cannot duplicate input: tried again a window later, a few times
      if (receipt.status === "failed")
        for (const q of marked) {
          q.sendFailures = (q.sendFailures ?? 0) + 1;
          if (q.sendFailures < MAX_SEND_FAILURES) busy.push(q);
        }
      if (receipt.status === "accepted" && target.host === "claude-code")
        for (const q of marked)
          try {
            if (!existsSync(q.mark))
              writeJsonAtomic(q.mark, { schema: 1, msgId: receipt.msgId, at: receipt.at });
          } catch (e) {
            log("warn", "notify", { error: errorMessage(e), dispatch: q.notice.dispatchId });
          }
      log(receipt.status === "accepted" ? "info" : "warn", "notify", {
        outcome: receipt.status,
        msgId: receipt.msgId,
        reason: receipt.reason,
        dispatches: notices.map((n) => n.dispatchId),
        unmarked: due.filter((q) => !marked.includes(q)).map((q) => q.notice.dispatchId),
      });
    } finally {
      for (const release of claims) release();
      requeue(busy);
    }
  }

  /**
   * Queues again the notices another server held the claim on, whose batch could not claim them all, or that
   * the transport provably did not submit; the next pass drops those no longer due or owned.
   */
  function requeue(busy: Queued[]): void {
    if (stopped || busy.length === 0) return;
    for (const q of busy) if (!queue.has(q.key)) queue.set(q.key, q);
    schedule();
  }

  function queueNotice(q: Queued): void {
    const target = currentSession(deps);
    if (stopped || !target || queue.has(q.key) || !q.due() || !owned(q.run)) return;
    let recovering = false;
    try {
      recovering = readDelivery(q.dir).some(
        (a) => a.status === "submitting" && a.eventIds.includes(q.notice.eventId),
      );
    } catch (e) {
      log("warn", "notify", { error: errorMessage(e), dispatch: q.notice.dispatchId });
      return;
    }
    if (!recovering && !pending(q, target)) return;
    queue.set(q.key, q);
    schedule();
  }

  const enqueue = (run: Run, d: Dispatch, record: RunRecord): void => {
    const notice = finishedNotice(run, d, record);
    queueNotice({
      key: notice.eventId,
      run,
      dir: d.dir,
      notice,
      mark: dispatchPaths(d.dir).notified,
      due: () => awaitsCollect(d.dir),
    });
  };

  const onStall = (s: Stalled): void => {
    try {
      const p = dispatchPaths(s.d.dir);
      const notice = stalledNotice(s.run, s.d, s.quietMs, deps.now());
      queueNotice({
        key: notice.eventId,
        run: s.run,
        dir: s.d.dir,
        notice,
        mark: p.stallNotified,
        due: () => !existsSync(p.exit),
      });
    } catch (e) {
      log("warn", "notify", { run: s.run.id, name: s.d.admit.name, error: errorMessage(e) });
    }
  };

  const onSettled = (s: Settled): void => {
    try {
      enqueue(s.run, s.d, s.record);
    } catch (e) {
      log("warn", "notify", { run: s.run.id, name: s.d.admit.name, error: errorMessage(e) });
    }
  };

  const n: Notifier = {
    onSettled,
    onStall,
    async scan() {
      if (!currentSession(deps)) return;
      for (const run of listRuns().runs) {
        try {
          if (!owned(run)) continue;
          const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
          for (const d of listDispatches(run)) {
            // one dispatch's damaged evidence stays ambiguous for it alone: the rest of the run is still scanned
            try {
              const p = dispatchPaths(d.dir);
              for (const [kind, mark] of [
                ["finished", p.notified],
                ["stalled", p.stallNotified],
              ] as const) {
                const release = tryLock(mark);
                if (!release) continue;
                try {
                  recoverSubmission(d.dir, JSON.stringify([run.id, d.admit.dispatchId, kind]));
                } finally {
                  release();
                }
              }
              const r = records.get(d.admit.dispatchId);
              // a limit not yet failed over is reconcile's to settle first: its hook announces it then
              if (r && !(r.status === "limit" && !readFailover(d.dir))) enqueue(run, d, r);
              if (existsSync(p.stall) && !existsSync(p.exit)) {
                onStall({ run, d, quietMs: readStallQuietMs(d.dir) });
              }
            } catch (e) {
              log("warn", "notify", { run: run.id, name: d.admit.name, error: errorMessage(e) });
            }
          }
        } catch (e) {
          log("warn", "notify", { run: run.id, error: errorMessage(e) });
        }
      }
    },
    async idle() {
      for (;;) {
        if (timer === null && queue.size === 0) {
          await flight;
          if (timer === null && queue.size === 0) return;
        } else await Bun.sleep(5);
      }
    },
    stop() {
      stopped = true;
      settledHooks.delete(onSettled);
      stallHooks.delete(onStall);
      if (timer !== null) clearTimeout(timer);
      timer = null;
      queue.clear();
    },
  };
  if (!retryEvent) {
    settledHooks.add(onSettled);
    stallHooks.add(onStall);
  }
  return n;
}

/** Retry only a stored event for the current owner, after an explicit duplicate-risk decision. */
export async function retryDelivery(
  deps: Deps,
  dir: string,
  eventId: string,
  decision: { allowPossibleDuplicate: true },
): Promise<void> {
  if (decision?.allowPossibleDuplicate !== true)
    throw new CatherdError("E_INPUT_INVALID", "Retry requires acknowledging possible duplicate input");
  const target = currentSession(deps);
  const located = listRuns().runs.flatMap((run) =>
    listDispatches(run)
      .filter((d) => d.dir === dir)
      .map((d) => ({ run, d })),
  )[0];
  if (!target || !located || !ownsRun(deps, located.run))
    throw new CatherdError(
      "E_INPUT_INVALID",
      "Retry requires the validated current owner and stored dispatch",
    );
  const { run, d } = located;
  const record = readRecords(run).records.find((r) => r.dispatchId === d.admit.dispatchId);
  const finished = JSON.stringify([run.id, d.admit.dispatchId, "finished"]);
  const stalled = JSON.stringify([run.id, d.admit.dispatchId, "stalled"]);
  if (eventId !== finished && eventId !== stalled)
    throw new CatherdError("E_INPUT_INVALID", "Event does not belong to this dispatch");
  if (eventId === finished && (!record || !awaitsCollect(dir)))
    throw new CatherdError("E_INPUT_INVALID", "Finished result is absent or already collected");
  if (eventId === stalled && (!existsSync(dispatchPaths(dir).stall) || existsSync(dispatchPaths(dir).exit)))
    throw new CatherdError("E_INPUT_INVALID", "Stalled event is absent or already finished");
  // Corrupt evidence cannot be safely replaced by an explicit retry.
  readDelivery(dir);
  const n = notifierFor(deps, { coalesceMs: 0 }, eventId);
  try {
    if (eventId === finished)
      n.onSettled({ run, d, record: record!, hints: [], started: null, pause: null, stateHints: [] });
    else {
      n.onStall({ run, d, quietMs: readStallQuietMs(dir) });
    }
    await n.idle();
  } finally {
    n.stop();
  }
}
