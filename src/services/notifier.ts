import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../domain/errors.ts";
import { envelope, formatNotices, type Notice, type NoticePriority, priorityOf } from "../domain/notice.ts";
import type { RunRecord } from "../domain/record.ts";
import { awaitsCollect, dispatchPaths } from "../infra/dispatch-dir.ts";
import { tryLock } from "../infra/filelock.ts";
import { log } from "../infra/log.ts";
import { type SendResult, sendToInbox } from "../infra/peer-inbox.ts";
import { writeJsonAtomic } from "../infra/store.ts";
import { type Settled, settledHooks, type Stalled, stallHooks } from "./dispatch-service.ts";
import { type Dispatch, listDispatches, readFailover } from "./dispatches.ts";
import type { Deps } from "./ports.ts";
import { listRuns, readRecords, type Run } from "./run-store.ts";
import { currentSession, ownsRun } from "./sessions.ts";

/**
 * Spec §3.4: runs only inside the MCP server, the session's child and so its only sender (§3.2). For every run this
 * session owns, a dispatch that is settled with its record still unread is announced to the session's peer inbox;
 * notices that arrive within the window of each other go as one message; a message that went out is written down
 * (`notified.json`), so a restart never sends it twice, and claimed while it goes, so two servers of one session never
 * both send it. Ownership is asked again under the claim and once more after the message went: a run another session
 * claimed meanwhile is left unmarked, so its new owner announces it too (a copy to the session that gave the run up is
 * acceptable, a notice lost to the owner is not); a notice whose claim another server holds is tried again after the
 * window until it is sent, read, marked or no longer this session's. Disk stays the truth: a notice that cannot be
 * sent is dropped (its claim freed), and the record waits, unread, for `result` or `peek`.
 */

export interface NotifierOptions {
  /** notices this close to each other go as one message (spec: 3 s); tests shorten it */
  coalesceMs?: number;
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

const notified = (dir: string): boolean => existsSync(dispatchPaths(dir).notified);

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
  /** the mark a message that went out leaves */
  mark: string;
  /** whether it is still news when the message goes */
  due: () => boolean;
}

/** Starts the notifier for this process's session and hooks it to every settled dispatch. */
export function startNotifier(deps: Deps, o: NotifierOptions = {}): Notifier {
  const window = o.coalesceMs ?? 3_000;
  const send = o.send ?? sendToInbox;
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

  async function deliver(batch: Queued[]): Promise<void> {
    if (!deps.session) return;
    // Each notice is claimed before it goes (an exclusive lock on its mark, freed if its holder dies): two servers
    // of one session, a replacement starting while the old one still watches, never both send it. Whether it is
    // still news is asked under the claim: the other may have announced it just before letting go.
    const claims: (() => void)[] = [];
    const due: Queued[] = [];
    const busy: Queued[] = [];
    try {
      for (const q of batch) {
        // read (or announced) meanwhile, or the run moved to another session (whose server tells it)
        if (!q.due() || !owned(q.run)) continue;
        const release = tryLock(q.mark);
        // another server is announcing it: asked again after the window, since that server may leave it unmarked
        // (the run moved to this session while its message was on its way)
        if (!release) {
          busy.push(q);
          continue;
        }
        claims.push(release);
        // asked again under the claim: the run may have moved, or the notice gone out, while it was taken
        if (q.due() && owned(q.run)) due.push(q);
      }
      if (due.length === 0) return;
      const notices = due.map((q) => q.notice);
      const r = await send(
        { socketPath: deps.session.socketPath, token: deps.session.token },
        envelope(formatNotices(notices)),
        priorityOf(notices),
      ).catch((e: unknown): SendResult => ({ outcome: "error", reason: errorMessage(e) }));
      if (r.outcome !== "sent") {
        log("warn", "notify", {
          outcome: r.outcome,
          reason: r.reason,
          dispatches: notices.map((n) => n.dispatchId),
        });
        return;
      }
      const at = new Date(deps.now()).toISOString();
      // a run that moved while the message was on its way is left unmarked: its new owner announces it too
      const marked = due.filter((q) => owned(q.run));
      for (const q of marked) writeJsonAtomic(q.mark, { schema: 1, msgId: r.msgId, at });
      const unmarked = due.filter((q) => !marked.includes(q)).map((q) => q.notice.dispatchId);
      log("info", "notify", { msgId: r.msgId, dispatches: notices.map((n) => n.dispatchId), unmarked });
    } finally {
      for (const release of claims) release();
      requeue(busy);
    }
  }

  /** Queues again the notices another server held the claim on; the next pass drops those no longer due or owned. */
  function requeue(busy: Queued[]): void {
    if (stopped || busy.length === 0) return;
    for (const q of busy) if (!queue.has(q.key)) queue.set(q.key, q);
    schedule();
  }

  const enqueue = (run: Run, d: Dispatch, record: RunRecord): void => {
    if (queue.has(record.dispatchId) || notified(d.dir) || !awaitsCollect(d.dir) || !owned(run)) return;
    queue.set(record.dispatchId, {
      key: record.dispatchId,
      run,
      notice: finishedNotice(run, d, record),
      mark: dispatchPaths(d.dir).notified,
      due: () => awaitsCollect(d.dir) && !notified(d.dir),
    });
    schedule();
  };

  const onStall = (s: Stalled): void => {
    try {
      const p = dispatchPaths(s.d.dir);
      const key = `${s.d.admit.dispatchId} stall`;
      if (queue.has(key) || existsSync(p.stallNotified) || existsSync(p.exit) || !owned(s.run)) return;
      queue.set(key, {
        key,
        run: s.run,
        notice: stalledNotice(s.run, s.d, s.quietMs, deps.now()),
        mark: p.stallNotified,
        // it finished meanwhile: its record is the news now
        due: () => !existsSync(p.stallNotified) && !existsSync(p.exit),
      });
      schedule();
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
            const r = records.get(d.admit.dispatchId);
            // a limit not yet failed over is reconcile's to settle first: its hook announces it then
            if (r && !(r.status === "limit" && !readFailover(d.dir))) enqueue(run, d, r);
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
  settledHooks.add(onSettled);
  stallHooks.add(onStall);
  return n;
}
