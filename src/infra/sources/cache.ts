import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../../domain/errors.ts";
import { type Derived, DerivedSchema, type SourceId } from "../../domain/sources.ts";
import { tryLock } from "../filelock.ts";
import { log } from "../log.ts";
import { sourcesDir } from "../paths.ts";
import { ensurePrivateDir, readVersioned, writeJsonAtomic, writeTextAtomic } from "../store.ts";

// Spec 1.2 §3.3: `<data>/sources/<source>.json` holds a source's last good answer with its fetch time; a
// failed fetch never touches it. `state.json` holds each source's last attempt and error.

export const cachePath = (id: SourceId): string => join(sourcesDir(), `${id}.json`);

const CachedSchema = z.looseObject({
  schema: z.literal(1),
  source: z.string(),
  fetchedAt: z.iso.datetime(),
  /** the answer as fetched (Epoch: the CSV tables catherd reads out of its zip) */
  data: z.unknown(),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type Cached = z.infer<typeof CachedSchema>;

/** A source's last good answer; null when there is none, or when it cannot be read (the next sync rewrites it). */
export function readCached(id: SourceId): Cached | null {
  const file = cachePath(id);
  if (!existsSync(file)) return null;
  try {
    return readVersioned(file, CachedSchema, 1);
  } catch (e) {
    log("debug", "sources", { source: id, error: errorMessage(e) });
    return null;
  }
}

/** Writes a source's answer atomically (mode 600), compact: models.dev alone is 5 MB. */
export function writeCached(
  id: SourceId,
  data: unknown,
  fetchedAt: number,
  meta: Record<string, unknown> = {},
): Cached {
  const c: Cached = { schema: 1, source: id, fetchedAt: new Date(fetchedAt).toISOString(), data, meta };
  writeTextAtomic(cachePath(id), `${JSON.stringify(c)}\n`);
  return c;
}

const StateSchema = z.looseObject({
  schema: z.literal(1),
  sources: z
    .record(
      z.string(),
      z.looseObject({
        /** when the cached answer was fetched (its TTL runs from here); null before a first success */
        fetchedAt: z.iso.datetime().nullable().default(null),
        lastAttemptAt: z.iso.datetime(),
        error: z.string().nullable(),
        /** Artificial Analysis: `x-ratelimit-remaining` of its last answer */
        rateLimitRemaining: z.number().nullable().default(null),
      }),
    )
    .default({}),
});
export type SyncState = z.infer<typeof StateSchema>;

export const statePath = (): string => join(sourcesDir(), "state.json");

/** Each source's last attempt; empty when never synced or unreadable. */
export function readSyncState(): SyncState {
  const empty: SyncState = { schema: 1, sources: {} };
  if (!existsSync(statePath())) return empty;
  try {
    return readVersioned(statePath(), StateSchema, 1);
  } catch (e) {
    log("debug", "sources", { state: errorMessage(e) });
    return empty;
  }
}

export const writeSyncState = (s: SyncState): void => writeJsonAtomic(statePath(), s);

/** Spec 1.2 §3.2: one sync at a time on this machine. Its release, or null while another live process syncs. */
export function tryLockSync(): (() => void) | null {
  ensurePrivateDir(sourcesDir());
  return tryLock(join(sourcesDir(), "sync"));
}

export const derivedPath = (): string => join(sourcesDir(), "derived.json");
/** Spec 1.2 §4.2: every fit with its R², used or not. */
export const calibrationPath = (): string => join(sourcesDir(), "calibration.json");

let memo: { mtimeMs: number; size: number; file: string; derived: Derived | null } | null = null;

/**
 * What the last sync derived; null when never synced or unreadable (routing then reads the shipped values
 * alone). Read on every catalog load, so it is parsed again only when the file changes.
 */
export function readDerived(): Derived | null {
  const file = derivedPath();
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  if (memo?.file === file && memo.mtimeMs === st.mtimeMs && memo.size === st.size) return memo.derived;
  let derived: Derived | null = null;
  try {
    derived = readVersioned(file, DerivedSchema, 1);
  } catch (e) {
    log("debug", "sources", { derived: errorMessage(e) });
  }
  memo = { file, mtimeMs: st.mtimeMs, size: st.size, derived };
  return derived;
}

/** Writes derived.json and calibration.json atomically. */
export function writeDerived(d: Derived): void {
  memo = null;
  writeTextAtomic(derivedPath(), `${JSON.stringify(d)}\n`);
  writeJsonAtomic(calibrationPath(), { schema: 1, builtAt: d.builtAt, fits: d.fits });
}
