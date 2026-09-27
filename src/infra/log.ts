import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MIN_SECRET, replaceSecrets, scrubKeyShapes, secretEnvValues } from "../domain/secrets.ts";
import { isPlain } from "../domain/util.ts";
import { logsDir } from "./paths.ts";
import { appendJsonl, ensureJsonlHeader } from "./store.ts";

// Spec §10.2: `<data>/logs/catherd-<date>.jsonl`, 7-day rotation, level from CATHERD_LOG or `--verbose`.

const LEVELS = ["off", "error", "warn", "info", "debug"] as const;
export type Level = Exclude<(typeof LEVELS)[number], "off">;
/** Days of logs kept, today included. */
const KEEP_DAYS = 7;

/** `CATHERD_LOG` (off, error, warn, info, debug); info when unset or unknown. */
function logLevel(): (typeof LEVELS)[number] {
  const v = process.env.CATHERD_LOG?.toLowerCase();
  return (LEVELS as readonly string[]).includes(v ?? "") ? (v as Level) : "info";
}

const rank = (l: string) => LEVELS.indexOf(l as (typeof LEVELS)[number]);

const extra = new Set<string>();
/** A secret that lives outside the env (the saved Jev key): scrubbed from every row from now on. */
export function addSecret(value: string | null | undefined): void {
  if (value && value.length >= MIN_SECRET) extra.add(value);
}

/** Every literal secret a row must not carry: credential-named env values and each added secret. */
export const knownSecrets = (env: Record<string, string | undefined> = process.env): string[] => [
  ...secretEnvValues(env),
  ...extra,
];

/**
 * `v` with every known secret and every key-shaped string replaced by `[redacted]`, in any string at
 * any depth, and every env map (a field named `env`) reduced to its keys.
 */
export function redact<T>(v: T, secrets: string[] = knownSecrets()): T {
  const walk = (x: unknown, key: string | null): unknown => {
    if (typeof x === "string") return scrubKeyShapes(replaceSecrets(x, secrets, "[redacted]"), "[redacted]");
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
export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (rank(level) > rank(logLevel())) return;
  const now = new Date();
  try {
    rotate(now);
    const file = logFile(now);
    ensureJsonlHeader(file, "log");
    appendJsonl(file, redact({ at: now.toISOString(), level, event, pid: process.pid, ...fields }));
  } catch {
    // a full disk or an unwritable data dir costs the log row, never the call
  }
}
