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
  touch?: { path: string; content: string }[];
  recordTo?: string;
}

/** PATH with the simulators first. */
export const simPath = (): string => `${import.meta.dir}:${process.env.PATH}`;

export function withScenario(s: CodexScenario) {
  const dir = mkdtempSync(join(tmpdir(), "catherd-sim-"));
  const recordTo = s.recordTo ?? join(dir, "recorded.json");
  const file = join(dir, "scenario.json");
  writeFileSync(file, JSON.stringify({ ...s, recordTo }));
  return {
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
