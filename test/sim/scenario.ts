import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CodexScenario {
  version?: string;
  loggedIn?: boolean;
  /** how `codex login status` says it is logged in (default ChatGPT) */
  login?: "chatgpt" | "api-key";
  models?: unknown;
  eventsFile?: string;
  reply?: string;
  exitCode?: number;
  delayMs?: number;
  hangMs?: number;
  /** after its output, `exec` waits until this file exists, then exits */
  holdUntil?: string;
  /** `codex login status` sleeps this long before answering */
  loginHangMs?: number;
  /** every invocation appends `{ args, envKeys }` here as one JSON line */
  envTo?: string;
  touch?: { path: string; content: string }[];
  recordTo?: string;
  /** `codex sandbox`: "allow" runs the command, "deny" refuses any write; unset, codex has no such command */
  sandbox?: "allow" | "deny";
  /** which `codex sandbox` syntax this Codex knows: "current" (default) or the old `<os> --full-auto` one */
  sandboxForm?: "current" | "old";
  /** `codex sandbox` fails any command whose text holds one of these */
  sandboxDeny?: string[];
  /** `codex sandbox` appends its arguments here, one JSON line per call */
  sandboxArgsTo?: string;
  /** overrides for one rung of an `exec`, keyed `model#effort` (`default` when no effort flag is passed) */
  byRung?: Record<string, Omit<CodexScenario, "byRung" | "recordTo">>;
}

/** PATH with the simulators first. */
export const simPath = (): string => `${import.meta.dir}:${process.env.PATH}`;

export function withScenario(s: CodexScenario) {
  const dir = mkdtempSync(join(tmpdir(), "catherd-sim-"));
  const recordTo = s.recordTo ?? join(dir, "recorded.json");
  const file = join(dir, "scenario.json");
  writeFileSync(file, JSON.stringify({ ...s, recordTo }));
  return {
    file,
    /** Replaces the scenario in place; the next codex process started reads the new one. */
    rewrite: (next: CodexScenario) => writeFileSync(file, JSON.stringify({ ...next, recordTo })),
    env: { CATHERD_SIM_SCENARIO: file },
    recorded: () =>
      JSON.parse(readFileSync(recordTo, "utf8")) as {
        args: string[];
        stdin: string;
        cwd: string;
        pwd: string | null;
        codexHome: string | null;
      },
  };
}
