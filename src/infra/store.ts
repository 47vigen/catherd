import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { CatherdError } from "../domain/errors.ts";

export function writeTextAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export const writeJsonAtomic = (file: string, value: unknown): void =>
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

function newer(file: string, found: number, current: number): CatherdError {
  return new CatherdError(
    "E_CONFIG_NEWER_SCHEMA",
    `${file} has schema ${found}, newer than this catherd (${current})`,
    {
      fix: "upgrade catherd: bunx catherd-cli@latest",
    },
  );
}

/** Reads a `"schema": n` JSON file. Schemas are loose objects, so unknown fields survive a rewrite. */
export function readVersioned<T>(file: string, schema: z.ZodType<T>, current: number): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new CatherdError("E_CONFIG_INVALID", `${file} is not readable JSON: ${(e as Error).message}`, {
      fix: `fix or delete ${file}`,
    });
  }
  const found = (raw as { schema?: unknown } | null)?.schema;
  if (typeof found === "number" && found > current) throw newer(file, found, current);
  const r = schema.safeParse(raw);
  if (!r.success)
    throw new CatherdError("E_CONFIG_INVALID", `${file} is invalid:\n${z.prettifyError(r.error)}`, {
      fix: `fix or delete ${file}`,
    });
  return r.data;
}

/** One `appendFileSync` per row, so a crash can only ever truncate the last line. */
export function appendJsonl(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(value)}\n`);
}

export function ensureJsonlHeader(file: string, kind: string): void {
  mkdirSync(dirname(file), { recursive: true });
  try {
    const fd = openSync(file, "wx");
    writeSync(fd, `${JSON.stringify({ schema: 1, kind })}\n`);
    closeSync(fd);
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

export function readJsonl<T>(file: string, current = 1): { kind: string | null; rows: T[]; corrupt: number } {
  if (!existsSync(file)) return { kind: null, rows: [], corrupt: 0 };
  const rows: T[] = [];
  let kind: string | null = null;
  let corrupt = 0;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      corrupt++;
      return;
    }
    if (i === 0 && isHeader(v)) {
      if (v.schema > current) throw newer(file, v.schema, current);
      kind = v.kind;
      return;
    }
    rows.push(v as T);
  });
  return { kind, rows, corrupt };
}
