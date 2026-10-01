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
