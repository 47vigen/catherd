import { CatherdError } from "../domain/errors.ts";
import type { HostContext } from "../domain/host.ts";
import { resolveHost } from "../infra/host-context.ts";

export const HOST_ARG = {
  host: {
    type: "enum" as const,
    options: ["auto", "codex", "claude-code"],
    description: "orchestration host (auto uses session evidence)",
  },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Plan 22, `doctor --test-push --thread <uuid>`: Codex does not export its thread id to the commands it runs, so a
 * shell names the thread the smoke goes to. It makes the host that Codex thread; a Claude Code session refuses it.
 */
export function withThread(host: HostContext, thread: string | undefined): HostContext {
  if (thread === undefined) return host;
  if (!UUID.test(thread))
    throw new CatherdError("E_INPUT_INVALID", `--thread ${thread} is not a Codex thread id`, {
      fix: "pass the thread's UUID, as the first line of a catherd message names it (thread: <uuid>)",
    });
  if (host.host === "claude-code")
    throw new CatherdError(
      "E_INPUT_INVALID",
      "--thread names a Codex thread, and this is a Claude Code session",
      {
        fix: "run catherd doctor --test-push without --thread from Claude Code",
      },
    );
  const sessionId = thread.toLowerCase();
  return {
    host: "codex",
    session: { host: "codex", sessionId, hostSessionId: null, name: null },
    conflict: null,
  };
}

export function terminalHost(value: string | undefined, env = process.env): HostContext {
  if (value === undefined || value === "auto") return resolveHost({ env });
  if (value !== "codex" && value !== "claude-code")
    throw new CatherdError("E_INPUT_INVALID", `unknown host ${value}`, {
      fix: "use --host auto, codex or claude-code",
    });
  const resolved = resolveHost({ env, terminalHost: value });
  if (resolved.conflict) return resolved;
  if (resolved.host !== value)
    return {
      host: "unknown",
      session: null,
      conflict: "Terminal host and launcher session evidence disagree; remove the other host’s environment",
    };
  return { ...resolved, session: null };
}
