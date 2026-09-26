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
 * `env` holds only the adapter's overrides, never PWD. Admission writes them to spec.json with PWD added
 * and nothing else, so no credential reaches disk; the `_supervise` process builds the worker's env at
 * spawn time with `workerEnv(process.env, spec.env, spec.cwd)`, the only place secrets are scrubbed.
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
  /** The role's reply, for a CLI that streams it rather than writing the reply file (absent: the file is the reply). */
  reply?: string;
}

/** What earlier records on the same thread already counted, so a session total becomes this run's share. */
export interface Spent {
  tokens: Tokens;
  costUsd: number;
}

export interface BackendAdapter {
  id: AdapterId;
  minVersion: string;
  probe(): Promise<Probe>;
  /** The models the backend offers; in `repo` when given, for a backend whose listing depends on it. */
  listModels(repo?: string): Promise<DiscoveredModel[]>;
  /**
   * Refuses a rung this backend cannot run and readies the backend's own config, before admission writes
   * anything (spec §6.3: variants are validated before dispatch). Throws a CatherdError.
   */
  prepare?(req: { rung: Rung; access: Access; isolated: boolean; repo: string }): Promise<void>;
  plan(req: RunRequest): SpawnPlan;
  parse(line: string): EventDelta;
  finalize(run: FinishedRun): Outcome;
  /**
   * Spec §6.3: the backend's own account of a finished session, for a stream that undercounts. Returns
   * `o` refined; never throws (the caller also cuts it off after a timeout and keeps `o`).
   */
  settle?(o: Outcome, run: FinishedRun, prior: Spent): Promise<Outcome>;
  enforcement: Record<Access, "enforced" | "advisory">;
  errors: { limit: RegExp[]; tooOld: RegExp[] };
  resume: { supported: boolean; sameAccessOnly: boolean; threadPattern: RegExp };
  interrupt?(thread: string, cwd: string): Promise<void>;
  isBusy?(thread: string, cwd: string): Promise<boolean>;
  /** Spec §4.5: this backend's own stand-in for a rung on a usage limit, when the profile names none. */
  failoverFor?(rung: Rung, repo?: string): Rung | null;
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
