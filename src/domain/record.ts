import { z } from "zod";

export const ACCESS = ["read-only", "workspace-write", "full"] as const;
export type Access = (typeof ACCESS)[number];

export const RUN_STATUSES = ["ok", "failed", "limit", "cli-too-old", "timeout", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** plan 23: `flaky`, a worker's word for a check that failed, then passed when run alone */
export const REPLY_STATUSES = ["complete", "partial", "blocked", "refused", "flaky"] as const;
export type ReplyStatus = (typeof REPLY_STATUSES)[number];

export interface Tokens {
  input: number;
  cached: number;
  output: number;
  cacheWrite?: number;
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

const TokensSchema = z.object({
  input: z.number(),
  cached: z.number(),
  output: z.number(),
  cacheWrite: z.number().optional(),
});

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
  /** a lane's changes to test files its Owns does not cover, a running sibling's included (B14); absent before 2.0 */
  /** true when git failed at finalize: changedOwned and violations are then unknown, not empty */
  gitUnavailable: z.boolean().optional(),
  replyStatus: z.enum(REPLY_STATUSES).nullable(),
  replyWhy: z.string().nullable(),
  /** plan 23: the reply's ENV: line, when the environment stopped the role; absent otherwise */
  environment: z.string().optional(),
  /** a verifier's `HEAD: <sha>` line: the commit it checked (lower-case hex, 7-64 characters) */
  head: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  /** a worker's `EXTRA: <path> — <why>` lines: files outside its lane it had to change */
  extras: z.array(z.object({ path: z.string(), why: z.string() })).optional(),
  /** a fix-round worker's `REJECTED: <finding> — <why>` lines */
  rejected: z.array(z.object({ finding: z.string(), why: z.string() })).optional(),
  /** a worker's `DESIGN:` lines: where its plan task conflicts with the code */
  design: z.array(z.string()).optional(),
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

const STATUS_LINE =
  /^(?:[-*]\s+)?\**STATUS\**:\**\s*(complete|partial|blocked|refused|flaky)\b\.?\**\s*(?:(?:—|–|-)\s*(.*))?$/;

/**
 * Plan 23: what stopped the role, when the environment did: an `ENV: <what>` line of its reply (a VPN, no
 * Docker, a dead registry); null without one.
 */
export function parseReplyEnvironment(reply: string): string | null {
  for (const line of unfencedLines(reply)) {
    const m = /^[ \t]*ENV:[ \t]*(\S.*?)[ \t]*$/.exec(line);
    if (m) return m[1] as string;
  }
  return null;
}

/** The role's claim about its own work: the reply's last `STATUS: <s> — <why>` line outside code fences. */
export function parseReplyStatus(reply: string): { status: ReplyStatus | null; why: string | null } {
  let m: RegExpExecArray | null = null;
  for (const line of unfencedLines(reply)) m = STATUS_LINE.exec(line.trim()) ?? m;
  return m ? { status: m[1] as ReplyStatus, why: (m[2] ?? "").trim() } : { status: null, why: null };
}

/** The reply's lines outside ``` and ~~~ code fences. */
function unfencedLines(reply: string): string[] {
  let fence: string | null = null;
  const lines: string[] = [];
  for (const line of reply.split("\n")) {
    const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    const marker = match?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && match?.[2]?.trim() === "") {
        fence = null;
      }
    } else if (marker) fence = marker;
    else lines.push(line);
  }
  return lines;
}

/** The last `HEAD: <hex>` line of a reply outside code fences, lower-cased: the commit a verifier says it checked. */
export function parseReplyHead(reply: string): string | null {
  let head: string | null = null;
  for (const line of unfencedLines(reply)) {
    const m = /^[ \t]*HEAD:[ \t]*([0-9a-fA-F]{7,64})[ \t]*$/.exec(line);
    if (m) head = (m[1] as string).toLowerCase();
  }
  return head;
}

/** `<LABEL>: <a> — <b>` lines (optional bullet; separator: first `—`, else first `–` or `-`, with whitespace around it). */
function labelled(reply: string, label: string): [string, string][] {
  const re = new RegExp(`^[ \\t]*(?:[-*][ \\t]*)?${label}:[ \\t]*(\\S.*?)[ \\t]*$`, "gm");
  return [...reply.matchAll(re)].map((m) => {
    const body = m[1] as string;
    // The contracts ask for an em dash: a hyphen in the first field survives when the line has one.
    const sep = /[ \t]+—[ \t]+/.exec(body) ?? /[ \t]+[–-][ \t]+/.exec(body);
    return sep ? [body.slice(0, sep.index), body.slice(sep.index + sep[0].length)] : [body, ""];
  });
}

/** Every `EXTRA: <path> — <why>` line: a file outside the lane the worker had to change. */
export function parseReplyExtras(reply: string): { path: string; why: string }[] {
  return labelled(reply, "EXTRA").map(([path, why]) => ({ path: path.replace(/`/g, ""), why }));
}

/** Every `REJECTED: <finding> — <why>` line of a fix round. */
export function parseReplyRejections(reply: string): { finding: string; why: string }[] {
  return labelled(reply, "REJECTED").map(([finding, why]) => ({ finding, why }));
}

/** The trimmed value of every `DESIGN:` line: a conflict between a plan task and the code. */
export function parseReplyDesign(reply: string): string[] {
  return [...reply.matchAll(/^[ \t]*(?:[-*][ \t]*)?DESIGN:[ \t]*(\S.*?)[ \t]*$/gm)].map(
    (m) => m[1] as string,
  );
}
