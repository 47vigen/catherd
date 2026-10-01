import { existsSync } from "node:fs";
import { z } from "zod";
import { CatherdError } from "../domain/errors.ts";
import { sessionKey, type HostSessionRef } from "../domain/host.ts";
import { awaitsCollect, dispatchPaths } from "./dispatch-dir.ts";
import { withFileLockSync } from "./filelock.ts";
import { readVersioned, writeJsonAtomic } from "./store.ts";

const AttemptSchema = z
  .looseObject({
    attemptId: z.string().min(1),
    target: z.object({
      host: z.enum(["codex", "claude-code"]),
      sessionId: z.string().min(1),
      hostSessionId: z.string().nullable(),
      name: z.string().nullable(),
    }),
    eventIds: z.array(z.string().min(1)).min(1),
    at: z.iso.datetime(),
    status: z.enum(["submitting", "accepted", "ambiguous", "failed"]),
    msgId: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .refine((a) => a.status !== "accepted" || Boolean(a.msgId?.trim()), "accepted attempt needs a receipt");
const DeliverySchema = z.looseObject({ schema: z.literal(1), attempts: z.array(AttemptSchema) });
export type DeliveryAttempt = z.infer<typeof AttemptSchema>;
export type DeliveryState = "pending" | "enqueue-accepted" | "ambiguous" | "collected";

export function readDelivery(dir: string): DeliveryAttempt[] {
  const file = dispatchPaths(dir).delivery;
  return existsSync(file)
    ? readVersioned(file, DeliverySchema, 1, {
        fix: "Use peek/result; delivery evidence is unreadable and retry may duplicate input.",
      }).attempts
    : [];
}

/** Short shared lock: distinct stalled/finished event claims must not lose each other's updates. */
export function writeDeliveryAttempt(dir: string, attempt: DeliveryAttempt): void {
  const parsed = AttemptSchema.safeParse(attempt);
  if (!parsed.success) throw new CatherdError("E_INPUT_INVALID", "Invalid delivery attempt");
  const file = dispatchPaths(dir).delivery;
  withFileLockSync(file, () => {
    const document = existsSync(file)
      ? readVersioned(file, DeliverySchema, 1)
      : { schema: 1 as const, attempts: [] as DeliveryAttempt[] };
    const prior = document.attempts.findIndex((a) => a.attemptId === attempt.attemptId);
    if (prior < 0) document.attempts.push(parsed.data);
    else {
      const sent = document.attempts[prior]!;
      if (
        JSON.stringify(sent.target) !== JSON.stringify(parsed.data.target) ||
        JSON.stringify(sent.eventIds) !== JSON.stringify(attempt.eventIds) ||
        sent.at !== attempt.at
      )
        throw new CatherdError(
          "E_INPUT_INVALID",
          "Delivery target, events and submission time are immutable",
        );
      document.attempts[prior] = { ...sent, ...parsed.data };
    }
    writeJsonAtomic(file, document);
  });
}

export function deliveryState(dir: string, target: HostSessionRef, eventId: string): DeliveryState {
  try {
    const event = JSON.parse(eventId) as unknown;
    if (Array.isArray(event) && event[2] === "finished" && !awaitsCollect(dir)) return "collected";
  } catch {
    /* Invalid event text cannot imply collection. */
  }
  try {
    const attempts = readDelivery(dir).filter(
      (a) => sessionKey(a.target) === sessionKey(target) && a.eventIds.includes(eventId),
    );
    if (attempts.some((a) => a.status === "accepted")) return "enqueue-accepted";
    if (attempts.some((a) => a.status === "submitting" || a.status === "ambiguous")) return "ambiguous";
    return "pending";
  } catch {
    return "ambiguous";
  }
}
