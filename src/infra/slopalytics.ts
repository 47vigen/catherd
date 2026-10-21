import { existsSync } from "node:fs";
import { parseProxy, type IndexFile, IndexFileSchema, type SlopRecord } from "../domain/slopalytics.ts";
import { readVersioned, writeJsonAtomic } from "./store.ts";

export const SLOPALYTICS_URL = "https://slopalyticsproxy.vercel.app";

/** The proxy's answer, parsed. Throws on a transport error, a non-2xx, or an answer with no indexed pair. */
export async function fetchProxy(
  o: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ fetchedAt: string | null; models: SlopRecord[] }> {
  const res = await (o.fetch ?? fetch)(SLOPALYTICS_URL, {
    signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const parsed = parseProxy(await res.json());
  if (parsed.models.length === 0) throw new Error("no indexed pairs");
  return parsed;
}

/** The cached index, or null when there is none or it cannot be read (the next refresh rewrites it). */
export function readIndexFile(file: string): IndexFile | null {
  if (!existsSync(file)) return null;
  try {
    return readVersioned(file, IndexFileSchema, 1);
  } catch {
    return null;
  }
}

export const writeIndexFile = (file: string, f: IndexFile): void => writeJsonAtomic(file, f, { mode: 0o600 });
