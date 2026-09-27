import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, sep } from "node:path";
import { z } from "zod";
import { CatherdError, UPGRADE } from "../domain/errors.ts";
import { configDir, dataDir } from "./paths.ts";

// Audit S2: catherd's dirs hold briefs, argv, stderr tails and logs, so they are 0700 and its files 0600.
export const PRIVATE_DIR = 0o700;
export const PRIVATE_FILE = 0o600;

const tightened = new Set<string>();
/** Once per process per dir: `dir` at 0700, if an older catherd left it open to others. */
function tighten(dir: string): void {
  if (tightened.has(dir)) return;
  tightened.add(dir);
  try {
    if (statSync(dir).mode & 0o077) chmodSync(dir, PRIVATE_DIR);
  } catch {
    // not ours to fix (another owner, a read-only mount): the files inside are still 0600
  }
}

/**
 * `dir` and any missing parent, created 0700. `mkdirSync` leaves an existing dir as it is, so under
 * catherd's config or data dir, `dir` and every dir up to that root are tightened to 0700 (a 0.x install).
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
  for (const root of [configDir(), dataDir()]) {
    if (dir !== root && !dir.startsWith(root + sep)) continue;
    for (let d = dir; d.length >= root.length; d = dirname(d)) {
      tighten(d);
      if (d === root) break;
    }
  }
}

/** `file` at 0600 when it exists and others may read it: a file another program wrote into catherd's dirs. */
export function makePrivate(file: string): void {
  try {
    if (statSync(file).mode & 0o077) chmodSync(file, PRIVATE_FILE);
  } catch {
    // missing, or not ours: its dir is 0700 all the same
  }
}

/** `mode` (0600 by default) is the file's exact permission bits (umask aside), set before any byte is written. */
export function writeTextAtomic(file: string, text: string, o: { mode?: number } = {}): void {
  const mode = o.mode ?? PRIVATE_FILE;
  ensurePrivateDir(dirname(file));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = openSync(tmp, "w", mode);
  try {
    fchmodSync(fd, mode);
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export const writeJsonAtomic = (file: string, value: unknown, o: { mode?: number } = {}): void =>
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`, o);

function newer(file: string, found: number, current: number): CatherdError {
  return new CatherdError(
    "E_CONFIG_NEWER_SCHEMA",
    `${file} has schema ${found}, newer than this catherd (${current})`,
    {
      fix: `upgrade catherd: ${UPGRADE}`,
    },
  );
}

/**
 * The parsed content of a JSON file catherd keeps. The error never carries the parser's message: it
 * quotes the offending text, which for a key pasted into credentials.json is the key itself (audit B1).
 */
export function readJsonFile(file: string, fix = `fix or delete ${file}`): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "an I/O error";
    throw new CatherdError("E_CONFIG_INVALID", `${file} cannot be read (${code})`, { fix });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CatherdError("E_CONFIG_INVALID", `${file} is not valid JSON`, { fix });
  }
}

/**
 * Reads a `"schema": n` JSON file. Schemas are loose objects, so unknown fields survive a rewrite.
 * `fix` replaces the default fix of an unreadable or invalid file.
 */
export function readVersioned<T>(
  file: string,
  schema: z.ZodType<T>,
  current: number,
  o: { fix?: string } = {},
): T {
  const fix = o.fix ?? `fix or delete ${file}`;
  const raw = readJsonFile(file, fix);
  const found = (raw as { schema?: unknown } | null)?.schema;
  if (typeof found === "number" && found > current) throw newer(file, found, current);
  const r = schema.safeParse(raw);
  if (!r.success)
    throw new CatherdError("E_CONFIG_INVALID", `${file} is invalid:\n${z.prettifyError(r.error)}`, { fix });
  return r.data;
}

/** True when `file` exists, is non-empty and does not end in a newline (a crash-truncated tail). */
function endsMidLine(file: string): boolean {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return false;
  }
  if (size === 0) return false;
  const fd = openSync(file, "r");
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

/**
 * One `appendFileSync` per row, so a crash can only ever truncate the last line. A truncated
 * tail left by an earlier crash is ended first, in the same write, so the new row stays whole.
 */
export function appendJsonl(file: string, value: unknown): void {
  ensurePrivateDir(dirname(file));
  const prefix = endsMidLine(file) ? "\n" : "";
  appendPrivate(file, `${prefix}${JSON.stringify(value)}\n`);
}

const madePrivate = new Set<string>();
/**
 * Appends `text` to `file`, created 0600. `appendFileSync`'s mode only applies to a new file, so one
 * an older catherd left open to others is tightened first, once per process.
 */
export function appendPrivate(file: string, text: string): void {
  ensurePrivateDir(dirname(file));
  if (!madePrivate.has(file)) {
    makePrivate(file);
    madePrivate.add(file);
  }
  appendFileSync(file, text, { mode: PRIVATE_FILE });
}

export function ensureJsonlHeader(file: string, kind: string): void {
  ensurePrivateDir(dirname(file));
  try {
    // O_APPEND: a row another process appends between the create and this write is kept, not overwritten
    const fd = openSync(file, "ax", PRIVATE_FILE);
    try {
      writeSync(fd, `${JSON.stringify({ schema: 1, kind })}\n`);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

const isHeader = (v: unknown): v is { schema: number; kind: string } =>
  typeof v === "object" &&
  v !== null &&
  Object.keys(v).length === 2 &&
  typeof (v as { schema?: unknown }).schema === "number" &&
  typeof (v as { kind?: unknown }).kind === "string";

/** The non-blank lines of `file`; none when it cannot be read (missing, or not written yet). */
export function nonBlankLines(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter((l) => l.trim());
}

export function readJsonl<T>(file: string, current = 1): { kind: string | null; rows: T[]; corrupt: number } {
  if (!existsSync(file)) return { kind: null, rows: [], corrupt: 0 };
  const rows: T[] = [];
  let kind: string | null = null;
  let corrupt = 0;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line) => {
    if (!line.trim()) return;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      corrupt++;
      return;
    }
    // the header is first unless another writer's row won the race to a new file (ensureJsonlHeader)
    if (kind === null && isHeader(v)) {
      if (v.schema > current) throw newer(file, v.schema, current);
      kind = v.kind;
      return;
    }
    rows.push(v as T);
  });
  return { kind, rows, corrupt };
}
