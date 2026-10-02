import { z } from "zod";

export const ACCESS = ["read-only", "workspace-write", "full"] as const;
export type Access = (typeof ACCESS)[number];

const RUN_STATUSES = ["ok", "failed", "limit", "cli-too-old", "timeout", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** plan 23: `flaky`, a worker's word for a check that failed, then passed when run alone */
const REPLY_STATUSES = ["complete", "partial", "blocked", "refused", "flaky"] as const;
export type ReplyStatus = (typeof REPLY_STATUSES)[number];

export interface Tokens {
  input: number;
  cached: number;
  output: number;
}
export const ZERO_TOKENS: Readonly<Tokens> = Object.freeze({ input: 0, cached: 0, output: 0 });

/** Spec §7: a thread past this many input tokens is spent; its next piece starts fresh. */
export const THREAD_HEAVY_INPUT = 8_000_000;

/** How a supervised worker ended, as the supervisor records it in exit.json. */
export const EXIT_REASONS = [
  "exited",
  "after-final",
  "idle-timeout",
  "wall-timeout",
  "cancelled",
  "lost",
  /** plan 23: the provider kept failing (retries with no progress); failover treats it as a usage limit */
  "provider-unavailable",
] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];
export interface ExitInfo {
  code: number | null;
  signal: string | null;
  reason: ExitReason;
  endedAt: string;
}

const TokensSchema = z.object({ input: z.number(), cached: z.number(), output: z.number() });

export const RunRecordSchema = z.looseObject({
  schema: z.literal(1),
  runId: z.string(),
  dispatchId: z.string(),
  name: z.string(),
  role: z.string(),
  lane: z.string().nullable(),
  backend: z.string(),
  rung: z.string(),
  attempt: z.number().int().min(1),
  failoverFrom: z.string().nullable(),
  thread: z.string().nullable(),
  status: z.enum(RUN_STATUSES),
  startedAt: z.string(),
  endedAt: z.string(),
  secs: z.number(),
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  cliVersion: z.string().nullable(),
  tokens: TokensSchema,
  costUsd: z.number().nullable(),
  changedOwned: z.array(z.string()),
  violations: z.array(z.string()),
  /** true when git failed at finalize: changedOwned and violations are then unknown, not empty */
  gitUnavailable: z.boolean().optional(),
  replyStatus: z.enum(REPLY_STATUSES).nullable(),
  replyWhy: z.string().nullable(),
  /** plan 23: the reply's ENV: line, when the environment stopped the role; absent otherwise */
  environment: z.string().optional(),
  threadHeavy: z.boolean(),
  access: z.enum(ACCESS),
  isolated: z.boolean(),
  /** the role's network grant (1.1 §5) it ran under, copied from admit.json; absent before 1.3 */
  network: z.boolean().optional(),
  images: z.array(z.string()),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  replyPath: z.string(),
  /** the Claude Code session that dispatched it, copied from admit.json (spec §3.3); absent before 1.1 */
  sessionId: z.string().optional(),
  host: z.enum(["claude-code", "codex"]).optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

const STATUS_LINE = /^STATUS:\s*(complete|partial|blocked|refused|flaky)\s*(?:—|–|-)\s*(.*)$/;

/**
 * Plan 23: what stopped the role, when the environment did: an `ENV: <what>` line of its reply (a VPN, no
 * Docker, a dead registry); null without one.
 */
export function parseReplyEnvironment(reply: string): string | null {
  const m = /^[ \t]*ENV:[ \t]*(\S.*?)[ \t]*$/m.exec(reply);
  return m ? (m[1] as string) : null;
}

/** The role's claim about its own work: the reply's last line, `STATUS: <s> — <why>`. */
export function parseReplyStatus(reply: string): { status: ReplyStatus | null; why: string | null } {
  const last = reply.trimEnd().split("\n").at(-1)?.trim() ?? "";
  const m = STATUS_LINE.exec(last);
  return m ? { status: m[1] as ReplyStatus, why: (m[2] ?? "").trim() } : { status: null, why: null };
}
