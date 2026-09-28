import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../domain/errors.ts";
import { envelope, formatNotices, type Notice, type NoticePriority, priorityOf } from "../domain/notice.ts";
import type { RunRecord } from "../domain/record.ts";
import { awaitsCollect, dispatchPaths } from "../infra/dispatch-dir.ts";
import { log } from "../infra/log.ts";
import { type SendResult, sendToInbox } from "../infra/peer-inbox.ts";
import { writeJsonAtomic } from "../infra/store.ts";
import { type Settled, settledHooks } from "./dispatch-service.ts";
import { type Dispatch, listDispatches, readFailover } from "./dispatches.ts";
import type { Deps } from "./ports.ts";
import { listRuns, readRecords, type Run } from "./run-store.ts";
import { currentSession, runOwner } from "./sessions.ts";

/**
 * Spec §3.4: runs only inside the MCP server, the session's child and so its only sender (§3.2). For every run this
 * session owns, a dispatch that is settled with its record still unread is announced to the session's peer inbox;
 * notices that arrive within the window of each other go as one message; a message that went out is written down
 * (`notified.json`), so a restart never sends it twice. Disk stays the truth: a notice that cannot be sent is
 * dropped, and the record waits, unread, for `result` or `peek`.
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

interface Queued {
  notice: Notice;
  dir: string;
}

/** Starts the notifier for this process's session and hooks it to every settled dispatch. */
export function startNotifier(deps: Deps, o: NotifierOptions = {}): Notifier {
  const window = o.coalesceMs ?? 3_000;
  const send = o.send ?? sendToInbox;
  const queue = new Map<string, Queued>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstAt = 0;
  let flight: Promise<void> = Promise.resolve();

  /** This session's id, when there is one and it owns the run. */
  const owned = (run: Run): boolean => {
    const me = currentSession(deps);
    return me !== null && runOwner(run)?.sessionId === me.sessionId;
  };

  const flush = (): void => {
    timer = null;
    const batch = [...queue.values()];
    queue.clear();
    flight = flight.then(() => deliver(batch));
  };

  const schedule = (): void => {
    const now = Date.now();
    if (timer === null) firstAt = now;
    else clearTimeout(timer);
    // quiet for `window`, but never held past five windows: a steady trickle still goes out
    timer = setTimeout(flush, Math.max(0, Math.min(window, firstAt + 5 * window - now)));
  };

  async function deliver(batch: Queued[]): Promise<void> {
    // read (or announced) meanwhile: nothing to say
    const due = batch.filter((q) => awaitsCollect(q.dir) && !notified(q.dir));
    if (due.length === 0 || !deps.session) return;
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
    for (const q of due) writeJsonAtomic(dispatchPaths(q.dir).notified, { schema: 1, msgId: r.msgId, at });
    log("info", "notify", { msgId: r.msgId, dispatches: notices.map((n) => n.dispatchId) });
  }

  const enqueue = (run: Run, d: Dispatch, record: RunRecord): void => {
    if (queue.has(record.dispatchId) || notified(d.dir) || !awaitsCollect(d.dir) || !owned(run)) return;
    queue.set(record.dispatchId, { notice: finishedNotice(run, d, record), dir: d.dir });
    schedule();
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
      settledHooks.delete(onSettled);
      if (timer !== null) clearTimeout(timer);
      timer = null;
      queue.clear();
    },
  };
  settledHooks.add(onSettled);
  return n;
}
