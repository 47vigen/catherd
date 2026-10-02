import { readFileSync } from "node:fs";
import { errorMessage } from "../domain/errors.ts";
import type { HostSessionRef } from "../domain/host.ts";
import { envelope, formatNotices } from "../domain/notice.ts";
import { type QueueSendResult, sendToCodexQueue } from "../infra/codex-queue.ts";
import { type DeliveryAttempt, deliveryState, writeDeliveryAttempt } from "../infra/delivery.ts";
import { awaitsCollect, dispatchPaths } from "../infra/dispatch-dir.ts";
import { tryLock } from "../infra/filelock.ts";
import { log } from "../infra/log.ts";
import { admitPath, listDispatches } from "./dispatches.ts";
import { finalizeDispatch } from "./finalize.ts";
import { finishedNotice, recoverSubmission } from "./notifier.ts";
import { findRun } from "./run-store.ts";
import { runOwner } from "./sessions.ts";

/**
 * How long the supervisor leaves the owner's MCP server to push first (the fast path: its watcher finalizes,
 * settles and sends within the notifier's coalescing window). Either path sends under the same per-event receipt,
 * so a late server or a late supervisor finds the event accepted and sends nothing.
 */
export const END_PUSH_GRACE_MS = 20_000;

/** `CATHERD_END_PUSH_GRACE_MS` (a test of the spawned supervisor shortens it), else END_PUSH_GRACE_MS. */
function graceFromEnv(): number {
  const ms = Number(process.env.CATHERD_END_PUSH_GRACE_MS);
  return process.env.CATHERD_END_PUSH_GRACE_MS !== undefined && Number.isFinite(ms) && ms >= 0
    ? ms
    : END_PUSH_GRACE_MS;
}

export interface EndPushOptions {
  graceMs?: number;
  /** the sender; tests replace it */
  sendCodex?: (target: HostSessionRef, content: string) => Promise<QueueSendResult>;
  now?: () => number;
}

/** Why the supervisor pushed nothing, or the receipt's status when it did. */
export type EndPushOutcome =
  | "off"
  | "not-a-run"
  | "not-codex"
  | "limit"
  | "read"
  | "busy"
  | "delivered"
  | DeliveryAttempt["status"];

/** The run's owner, when it is a Codex thread: the supervisor's push targets it. */
function codexOwner(runId: string): HostSessionRef | null {
  const owner = runOwner(findRun(runId));
  return owner?.host === "codex"
    ? { host: "codex", sessionId: owner.sessionId, hostSessionId: null, name: null }
    : null;
}

/**
 * Plan 22, push from where a role ends: the detached supervisor of a dispatch whose run a Codex thread owns, once
 * its worker exited, queues the role's notice to that thread with `codex queue --remote unix:// --thread <owner>`.
 * Codex's app-server keeps queued input for an unloaded thread, so a result reaches a coordinator whose MCP
 * server the daemon stopped (no client attached) at its next attach. The notice is the server's own text, and it
 * goes under the same per-event receipt (`delivery.json`, the dispatch's notify lock), so the two paths never
 * double-deliver. A usage limit is left to the owner's server, which fails it over before it announces it.
 * `CATHERD_NO_END_PUSH=1` turns it off (the test preload sets it). Never throws.
 */
export async function pushFromEnd(dispatchDir: string, o: EndPushOptions = {}): Promise<EndPushOutcome> {
  if (process.env.CATHERD_NO_END_PUSH === "1") return "off";
  try {
    const runId = (JSON.parse(readFileSync(admitPath(dispatchDir), "utf8")) as { runId?: unknown }).runId;
    if (typeof runId !== "string") return "not-a-run";
    // read before the grace: a run no Codex thread owns costs the supervisor nothing
    if (!codexOwner(runId)) return "not-codex";
    await Bun.sleep(o.graceMs ?? graceFromEnv());
    const run = findRun(runId);
    const d = listDispatches(run).find((x) => x.dir === dispatchDir);
    if (!d) return "not-a-run";
    const record = await finalizeDispatch(run, d);
    if (record.status === "limit") return "limit";
    // the owner of record now, which a claim may have changed during the grace
    const target = codexOwner(runId);
    if (!target) return "not-codex";
    if (!awaitsCollect(d.dir)) return "read";
    const notice = finishedNotice(run, d, record);
    const release = tryLock(dispatchPaths(d.dir).notified);
    if (!release) return "busy";
    try {
      recoverSubmission(d.dir, notice.eventId);
      if (deliveryState(d.dir, target, notice.eventId) !== "pending") return "delivered";
      const attempt: DeliveryAttempt = {
        attemptId: crypto.randomUUID(),
        target,
        eventIds: [notice.eventId],
        at: new Date((o.now ?? Date.now)()).toISOString(),
        status: "submitting",
        msgId: null,
        reason: null,
      };
      writeDeliveryAttempt(d.dir, attempt);
      let sent: QueueSendResult;
      try {
        sent = await (o.sendCodex ?? ((t, c) => sendToCodexQueue(t, c, process.env)))(
          target,
          envelope(formatNotices([notice])),
        );
      } catch {
        sent = { outcome: "ambiguous", reason: "Sender ended without a verified receipt; use peek/result." };
      }
      const receipt: DeliveryAttempt = {
        ...attempt,
        status:
          sent.outcome === "accepted"
            ? "accepted"
            : sent.outcome === "not-submitted"
              ? "failed"
              : "ambiguous",
        msgId: sent.outcome === "accepted" ? sent.msgId : null,
        reason: sent.outcome === "accepted" ? null : sent.reason,
      };
      writeDeliveryAttempt(d.dir, receipt);
      log(receipt.status === "accepted" ? "info" : "warn", "notify", {
        from: "supervisor",
        outcome: receipt.status,
        msgId: receipt.msgId,
        reason: receipt.reason,
        dispatches: [notice.dispatchId],
      });
      return receipt.status;
    } finally {
      release();
    }
  } catch (e) {
    log("warn", "notify", { from: "supervisor", dispatch: dispatchDir, error: errorMessage(e) });
    return "not-a-run";
  }
}
