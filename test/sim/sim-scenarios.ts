import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What a simulator saw of one run: argv, the brief on stdin, where it ran and a few env values. */
interface Recorded {
  args: string[];
  stdin: string;
  cwd: string;
  pwd: string | null;
  xdgConfig: string | null;
  /** HOME as the CLI saw it (cursor-agent) */
  home?: string | null;
  /** a few env values the CLI saw, by name (cursor-agent: NO_OPEN_BROWSER, CURSOR_*, CATHERD_*_DIR) */
  vars?: Record<string, string>;
  envKeys: string[];
}

interface Common {
  version?: string;
  eventsFile?: string;
  exitCode?: number;
  delayMs?: number;
  hangMs?: number;
  /** files written before the events, relative to the directory the CLI believes it is in */
  touch?: { path: string; content: string }[];
  recordTo?: string;
}

export interface ClaudeScenario extends Common {
  /** `claude auth status` reports this (default true) */
  loggedIn?: boolean;
  /** flags this "older" CLI does not know */
  unknownFlags?: string[];
  /** refuse bypassPermissions the way claude does under root */
  root?: boolean;
}

export interface OpencodeModel {
  id: string;
  providerID: string;
  variants?: { id: string }[];
  limit?: { context: number };
  capabilities?: { input: string[] };
  enabled?: boolean;
}

export interface OpencodeScenario extends Common {
  /** `opencode auth list --format json` */
  auth?: { id: string; connections: { type: string }[] }[];
  /** `opencode api GET /api/model` data */
  models?: OpencodeModel[];
  /** the model list for a request located in this directory, instead of `models` */
  modelsAt?: Record<string, OpencodeModel[]>;
  /** each model list request appends its location[directory] here, or "-" without one */
  modelLocationsTo?: string;
  /** the first model list after start is empty, as on a service warm-up */
  warmup?: boolean;
  /** `GET /api/session/active` data */
  active?: Record<string, { type: string }>;
  /** `GET /api/session/<id>` data */
  session?: { cost: number; tokens: Record<string, unknown>; outcome: string };
  /** `GET /api/session/<id>/message` data, newest first */
  messages?: unknown[];
  /** `GET /api/session/<id>/message` alone fails with exit 1 and no output */
  messagesFail?: boolean;
  /** every `opencode api` call fails with exit 1 and no output */
  apiFails?: boolean;
  /** every `opencode api` call sleeps this long first */
  apiHangMs?: number;
  /** each interrupted session id is appended here, one per line */
  interruptsTo?: string;
  /** each `opencode reload` appends a line here */
  reloadsTo?: string;
  /** overrides for one `run`, keyed by the exact `-m` value */
  byModel?: Record<string, Omit<OpencodeScenario, "byModel" | "recordTo">>;
}

function write<S extends Common>(envKey: string, s: S) {
  const dir = mkdtempSync(join(tmpdir(), "catherd-sim-"));
  const recordTo = s.recordTo ?? join(dir, "recorded.json");
  const file = join(dir, "scenario.json");
  writeFileSync(file, JSON.stringify({ ...s, recordTo }));
  return {
    file,
    dir,
    env: { [envKey]: file } as Record<string, string>,
    /** Replaces the scenario in place; the next process started reads the new one. */
    rewrite: (next: S) => writeFileSync(file, JSON.stringify({ ...next, recordTo })),
    recorded: (): Recorded => JSON.parse(readFileSync(recordTo, "utf8")) as Recorded,
    ran: (): boolean => existsSync(recordTo),
  };
}

export interface CursorScenario extends Common {
  /** a server call (`models`, `-p`) answers (default true); CURSOR_API_KEY in the env logs it in too */
  loggedIn?: boolean;
  /** what `cursor-agent models` prints: this file's text */
  modelsFile?: string;
  /** the exit code of `models` (default 0) */
  modelsExit?: number;
  /** flags this "older" CLI does not know */
  unknownFlags?: string[];
  /** written to stderr after the events */
  stderr?: string;
  /** "missing": a CLI without the hidden `sandbox` command; else `sandbox run` runs the command */
  sandbox?: "missing";
  /** `sandbox run` refuses any command whose text holds one of these */
  sandboxDeny?: string[];
  /** `sandbox run` appends its arguments here, one JSON line per call */
  sandboxArgsTo?: string;
}

export const withClaudeScenario = (s: ClaudeScenario) => write("CATHERD_SIM_CLAUDE", s);
export const withCursorScenario = (s: CursorScenario) => write("CATHERD_SIM_CURSOR", s);
export const withOpencodeScenario = (s: OpencodeScenario) => write("CATHERD_SIM_OPENCODE", s);
