import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDispatchId, parseRung } from "../../src/domain/ids.ts";
import type { Access, ExitReason } from "../../src/domain/record.ts";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { processStartTime } from "../../src/infra/proc.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import { type Admit, admitPath, type Dispatch, roleDir, setLatest } from "../../src/services/dispatches.ts";
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

export interface FakeFiles {
  /** "self": this test process stands in for a live supervisor; "dead": both pids are gone */
  proc?:
    | "self"
    | "dead"
    | { pid: number; startTime: string | null; supervisorPid: number; supervisorStartTime: string | null };
  exit?: { code: number | null; signal: string | null; reason: ExitReason; endedAt: string };
  events?: string;
  reply?: string;
}

let deadPid = 0;
/** A pid that belonged to a process which has exited. */
export async function deadProcess(): Promise<number> {
  if (!deadPid) {
    const p = Bun.spawn(["true"]);
    await p.exited;
    deadPid = p.pid;
  }
  return deadPid;
}

/** Puts a fake `git` first on PATH that runs the sh script `body`; `$REAL_GIT` in it is the real git. */
export function fakeGit(body: string): void {
  const bin = mkdtempSync(join(tmpdir(), "catherd-fakegit-"));
  writeFileSync(join(bin, "git"), `#!/bin/sh\nREAL_GIT='${Bun.which("git") ?? "git"}'\n${body}\n`);
  chmodSync(join(bin, "git"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

/** A dispatch folder as admission and the supervisor would leave it, without running anything. */
export async function fakeDispatch(
  run: Run,
  over: Partial<Admit> = {},
  files: FakeFiles = {},
): Promise<Dispatch> {
  const admit: Admit = {
    schema: 1,
    runId: run.id,
    dispatchId: newDispatchId(),
    name: "worker-M1.L1",
    role: "worker",
    lane: "M1.L1",
    owns: ["src/a.ts"],
    rung: "codex:gpt-6-sol#medium",
    backend: "codex",
    thread: null,
    attempt: 1,
    failoverFrom: null,
    access: "workspace-write",
    isolated: false,
    cliVersion: "0.157.0",
    admittedAt: new Date().toISOString(),
    repo: run.meta.repo,
    before: {},
    ...over,
  };
  const dir = join(roleDir(run, admit.name), admit.dispatchId);
  const p = dispatchPaths(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(p.brief, "brief");
  if (files.events !== undefined) writeFileSync(p.events, files.events);
  if (files.reply !== undefined) writeFileSync(p.reply, files.reply);
  if (files.proc) {
    const dead = await deadProcess();
    const proc =
      files.proc === "self"
        ? {
            pid: process.pid,
            startTime: processStartTime(process.pid),
            supervisorPid: process.pid,
            supervisorStartTime: processStartTime(process.pid),
          }
        : files.proc === "dead"
          ? { pid: dead, startTime: "gone", supervisorPid: dead, supervisorStartTime: "gone" }
          : files.proc;
    writeJsonAtomic(p.proc, { schema: 1, ...proc, pgid: proc.pid, startedAt: admit.admittedAt });
  }
  if (files.exit) writeJsonAtomic(p.exit, { schema: 1, ...files.exit });
  writeJsonAtomic(admitPath(dir), admit);
  setLatest(run, admit.name, admit.dispatchId);
  return { dir, admit };
}
