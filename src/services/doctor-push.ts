import type { HostContext } from "../domain/host.ts";
import { envelope } from "../domain/notice.ts";
import { readSessionEnv, sessionFileFor } from "../infra/claude-session.ts";
import { sendToCodexQueue } from "../infra/codex-queue.ts";
import { sendToInbox } from "../infra/peer-inbox.ts";
import type { Check } from "./doctor-checks.ts";

export type PushOutcome = "ok" | "no-session" | "unconfirmed" | "failed";
export interface PushProbe {
  outcome: PushOutcome;
  detail: string;
  enqueue: "accepted" | "ambiguous" | "not-submitted" | "no-session";
  processing: "observed" | "unconfirmed";
  msgId: string | null;
}

/** Explicit smoke only: native receipts prove acceptance, never model processing or result collection. */
export async function probePush(
  host: HostContext,
  env: Record<string, string | undefined>,
): Promise<PushProbe> {
  const target = host.session;
  if (host.conflict || !target || host.host === "unknown" || target.host !== host.host)
    return {
      outcome: "no-session",
      enqueue: "no-session",
      processing: "unconfirmed",
      msgId: null,
      detail:
        "No validated live host session; run doctor --test-push from the original conversation. Terminal --host selects checks only. Use peek/result.",
    };
  const content = envelope(`catherd doctor: push test ${crypto.randomUUID().slice(0, 8)}, no action needed`);
  let enqueue: PushProbe["enqueue"];
  let msgId: string | null = null;
  if (host.host === "codex") {
    const sent = await sendToCodexQueue(target, content, env);
    enqueue = sent.outcome;
    if (sent.outcome === "accepted") msgId = sent.msgId;
  } else {
    const s = readSessionEnv(env);
    const liveId = s ? (sessionFileFor(s)?.sessionId ?? s.sessionId) : null;
    if (!s || liveId !== target.sessionId)
      return {
        outcome: "no-session",
        enqueue: "no-session",
        processing: "unconfirmed",
        msgId: null,
        detail: "Claude inbox identity does not match the validated live session; use peek/result.",
      };
    const sent = await sendToInbox(s, content, "later");
    if (sent.outcome === "no-session" || sent.outcome === "refused")
      return {
        outcome: "no-session",
        enqueue: "not-submitted",
        processing: "unconfirmed",
        msgId: null,
        detail:
          "This session's inbox is not reachable; run doctor --test-push from a live Claude Code session. Use peek/result.",
      };
    enqueue = sent.outcome === "sent" && sent.msgId ? "accepted" : "ambiguous";
    if (enqueue === "accepted") msgId = sent.msgId ?? null;
  }
  return {
    outcome: enqueue === "accepted" ? "ok" : enqueue === "ambiguous" ? "unconfirmed" : "failed",
    enqueue,
    processing: "unconfirmed",
    msgId,
    detail:
      enqueue === "accepted"
        ? "Smoke enqueue accepted; processing unconfirmed. Unloaded, interrupted or restarted hosts may retain queued input. Use peek/result for durable unread results."
        : enqueue === "ambiguous"
          ? "Smoke has no verified queue receipt; processing unconfirmed. Retrying may duplicate input. Use peek/result."
          : "Smoke was not submitted; check native queue support and the existing endpoint. Use peek/result.",
  };
}

export function pushCheck(p: PushProbe): Check {
  const base = { id: "push", label: "host completion push", detail: p.detail };
  if (p.enqueue === "accepted") return { ...base, state: "ok", word: "enqueue accepted" };
  if (p.outcome === "no-session") return { ...base, state: "skip", word: "no session" };
  if (p.enqueue === "ambiguous") return { ...base, state: "warn", word: "ambiguous" };
  return {
    ...base,
    state: "fail",
    word: "not submitted",
    fix: "Check native host transport; peek/result keeps the unread record available.",
  };
}
