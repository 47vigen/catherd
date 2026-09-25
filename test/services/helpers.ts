import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRung } from "../../src/domain/ids.ts";
import type { Access } from "../../src/domain/record.ts";
import type { Deps, ProfilePort, ProfileView, RoutingPort } from "../../src/services/ports.ts";
import { createRun, type Run, runPaths } from "../../src/services/run-store.ts";
import { tempRepo, withHome } from "../helpers.ts";

export { makeRecord } from "../domain/make-record.ts";

export const LADDER = [
  "codex:gpt-6-luna#high",
  "codex:gpt-6-sol#medium",
  "codex:gpt-6-sol#high",
  "codex:gpt-6-sol#xhigh",
];

const role = (access: Access, rungs: string[]) => ({ enabled: true, access, rungs: [...rungs] });

export function testView(over: Partial<ProfileView> = {}): ProfileView {
  return {
    name: "test",
    roles: {
      worker: role("workspace-write", LADDER),
      writer: role("workspace-write", ["codex:gpt-6-luna#high"]),
      reviewer: role("read-only", ["codex:gpt-6-sol#high"]),
      architect: role("read-only", ["claude:claude-opus-5-5#high"]),
    },
    isolated: {},
    failover: {},
    budget: {},
    timeouts: { idleMin: 15, wallMin: 90 },
    preflight: { confirm: false },
    heavy: 2,
    notify: [],
    ...over,
  };
}

/** Deps with a fixed profile view (mutate `view` to change it mid-test) and a routing fake. */
export function fakeDeps(o: { view?: ProfileView; now?: () => number } = {}): Deps & { view: ProfileView } {
  const view = o.view ?? testView();
  const routing: RoutingPort = {
    async route(req) {
      const rungs = view.roles[req.role]?.rungs ?? [];
      return { rung: rungs[0] ?? "", ladder: rungs, source: "default", kind: null, difficulty: null };
    },
    agentFor(r, rung) {
      const p = parseRung(rung);
      return p.backend === "claude" ? `catherd-${r}-${p.model}-${p.effort}` : null;
    },
    finding: async () => ({ value: "code", confidence: null, source: "default" }),
    sameDefect: async () => ({ value: "no", confidence: null, source: "default" }),
    catalog: () => ({ total: 0, models: [] }),
  };
  const profiles: ProfilePort = {
    forRepo: () => view,
    get: () => ({ active: "test", profiles: ["test"], profile: view }),
    validate: () => ({ valid: true, errors: [] }),
    set: () => ({ saved: false, errors: ["profiles are fixed in tests"], diff: [], newSessionNeededFor: [] }),
  };
  return { profiles, routing, version: "0.0.0-test", pollMs: 50, tickMs: 100, now: o.now ?? Date.now, view };
}

/** An isolated CATHERD_HOME, a fresh git repo and a run in it. Call `afterEach(snapshotEnv())` in the file. */
export function freshRun(title = "t"): { repo: string; run: Run } {
  withHome();
  delete process.env.TYPESAFE_API_KEY;
  const repo = tempRepo();
  return { repo, run: createRun({ repo, title, aLines: ["A1 it works"], version: "0.0.0-test" }) };
}

export function writeLane(
  run: Run,
  id: string,
  owns: string[],
  check = "true",
  extra = "Kind: repo_code\nDifficulty: build\n",
): string {
  const file = join(runPaths(run.dir).lanes, `${id}.md`);
  writeFileSync(file, `# ${id} — test lane\nOwns: ${owns.join(", ")}\nFast check: ${check}\n${extra}`);
  return file;
}

export async function waitFor<T>(f: () => T | null | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await Bun.sleep(25);
  }
}
