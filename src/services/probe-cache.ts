import type { BackendAdapter, Probe } from "../adapters/backend.ts";
import { probeBackend } from "./backends.ts";
import { errText } from "./doctor-checks.ts";

// The panel's Setup reads backend probes from here (plan 37 ruling 10): keyed by adapter id and PATH, stale
// for 60 s, served at once and refreshed once behind the reader; `force` ("Re-check") probes again.

export const PROBE_TTL_MS = 60_000;

type Probed = Probe & { probedAt: string };
const entries = new Map<string, { probe: Probed; at: number }>();
const running = new Map<string, Promise<Probed>>();

/** What a probe that threw reads as: the backend is not usable, and why. */
export const failedProbe = (id: string, e: unknown): Probe => ({
  installed: false,
  version: null,
  versionOk: false,
  loggedIn: null,
  problems: [{ code: "E_IO_UNEXPECTED", message: errText(e), fix: `run ${id} --version to see why` }],
});

/** `probes` counts real probes (monotonic); `now` is a seam for tests; `clear` forgets every entry. */
export const probeCache = {
  probes: 0,
  now: (): number => Date.now(),
  clear(): void {
    entries.clear();
    running.clear();
  },
};

/** One probe per key at a time: callers that arrive while it runs share it. */
function run(key: string, adapter: BackendAdapter): Promise<Probed> {
  let p = running.get(key);
  if (!p) {
    probeCache.probes++;
    p = probeBackend(adapter)
      .catch((e: unknown) => failedProbe(adapter.id, e))
      .then((probe) => {
        const at = probeCache.now();
        const probed = { ...probe, probedAt: new Date(at).toISOString() };
        entries.set(key, { probe: probed, at });
        return probed;
      })
      .finally(() => running.delete(key));
    running.set(key, p);
  }
  return p;
}

export async function cachedProbe(adapter: BackendAdapter, o?: { force?: boolean }): Promise<Probed> {
  const key = `${adapter.id}\n${process.env.PATH}`;
  const hit = entries.get(key);
  if (!hit || o?.force) return run(key, adapter);
  if (probeCache.now() - hit.at >= PROBE_TTL_MS) void run(key, adapter);
  return hit.probe;
}
