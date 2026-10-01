import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { sessionKey, type HostContext, type HostSessionRef } from "../domain/host.ts";
import { deliveryState, readDelivery, type DeliveryState } from "../infra/delivery.ts";
import type { ExitInfo, RunRecord } from "../domain/record.ts";
import { awaitsCollect, dispatchPaths, readExit } from "../infra/dispatch-dir.ts";
import { redact } from "../infra/log.ts";
import { type Dispatch, listDispatches } from "./dispatches.ts";
import { registerSavedSecrets } from "./jev-service.ts";
import { runOwner } from "./sessions.ts";
import { readRecords, type Run } from "./run-store.ts";

/** How many trailing lines of stderr, events and the supervisor log `runs show --debug` prints. */
export const TAIL_LINES = 20;

export function inspectionHost(host: HostContext): HostContext {
  const target = host.session;
  return {
    host: host.host,
    conflict: host.conflict,
    session: target
      ? {
          host: target.host,
          sessionId: target.sessionId,
          hostSessionId: target.hostSessionId,
          name: target.name,
        }
      : null,
  };
}

export interface DeliveryInspection {
  eventId: string;
  delivery: DeliveryState;
  receipt: { msgId: string; target: HostSessionRef; at: string } | null;
}

export function inspectDelivery(
  run: Run,
  d: Dispatch,
  recorded: boolean,
  eventId = JSON.stringify([
    run.id,
    d.admit.dispatchId,
    !recorded && existsSync(dispatchPaths(d.dir).stall) ? "stalled" : "finished",
  ]),
): DeliveryInspection {
  const owner = runOwner(run);
  const target = owner
    ? { host: owner.host, sessionId: owner.sessionId, hostSessionId: null, name: null }
    : null;
  const finished = eventId === JSON.stringify([run.id, d.admit.dispatchId, "finished"]);
  const collected = finished && recorded && !awaitsCollect(d.dir);
  try {
    const receipt = target
      ? readDelivery(d.dir).findLast(
          (a) =>
            a.status === "accepted" &&
            a.eventIds.includes(eventId) &&
            sessionKey(a.target) === sessionKey(target),
        )
      : undefined;
    return {
      eventId,
      delivery: collected
        ? "collected"
        : (recorded || !finished) && target
          ? deliveryState(d.dir, target, eventId)
          : "pending",
      receipt: receipt?.msgId
        ? {
            msgId: receipt.msgId,
            at: receipt.at,
            target: {
              host: receipt.target.host,
              sessionId: receipt.target.sessionId,
              hostSessionId: receipt.target.hostSessionId,
              name: receipt.target.name,
            },
          }
        : null,
    };
  } catch {
    return { eventId, delivery: collected ? "collected" : "ambiguous", receipt: null };
  }
}

/**
 * Stored stalled and finished events are separate; only finished records can be collected. A stall the
 * role outlived before any send is obsolete: the notifier drops it and retry refuses it, so it is not shown.
 */
export function inspectDeliveries(run: Run, d: Dispatch, recorded: boolean): DeliveryInspection[] {
  const id = (kind: string) => JSON.stringify([run.id, d.admit.dispatchId, kind]);
  const p = dispatchPaths(d.dir);
  return [
    ...(recorded ? ["finished"] : []),
    ...(existsSync(p.stall) && (!existsSync(p.exit) || attempted(d.dir, id("stalled"))) ? ["stalled"] : []),
  ].map((kind) => inspectDelivery(run, d, recorded, id(kind)));
}

function attempted(dir: string, eventId: string): boolean {
  try {
    return readDelivery(dir).some((a) => a.eventIds.includes(eventId));
  } catch {
    return true; // damaged evidence is shown, as ambiguous, rather than hidden
  }
}

export interface DispatchDebug extends DeliveryInspection {
  deliveries: DeliveryInspection[];
  name: string;
  dispatchId: string;
  rung: string;
  admittedAt: string;
  record: RunRecord | null;
  exit: ExitInfo | null;
  stderrTail: string[];
  eventsTail: string[];
  supervisorTail: string[];
}

/**
 * The last `n` non-blank lines of `file`, read backwards `chunk` bytes at a time until they are in hand:
 * a worker's stderr or event stream can be large, and only its end is shown. [] when there is no file.
 */
export function tail(file: string, n = TAIL_LINES, chunk = 64 * 1024): string[] {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return [];
  }
  try {
    let pos = fstatSync(fd).size;
    let buf = Buffer.alloc(0);
    for (;;) {
      const lines = buf.toString("utf8").split("\n");
      // the first line may start mid-line, or mid-character: it counts only once the file's start is read
      if (pos > 0) lines.shift();
      const kept = lines.filter((l) => l.trim());
      if (kept.length >= n || pos === 0) return kept.slice(-n);
      const len = Math.min(chunk, pos);
      pos -= len;
      const part = Buffer.alloc(len);
      readSync(fd, part, 0, len, pos);
      buf = Buffer.concat([part, buf]);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Spec §10.2 `runs show <id> --debug`: per dispatch, oldest first, its record, exit.json and the tails of
 * stderr, events.jsonl and supervisor.log, with every known secret redacted. Reads only.
 */
export function runDebug(run: Run, name?: string): DispatchDebug[] {
  registerSavedSecrets();
  const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
  return listDispatches(run)
    .filter((d) => name === undefined || d.admit.name === name)
    .sort((a, b) => a.admit.dispatchId.localeCompare(b.admit.dispatchId))
    .map((d) => {
      const p = dispatchPaths(d.dir);
      return redact({
        ...inspectDelivery(run, d, records.has(d.admit.dispatchId)),
        deliveries: inspectDeliveries(run, d, records.has(d.admit.dispatchId)),
        name: d.admit.name,
        dispatchId: d.admit.dispatchId,
        rung: d.admit.rung,
        admittedAt: d.admit.admittedAt,
        record: records.get(d.admit.dispatchId) ?? null,
        exit: readExit(d.dir),
        stderrTail: tail(p.stderr),
        eventsTail: tail(p.events),
        supervisorTail: tail(p.supervisorLog),
      });
    });
}
