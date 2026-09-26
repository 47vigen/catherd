import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { logsDir } from "./paths.ts";
import { appendJsonl, ensureJsonlHeader } from "./store.ts";

// Spec §10.2: `<data>/logs/catherd-<date>.jsonl`, 7-day rotation, level from CATHERD_LOG or `--verbose`.

export const LEVELS = ["off", "error", "warn", "info", "debug"] as const;
export type Level = Exclude<(typeof LEVELS)[number], "off">;
/** Days of logs kept, today included. */
export const KEEP_DAYS = 7;

/** `CATHERD_LOG` (off, error, warn, info, debug); info when unset or unknown. */
export function logLevel(): (typeof LEVELS)[number] {
  const v = process.env.CATHERD_LOG?.toLowerCase();
  return (LEVELS as readonly string[]).includes(v ?? "") ? (v as Level) : "info";
}

const rank = (l: string) => LEVELS.indexOf(l as (typeof LEVELS)[number]);

/** Env names whose values are secrets: every `*_KEY` and `*_TOKEN`, and a few other shapes. */
const SECRET_NAME = /(_KEY|_TOKEN|_SECRET|_PASSWORD)$/i;
/** A value this short is never scrubbed: it would blank ordinary words. */
const MIN_SECRET = 8;

const extra = new Set<string>();
/** A secret that lives outside the env (the saved Jev key): scrubbed from every row from now on. */
export function addSecret(value: string | null | undefined): void {
  if (value && value.length >= MIN_SECRET) extra.add(value);
}

export function secretValues(env: Record<string, string | undefined> = process.env): string[] {
  const vals = Object.entries(env)
    .filter(([k, v]) => SECRET_NAME.test(k) && v !== undefined && v.length >= MIN_SECRET)
    .map(([, v]) => v as string);
  return [...new Set([...vals, ...extra])].sort((a, b) => b.length - a.length);
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `v` with every known secret replaced by `[redacted]`, in any string at any depth, and every env map
 * (a field named `env`) reduced to its keys.
 */
export function redact<T>(v: T, secrets: string[] = secretValues()): T {
  const walk = (x: unknown, key: string | null): unknown => {
    if (typeof x === "string") return secrets.reduce((s, secret) => s.split(secret).join("[redacted]"), x);
    if (Array.isArray(x)) return x.map((y) => walk(y, null));
    if (isPlain(x)) {
      if (key === "env") return Object.keys(x).sort();
      return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y, k)]));
    }
    return x;
  };
  return walk(v, null) as T;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
export const logFile = (now: Date = new Date()): string => join(logsDir(), `catherd-${day(now)}.jsonl`);

let rotatedOn: string | null = null;
/** Deletes log files from before the last KEEP_DAYS days; once per process per day. */
export function rotate(now: Date = new Date()): void {
  if (rotatedOn === day(now) || !existsSync(logsDir())) return;
  rotatedOn = day(now);
  const oldest = day(new Date(now.getTime() - (KEEP_DAYS - 1) * 86_400_000));
  for (const f of readdirSync(logsDir())) {
    const m = /^catherd-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
    if (m && (m[1] as string) < oldest) rmSync(join(logsDir(), f), { force: true });
  }
}

/** Tests only: rotate again on the next write. */
export const resetRotation = (): void => {
  rotatedOn = null;
};

/** One redacted JSONL row. Never throws: logging must not fail the work it records. */
export function log(
  level: Level,
  event: string,
  fields: Record<string, unknown> = {},
  now: Date = new Date(),
): void {
  if (rank(level) > rank(logLevel())) return;
  try {
    rotate(now);
    const file = logFile(now);
    ensureJsonlHeader(file, "log");
    appendJsonl(file, redact({ at: now.toISOString(), level, event, pid: process.pid, ...fields }));
  } catch {
    // a full disk or an unwritable data dir costs the log row, never the call
  }
}
