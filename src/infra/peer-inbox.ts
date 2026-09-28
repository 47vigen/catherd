import { createConnection } from "node:net";

/**
 * Spec §3.4: one frame to a Claude Code session's peer inbox (docs/research/2026-09-28-cross-session-messaging.md).
 * The auth line (the child token the session gave its children), then one `user` frame, in one write; the socket
 * is closed 150 ms later, as the native client does on macOS. No `session_id` (a stale one drops the frame) and no
 * `from-mode` (a wrong one holds it).
 */

export type SendOutcome = "sent" | "no-session" | "refused" | "error";

export interface SendResult {
  outcome: SendOutcome;
  /** the frame's msg_id, when one was written */
  msgId?: string;
  /** why it was not sent */
  reason?: string;
}

export interface InboxTarget {
  socketPath: string | null;
  token: string | null;
}

/** How long a connection may take, and how long after the write the socket is closed; tests shorten them. */
export const inboxLimits = { connectMs: 2_000, closeAfterMs: 150 };

/** The two lines one send writes: the auth line (when there is a token) and the user frame. */
export function frameText(
  content: string,
  priority: "later" | "next",
  token: string | null,
  msgId: string,
): string {
  const frame = { msgV: 1, msg_id: msgId, type: "user", message: { role: "user", content }, priority };
  return `${token ? `${JSON.stringify({ type: "auth", token })}\n` : ""}${JSON.stringify(frame)}\n`;
}

/** Sends one message; never throws: every failure is an outcome with its reason. */
export function sendToInbox(
  target: InboxTarget,
  content: string,
  priority: "later" | "next",
): Promise<SendResult> {
  if (!target.socketPath)
    return Promise.resolve({
      outcome: "no-session",
      reason: "no messaging socket in this session's environment",
    });
  const msgId = crypto.randomUUID();
  const socketPath = target.socketPath;
  return new Promise<SendResult>((resolve) => {
    let settled = false;
    const done = (r: SendResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let s: ReturnType<typeof createConnection>;
    try {
      s = createConnection({ path: socketPath });
    } catch (e) {
      return done({ outcome: "error", reason: (e as Error).message });
    }
    const timer = setTimeout(() => {
      s.destroy();
      done({ outcome: "error", reason: `no connection within ${inboxLimits.connectMs} ms` });
    }, inboxLimits.connectMs);
    s.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      s.destroy();
      if (e.code === "ENOENT")
        done({ outcome: "no-session", reason: `the session's socket is gone (${socketPath})` });
      else if (e.code === "ECONNREFUSED")
        done({ outcome: "refused", reason: "the session's socket refused it" });
      else done({ outcome: "error", reason: e.code ?? e.message });
    });
    s.on("connect", () => {
      clearTimeout(timer);
      s.write(frameText(content, priority, target.token, msgId), (err) => {
        if (err) {
          s.destroy();
          return done({ outcome: "error", reason: err.message });
        }
        setTimeout(() => {
          s.end();
          done({ outcome: "sent", msgId });
        }, inboxLimits.closeAfterMs);
      });
    });
  });
}
