import type { BackendAdapter, Probe } from "../adapters/backend.ts";
import { adapterFor } from "../adapters/registry.ts";
import "../adapters/all.ts";
import { CatherdError } from "../domain/errors.ts";
import { formatRung, parseRung } from "../domain/ids.ts";

const READY_TTL_MS = 10 * 60_000;
const ready = new Map<string, { at: number; probe: Probe }>();

/** Forget every cached probe (tests, and after the user fixes a backend). */
export const resetReadiness = (): void => ready.clear();

/**
 * Spec §4.4: the adapter for `backend` once its last probe says it is ready. A ready probe is kept
 * for 10 minutes; a failing one is never kept, so a fixed backend works on the next dispatch.
 */
export async function readyAdapter(
  backend: string,
  now = Date.now(),
): Promise<{ adapter: BackendAdapter; probe: Probe }> {
  const adapter = adapterFor(backend);
  if (!adapter)
    throw new CatherdError("E_BACKEND_MISSING", `catherd has no ${backend} adapter yet`, {
      fix: "use a rung on a backend catherd supports; catalog_query lists them",
    });
  const hit = ready.get(backend);
  if (hit && now - hit.at < READY_TTL_MS) return { adapter, probe: hit.probe };
  const probe = await adapter.probe();
  const problem = probe.problems[0];
  if (problem) throw new CatherdError(problem.code, problem.message, { fix: problem.fix });
  ready.set(backend, { at: now, probe });
  return { adapter, probe };
}

/**
 * Spec §4.5: a rung's stand-in on a usage limit: the profile's, else its backend's default (for `repo`,
 * when given), else none.
 */
export function standInFor(failover: Record<string, string>, rung: string, repo?: string): string | null {
  const own = failover[rung];
  if (own) return own;
  let r: ReturnType<typeof parseRung>;
  try {
    r = parseRung(rung);
  } catch {
    return null;
  }
  const byAdapter = adapterFor(r.backend)?.failoverFor?.(r, repo) ?? null;
  return byAdapter && formatRung(byAdapter);
}
