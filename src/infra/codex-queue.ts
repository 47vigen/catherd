import type { HostSessionRef } from "../domain/host.ts";
import { runCli } from "./cli.ts";
import { scrubSecrets } from "./env.ts";

export interface QueueCapability {
  cli: boolean;
  server: "supported" | "unsupported" | "unverified";
  reason: string | null;
}
export type QueueSendResult =
  | { outcome: "accepted"; msgId: string }
  | { outcome: "not-submitted"; reason: string }
  | { outcome: "ambiguous"; reason: string };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const uuid = new RegExp(`^${UUID}$`, "i");
const receipt = new RegExp(`^Queued message (${UUID}) for thread (${UUID})\\.$`);
const TIMEOUT_MS = 10000;

export async function queueCapability(
  env: Record<string, string | undefined>,
  run: typeof runCli = runCli,
): Promise<QueueCapability> {
  try {
    const help = await run("codex", ["queue", "--help"], {
      timeoutMs: TIMEOUT_MS,
      env: scrubSecrets({ ...process.env, ...env }),
    });
    if (
      !help?.ok ||
      !/\bqueue\b/.test(help.out) ||
      !["--thread", "--message", "--remote"].every((flag) => new RegExp(`${flag}\\s`).test(help.out))
    )
      return {
        cli: false,
        server: "unverified",
        reason: "Native codex queue with --remote is unavailable; update Codex and use peek/result.",
      };
    return {
      cli: true,
      server: "unverified",
      reason: "Native server queue method enumeration is unavailable; help proves CLI support only.",
    };
  } catch {
    return {
      cli: false,
      server: "unverified",
      reason: "Could not inspect native codex queue; use peek/result.",
    };
  }
}

export async function sendToCodexQueue(
  target: HostSessionRef,
  content: string,
  env: Record<string, string | undefined>,
  run: typeof runCli = runCli,
): Promise<QueueSendResult> {
  if (target.host !== "codex" || target.sessionId.length !== 36 || !uuid.test(target.sessionId))
    return {
      outcome: "not-submitted",
      reason: "Queue requires a validated original Codex thread UUID; use peek/result.",
    };
  if (!content.trim()) return { outcome: "not-submitted", reason: "Queue message is empty." };
  const capability = await queueCapability(env, run);
  if (!capability.cli || capability.server === "unsupported")
    return {
      outcome: "not-submitted",
      reason: capability.reason ?? "Native queue is unavailable; use peek/result.",
    };
  try {
    const args = ["queue", "--remote", "unix://", "--thread", target.sessionId, "--message", content];
    const result = await run("codex", args, {
      timeoutMs: TIMEOUT_MS,
      env: scrubSecrets({ ...process.env, ...env }),
      logArgs: [...args.slice(0, -1), "[redacted]"],
    });
    if (result === null)
      return { outcome: "not-submitted", reason: "Codex executable is unavailable; use peek/result." };
    const match = result.ok ? receipt.exec(result.out.trim()) : null;
    if (match && match[2]?.toLowerCase() === target.sessionId.toLowerCase())
      return { outcome: "accepted", msgId: match[1]! };
    if (
      !result.ok &&
      !result.out.trim() &&
      (/^Error: the remote app server does not support thread\/queue\/add; update or restart the remote app server(?:\n|$)/.test(
        result.err,
      ) ||
        /^error: (?:unrecognized subcommand 'queue'|unexpected argument '--remote' found)(?:\n|$)/.test(
          result.err,
        ) ||
        /^Error: failed to connect to remote app server at `unix:\/\/[^`\n]+`: [^\n]+(?:\n|$)/.test(
          result.err,
        ))
    )
      return {
        outcome: "not-submitted",
        reason:
          "Native queue refused before submission; check CLI/server support and the existing native endpoint, then use peek/result.",
      };
    return {
      outcome: "ambiguous",
      reason:
        "Native queue invocation has no verified receipt; use peek/result. Retrying may duplicate input.",
    };
  } catch {
    return {
      outcome: "ambiguous",
      reason:
        "Native queue invocation failed without a verified receipt; use peek/result. Retrying may duplicate input.",
    };
  }
}
