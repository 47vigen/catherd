import type { ErrorCode } from "../domain/errors.ts";
import type { ADAPTER_IDS, Rung } from "../domain/ids.ts";
import type { BillingMode } from "../domain/cost.ts";
import type { Access, ExitInfo, RunStatus, Tokens } from "../domain/record.ts";
import type { CliResult } from "./cli.ts";
type AdapterId = (typeof ADAPTER_IDS)[number];

export interface Probe {
  installed: boolean;
  version: string | null;
  versionOk: boolean;
  /** null when the CLI offers no way to ask */
  loggedIn: boolean | null;
  /** how the CLI is logged in, in a word or two ("ChatGPT", "API key"), when it says */
  login?: string;
  /** the billing mode that login implies, when it implies one: doctor compares it with the profiles' */
  billing?: BillingMode;
  problems: { code: ErrorCode; message: string; fix: string }[];
}

/** A worker's shell for doctor's probes: `run` is `sh -c <script> _ <args…>`; `close` removes its scratch dir. */
export interface AccessShell {
  /** how it runs, for the doctor rows: "codex sandbox", "an unsandboxed shell" */
  how: string;
  run(script: string, args: string[]): Promise<CliResult | null>;
  close(): void;
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
  /** spec §5: a workspace-write role's network and loopback grants; false only when the profile says `network: false` */
  network?: boolean;
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
  /** the input tokens of one model request, from an event that reports them per request (the harness cost) */
  requestInput?: number;
  costUsd?: number;
  lastEvent?: string;
  /**
   * what the worker is doing, in words, when the line says (spec §3.7 `peek`): a command (`$ bun test`), a file
   * edit (`edit src/a.ts`) or a message line
   */
  activity?: string;
  failure?: string;
  limit?: boolean;
  tooOld?: boolean;
  retrying?: boolean;
  /** the stream's terminal event: the supervisor may kill a CLI that lingers after it */
  final?: boolean;
  /** a tool call starting (`open`) or ending: while one is open the run is busy, however quiet */
  item?: { id: string; open: boolean };
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
  /** `sinceMs`: when this run started, so what an earlier run on the thread left behind does not count */
  isBusy?(thread: string, cwd: string, sinceMs?: number): Promise<boolean>;
  /** Spec §4.5: this backend's own stand-in for a rung on a usage limit, when the profile names none. */
  failoverFor?(rung: Rung, repo?: string): Rung | null;
  /**
   * Spec §5 and §12: a shell that runs a command the way this backend's workspace-write worker runs one,
   * with the grants the worker gets, for doctor's access probes; a string says why it cannot be tested here.
   */
  accessShell?(o: { network: boolean }): Promise<AccessShell | string>;
  /** Spec §10.3: why this backend's isolation is weak; doctor warns when a profile uses it. */
  isolationNote?: string;
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
