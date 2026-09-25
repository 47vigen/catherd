import { z } from "zod";

export const ACCESS = ["read-only", "workspace-write", "full"] as const;
export type Access = (typeof ACCESS)[number];

export const RUN_STATUSES = ["ok", "failed", "limit", "cli-too-old", "timeout", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const REPLY_STATUSES = ["complete", "partial", "blocked", "refused"] as const;
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
  replyStatus: z.enum(REPLY_STATUSES).nullable(),
  replyWhy: z.string().nullable(),
  threadHeavy: z.boolean(),
  access: z.enum(ACCESS),
  isolated: z.boolean(),
  images: z.array(z.string()),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  replyPath: z.string(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

const STATUS_LINE = /^STATUS:\s*(complete|partial|blocked|refused)\s*(?:—|–|-)\s*(.*)$/;

/** The role's claim about its own work: the reply's last line, `STATUS: <s> — <why>`. */
export function parseReplyStatus(reply: string): { status: ReplyStatus | null; why: string | null } {
  const last = reply.trimEnd().split("\n").at(-1)?.trim() ?? "";
  const m = STATUS_LINE.exec(last);
  return m ? { status: m[1] as ReplyStatus, why: (m[2] ?? "").trim() } : { status: null, why: null };
}
