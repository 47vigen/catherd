import type { HostContext } from "../../src/domain/host.ts";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { composeBrief } from "../../src/domain/brief.ts";
import type { Role } from "../../src/domain/roles.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDispatchId, parseRung } from "../../src/domain/ids.ts";
import type { Access, ExitReason, RunRecord } from "../../src/domain/record.ts";
import type { SessionEnv } from "../../src/infra/claude-session.ts";
import { db, ensureRunRow, insertEvent } from "../../src/infra/db.ts";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { processStartTime } from "../../src/infra/proc.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import { dispatch, type DispatchInput, watchersSettled } from "../../src/services/dispatch-service.ts";
import { type Admit, admitPath, type Dispatch, roleDir, setLatest } from "../../src/services/dispatches.ts";
import type { Deps, ProfilePort, ProfileView, RoutingPort } from "../../src/services/ports.ts";
import { unitContext } from "../../src/services/plan-input.ts";
import { result } from "../../src/services/run-service.ts";
import { appendRecord, createRun, type Run, runPaths } from "../../src/services/run-store.ts";
import { makeRecord } from "../domain/make-record.ts";
import { repoWithOrigin, tempRepo, withHome } from "../helpers.ts";

export { makeRecord } from "../domain/make-record.ts";

/**
 * The brief admission composes for `text` on the 1.x path (plan 44 D2): the four parts, `text` as part 4, the lane
 * file at the end of part 3. A brief names no backend, so `backend` and `isolated` change nothing in it.
 */
export function briefFor(
  run: Run,
  text: string,
  o: { name?: string; role?: Role; lane?: string | null; backend?: string; isolated?: boolean } = {},
): string {
  const lane = o.lane === undefined ? "M1.L1" : o.lane;
  const name = o.name ?? "worker-M1.L1";
  const role = o.role ?? "worker";
  return composeBrief(
    // part 3 as admission composes it (plan 44 D12): the unit's context, whose unit is the lane, else the milestone
    { facts: [], unit: unitContext(run, role, lane ?? /\bM\d+\b/.exec(name)?.[0] ?? name), round: [text] },
    {
      run: run.id,
      name,
      role,
      lane:
        lane === null
          ? null
          : { id: lane, text: readFileSync(join(runPaths(run.dir).lanes, `${lane}.md`), "utf8") },
      version: "0.0.0-test",
      resumed: false,
    },
  );
}

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
    billing: {},
    roles: {
      worker: role("workspace-write", LADDER),
      writer: role("workspace-write", ["codex:gpt-6-luna#high"]),
      reviewer: role("read-only", ["codex:gpt-6-sol#high"]),
      architect: role("workspace-write", ["claude:claude-opus-5-5#high"]),
    },
    isolated: {},
    failover: {},
    budget: {},
    timeouts: { idleMin: 15, wallMin: 90 },
    preflight: { confirm: false },
    land: { autoMerge: false },
    heavy: 2,
    notify: [],
    limits: { memory: { reserveMb: 2048, perMilestoneMb: 3072, floorMb: 3072 } },
    ...over,
  };
}

/** Deps with a fixed profile view (mutate `view` to change it mid-test) and a routing fake. */
export function fakeDeps(
  o: { view?: ProfileView; now?: () => number; session?: SessionEnv | null; host?: HostContext } = {},
): Deps & { view: ProfileView } {
  const view = o.view ?? testView();
  const routing: RoutingPort = {
    checkStart: async () => ({ unusable: [], index: null }),
    catalog: () => ({ total: 0, models: [] }),
  };
  const notify = { url: "https://ntfy.sh/catherd-test" };
  const profiles: ProfilePort = {
    forRepo: () => view,
    get: () => ({ active: "test", here: "test", profiles: ["test"], profile: view, enforcement: {} }),
    validate: () => ({ valid: true, errors: [], warnings: [] }),
    set: () => ({
      saved: false,
      errors: [{ path: "", message: "profiles are fixed in tests" }],
      warnings: [],
      diff: [],
      linked: [],
      pruned: [],
      newSessionNeededFor: [],
    }),
    agentFor(_repo, r, rung) {
      const p = parseRung(rung);
      return p.backend === "claude" ? `catherd-${r}-${p.model}-${p.effort}` : null;
    },
    notifyUrl: () => notify.url,
    setNotifyUrl: (url) => {
      notify.url = url;
    },
  };
  return {
    host: o.host ?? { host: o.session ? "claude-code" : "unknown", session: null, conflict: null },
    profiles,
    routing,
    version: "0.0.0-test",
    pollMs: 50,
    session: o.session ?? null,
    now: o.now ?? Date.now,
    view,
  };
}

/**
 * An isolated CATHERD_HOME, a fresh git repo and a run in it. Call `afterEach(snapshotEnv())` in the file.
 * A run's events live in the home's database, so a test that reads two runs makes the second with `sameHome`:
 * a new home would hide the first run's events from it.
 */
export function freshRun(title = "t", o: { sameHome?: boolean } = {}): { repo: string; run: Run } {
  if (!o.sameHome) withHome();
  delete process.env.CATHERD_DECISION_KEY;
  const repo = tempRepo();
  return { repo, run: createRun({ repo, title, aLines: ["A1 it works"], version: "0.0.0-test" }) };
}

/** plan 35: a run with `base: "main"` over a repo whose origin is a local bare clone (never a URL). */
export function branchRun(title = "t"): { repo: string; origin: string; run: Run } {
  withHome();
  delete process.env.CATHERD_DECISION_KEY;
  const { repo, origin } = repoWithOrigin();
  return {
    repo,
    origin,
    run: createRun({ repo, title, aLines: ["A1 it works"], version: "0.0.0-test", base: "main" }),
  };
}

export function writeLane(
  run: Run,
  id: string,
  owns: string[],
  check = "true",
  extra = "Kind: repo_code\nDifficulty: build\n",
): string {
  const file = join(runPaths(run.dir).lanes, `${id}.md`);
  // 0600, as catherd's own writeRunFile writes it
  writeFileSync(file, `# ${id} — test lane\nOwns: ${owns.join(", ")}\nFast check: ${check}\n${extra}`, {
    mode: 0o600,
  });
  return file;
}

/**
 * A finished, read record of `name` on `thread`, so `dispatch(…, thread)` may resume it (plan 22: a thread must
 * be one of the name's records in this run).
 */
export async function seedThread(
  run: Run,
  name: string,
  thread: string,
  over: Partial<RunRecord> = {},
): Promise<RunRecord> {
  const dispatchId = newDispatchId();
  return appendRecord(
    run,
    makeRecord({
      runId: run.id,
      dispatchId,
      name,
      thread,
      replyPath: `roles/${name}/${dispatchId}/reply.md`,
      ...over,
    }),
  );
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

/**
 * `dispatch`, then everything its watchers settle (a failover stand-in included), then `result`: what one
 * 0.x dispatch call did. The last record, and every hint on the way (the records' first, then dispatch's
 * state hints, once each).
 */
export async function runRole(deps: Deps, i: DispatchInput): Promise<{ record: RunRecord; hints: string[] }> {
  const started = await dispatch(deps, i);
  await watchersSettled();
  const r = await result(deps, { run: i.run, name: i.name });
  if (!r.record) throw new Error(`no record for ${i.name}`);
  return { record: r.record, hints: [...r.hints, ...started.hints.filter((h) => !r.hints.includes(h))] };
}

interface FakeFiles {
  /** "self": this test process stands in for a live supervisor; "dead": both pids are gone */
  proc?:
    | "self"
    | "dead"
    | { pid: number; startTime: string | null; supervisorPid: number; supervisorStartTime: string | null };
  exit?: { code: number | null; signal: string | null; reason: ExitReason; endedAt: string };
  events?: string;
  reply?: string;
  /** leave the unread mark admission leaves, as any catherd server that admitted it does */
  collect?: boolean;
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
  if (files.collect) writeFileSync(p.collect, "");
  writeJsonAtomic(admitPath(dir), admit);
  setLatest(run, admit.name, admit.dispatchId);
  return { dir, admit };
}

/** A reviewed plan file: three tasks, each with a signature or a test. */
export const PLAN_TEXT = [
  "# Plan P",
  "Goal: a wallet.",
  "",
  "## M1 — core",
  "",
  "### Task 1: add the store",
  "**Interfaces:** `save(u: User): void`",
  "",
  "### Task 2: add the test",
  'Test: `src/a.test.ts` — "saves"',
  "",
  "## M2 — docs",
  "",
  "### Task 3: docs",
  "Write the docs.",
  "Test: `docs.test.ts` — links",
  "",
].join("\n");

/** `run.started` as an earlier build wrote it: events version 1, the 2.0 engine (spec D16). */
export function insertEarlier(run: Run): void {
  const d = db();
  ensureRunRow(d, run);
  insertEvent(d, run.id, {
    v: 1,
    seq: 1,
    at: "2026-10-21T10:00:00.000Z",
    type: "run.started",
    repo: run.meta.repo,
    title: "t",
    aLines: [],
    plan: [],
    base: null,
    engine: "2.0",
  } as never);
}
