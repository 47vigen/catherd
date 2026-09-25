import type { ErrorCode } from "../domain/errors.ts";
import type { Rung } from "../domain/ids.ts";
import type { Access, ExitInfo, RunStatus, Tokens } from "../domain/record.ts";

export type { ExitInfo, ExitReason } from "../domain/record.ts";

export const ADAPTER_IDS = ["codex", "claude-code", "opencode", "cursor", "grok"] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];

export interface Probe {
  installed: boolean;
  version: string | null;
  versionOk: boolean;
  /** null when the CLI offers no way to ask */
  loggedIn: boolean | null;
  problems: { code: ErrorCode; message: string; fix: string }[];
}

export interface DiscoveredModel {
  id: string;
  efforts: string[];
  context: number | null;
  imageIn: boolean;
}

export interface RunRequest {
  rung: Rung;
  access: Access;
  thread: string | null;
  isolated: boolean;
  repo: string;
  briefPath: string;
  replyPath: string;
  dispatchDir: string;
}

/**
 * `env` holds only the adapter's overrides. The caller builds the worker's env with
 * `workerEnv(process.env, plan.env, plan.cwd)`, the only place secrets are scrubbed and PWD is set;
 * the supervisor passes the env it is given unchanged.
 */
export interface SpawnPlan {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdinPath: string | null;
}

export interface EventDelta {
  thread?: string;
  tokens?: Tokens;
  costUsd?: number;
  lastEvent?: string;
  failure?: string;
  limit?: boolean;
  tooOld?: boolean;
  retrying?: boolean;
  /** the stream's terminal event: the supervisor may kill a CLI that lingers after it */
  final?: boolean;
}

export interface FinishedRun {
  request: RunRequest;
  eventLines: string[];
  reply: string;
  stderr: string;
  exit: ExitInfo;
  startedAtMs: number;
}

export interface Outcome {
  status: RunStatus;
  thread: string | null;
  tokens: Tokens;
  costUsd: number | null;
  images: string[];
  error: { code: string; message: string } | null;
}

export interface BackendAdapter {
  id: AdapterId;
  minVersion: string;
  probe(): Promise<Probe>;
  listModels(): Promise<DiscoveredModel[]>;
  plan(req: RunRequest): SpawnPlan;
  parse(line: string): EventDelta;
  finalize(run: FinishedRun): Outcome;
  enforcement: Record<Access, "enforced" | "advisory">;
  errors: { limit: RegExp[]; tooOld: RegExp[] };
  resume: { supported: boolean; sameAccessOnly: boolean; threadPattern: RegExp };
  interrupt?(thread: string, cwd: string): Promise<void>;
  isBusy?(thread: string, cwd: string): Promise<boolean>;
  graceAfterFinalMs: number | null;
}

export function extractVersion(s: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(s)?.[0] ?? null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
