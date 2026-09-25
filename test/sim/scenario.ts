import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CodexScenario {
  version?: string;
  loggedIn?: boolean;
  models?: unknown;
  eventsFile?: string;
  reply?: string;
  exitCode?: number;
  delayMs?: number;
  hangMs?: number;
  /** `codex login status` sleeps this long before answering */
  loginHangMs?: number;
  /** every invocation appends `{ args, envKeys }` here as one JSON line */
  envTo?: string;
  touch?: { path: string; content: string }[];
  recordTo?: string;
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
