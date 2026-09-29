import type { BackendAdapter, Probe } from "../adapters/backend.ts";
import { adapterFor } from "../adapters/registry.ts";
import "../adapters/all.ts";
import { CatherdError } from "../domain/errors.ts";
import { formatRung, tryParseRung } from "../domain/ids.ts";
import { PAIRED_FAILOVER } from "../domain/profile.ts";

const READY_TTL_MS = 10 * 60_000;
const ready = new Map<string, { at: number; probe: Probe }>();

/** Forget every cached probe (tests, and after the user fixes a backend). */
export const resetReadiness = (): void => ready.clear();

/** Spec 1.3 §3.3: what Bun's spawn throws for a binary built for another OS (a Linux build on macOS). */
function execFormatError(e: unknown): string | null {
  if (!(e instanceof Error)) return null;
  if ((e as { code?: unknown }).code !== "ENOEXEC" && !/exec format error/i.test(e.message)) return null;
  // macOS names the path (posix_spawn '/…/grok'), Linux only the command (uv_spawn 'grok')
  const bin = /spawn '([^']+)'/.exec(e.message)?.[1];
  return bin ? (Bun.which(bin) ?? bin) : "exec format error";
}

/**
 * The adapter's probe, with a CLI on PATH that the OS cannot execute reported as installed but unable to run
 * (spec 1.3 §3.3), with the reinstall command; any other failure of the probe is thrown.
 */
export async function probeBackend(adapter: BackendAdapter): Promise<Probe> {
  try {
    return await adapter.probe();
  } catch (e) {
    const why = execFormatError(e);
    if (why === null) throw e;
    return {
      installed: true,
      version: null,
      versionOk: false,
      loggedIn: null,
      problems: [
        {
          code: "E_BACKEND_CANNOT_RUN",
          message: `${adapter.id} is installed but cannot run on this OS: ${why}`,
          fix: adapter.install ?? `reinstall ${adapter.id} for this OS`,
        },
      ],
    };
  }
}

/**
 * Spec §4.4: the adapter for `backend` once its last probe says it is ready. A ready probe is kept
 * for 10 minutes; a failing one is never kept, so a fixed backend works on the next dispatch.
 */
export async function readyAdapter(backend: string): Promise<{ adapter: BackendAdapter; probe: Probe }> {
  const now = Date.now();
  const adapter = adapterFor(backend);
  if (!adapter)
    throw new CatherdError("E_BACKEND_MISSING", `catherd has no ${backend} adapter yet`, {
      fix: "use a rung on a backend catherd supports; catalog_query lists them",
    });
  const hit = ready.get(backend);
  if (hit && now - hit.at < READY_TTL_MS) return { adapter, probe: hit.probe };
  const probe = await probeBackend(adapter);
  const problem = probe.problems[0];
  // spec 1.3 §3.3: a probe that finds the CLI logged out lists E_BACKEND_NOT_LOGGED_IN, so a dispatch never
  // reaches it (agy opens a browser and waits); logged out alone is no problem where a CLI runs without a login
  if (problem) throw new CatherdError(problem.code, problem.message, { fix: problem.fix });
  ready.set(backend, { at: now, probe });
  return { adapter, probe };
}

/**
 * Spec §4.5: a rung's stand-in on a usage limit: the profile's, else the same model on its paired backend
 * (spec 1.3 §7.3), else its backend's default (for `repo`, when given), else none.
 */
export function standInFor(failover: Record<string, string>, rung: string, repo?: string): string | null {
  const own = failover[rung] ?? PAIRED_FAILOVER[rung];
  if (own) return own;
  const r = tryParseRung(rung);
  if (!r) return null;
  const byAdapter = adapterFor(r.backend)?.failoverFor?.(r, repo) ?? null;
  return byAdapter && formatRung(byAdapter);
}
