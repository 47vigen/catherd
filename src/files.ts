import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// This module sits one level below the package root as src/files.ts, and catherd ships with no
// build step, so one relative URL finds shipped files both in tests and after install alike.
export const assetPath = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));

export function readJsonFile<T>(schema: z.ZodType<T>, file: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`catherd: ${file} is not readable JSON: ${(e as Error).message}`);
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new Error(`catherd: ${file} is invalid:\n${z.prettifyError(r.error)}`);
  return r.data;
}
