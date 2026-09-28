import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envelope } from "../domain/notice.ts";
import { readSessionEnv, sessionFileFor } from "../infra/claude-session.ts";
import { claudeHome } from "../infra/paths.ts";
import { sendToInbox } from "../infra/peer-inbox.ts";
import type { Check } from "./doctor-checks.ts";

/**
 * Spec §3.9 `doctor`'s `push` row: run from inside a Claude Code session (its Bash tool), send that session one
 * `later` message and look for the enqueue line its transcript gets when the message is accepted
 * (docs/research/2026-09-28-cross-session-messaging.md §7).
 */

export type PushOutcome = "ok" | "no-session" | "held" | "unconfirmed" | "failed";

export interface PushProbe {
  outcome: PushOutcome;
  detail: string;
}

/** How long the probe looks for the enqueue line; tests shorten it. */
export const pushLimits = { waitMs: 5_000, pollMs: 100 };

/** The session's transcript, found by globbing `projects/*` (a git worktree logs under its main checkout's slug). */
function transcriptOf(sessionId: string): string | null {
  const projects = join(claudeHome(), "projects");
  if (!existsSync(projects)) return null;
  for (const d of readdirSync(projects)) {
    const f = join(projects, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

const enqueued = (file: string, nonce: string): boolean => {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .some((l) => l.includes('"operation":"enqueue"') && l.includes(nonce));
  } catch {
    return false;
  }
};

export async function probePush(env: Record<string, string | undefined> = process.env): Promise<PushProbe> {
  const s = readSessionEnv(env);
  if (!s?.socketPath)
    return { outcome: "no-session", detail: "run catherd doctor from a Claude Code session to test push" };
  const sessionId = sessionFileFor(s)?.sessionId ?? s.sessionId;
  const nonce = crypto.randomUUID().slice(0, 8);
  const r = await sendToInbox(s, envelope(`catherd doctor: push test ${nonce}, no action needed`), "later");
  // a socket that is gone or refuses is a shell that outlived its session, not a protocol change
  if (r.outcome === "no-session" || r.outcome === "refused")
    return {
      outcome: "no-session",
      detail: `this session's inbox is not reachable (${r.reason ?? r.outcome}); run catherd doctor from a live Claude Code session to test push`,
    };
  if (r.outcome !== "sent")
    return {
      outcome: "failed",
      detail: `catherd cannot notify this Claude Code version; peek still works (${r.reason ?? r.outcome})`,
    };
  const deadline = Date.now() + pushLimits.waitMs;
  let file: string | null = null;
  for (;;) {
    file = sessionId ? transcriptOf(sessionId) : null;
    if (file && enqueued(file, nonce))
      return { outcome: "ok", detail: "a test message reached this session" };
    if (Date.now() > deadline) break;
    await Bun.sleep(pushLimits.pollMs);
  }
  return file
    ? {
        outcome: "held",
        detail: `the test message was sent but not accepted within ${pushLimits.waitMs / 1000} s: a crossSessionInbound setting holds or refuses it`,
      }
    : {
        outcome: "unconfirmed",
        detail: "sent; no transcript of this session was found to confirm it arrived",
      };
}

/** The probe as a `doctor` row. */
export function pushCheck(p: PushProbe): Check {
  const base = { id: "push", label: "push to Claude Code", detail: p.detail };
  switch (p.outcome) {
    case "ok":
      return { ...base, state: "ok", word: "ready" };
    case "no-session":
      return { ...base, state: "skip", word: "no session" };
    case "held":
      return {
        ...base,
        state: "warn",
        word: "held",
        fix: `set "crossSessionInbound": "accept" in ${join(claudeHome(), "settings.json")}, or remove a project setting that sets it to hold or refuse`,
      };
    case "unconfirmed":
      return { ...base, state: "warn", word: "not confirmed" };
    case "failed":
      return {
        ...base,
        state: "fail",
        word: "failed",
        fix: "update catherd (and Claude Code); meanwhile peek(run) shows each role and each unread record",
      };
  }
}
