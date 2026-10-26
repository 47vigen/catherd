import type { HostContext } from "../../src/domain/host.ts";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { checkItems } from "../../src/domain/fail-lines.ts";
import { milestoneCheck } from "../../src/domain/plan-doc.ts";
import { composeBrief } from "../../src/domain/brief.ts";
import type { Role } from "../../src/domain/roles.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newDispatchId, parseRung } from "../../src/domain/ids.ts";
import type { Access, ExitReason, RunRecord } from "../../src/domain/record.ts";
import type { SessionEnv } from "../../src/infra/claude-session.ts";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { processStartTime } from "../../src/infra/proc.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import { appendCheckRecord } from "../../src/services/milestone-check.ts";
import { dispatch, type DispatchInput, watchersSettled } from "../../src/services/dispatch-service.ts";
import { type Admit, admitPath, type Dispatch, roleDir, setLatest } from "../../src/services/dispatches.ts";
import type { Deps, ProfilePort, ProfileView, RoutingPort } from "../../src/services/ports.ts";
import { decisionQuestions } from "../../src/services/decision-service.ts";
import { unitContext } from "../../src/services/plan-input.ts";
import { milestoneOfName } from "../../src/services/verifier-brief.ts";
import { result } from "../../src/services/run-service.ts";
import {
  appendOutcome,
  appendRecord,
  appendRoute,
  createRun,
  findRun,
  readRoutes,
  type Run,
  runPaths,
} from "../../src/services/run-store.ts";
import {
  type ClimbReason,
  currentRoute,
  laneOutcome,
  nextRung,
  outcomeRouteRow,
  type RouteRow,
} from "../../src/domain/route.ts";
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
    { facts: [], unit: unitContext(run, role, lane ?? milestoneOfName(name) ?? name), round: [text] },
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
    decision: { url: "https://decision.test/v1", model: "test-decider", minConfidence: 0.8 },
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
    // the role's first rung at or above the floor, no call; a test that wants a pick replaces it
    async decide(req) {
      const rungs = view.roles[req.role]?.rungs ?? [];
      const at = req.floor === null ? -1 : rungs.indexOf(req.floor);
      const open = rungs.slice(Math.max(0, req.strict ? at + 1 : at)).filter((r) => !req.exclude.includes(r));
      const rung = open[0];
      if (rung === undefined)
        return req.strict && req.floor !== null
          ? { ok: false, exhausted: true, floor: req.floor }
          : { ok: false, exhausted: false, error: "no rung", rungs: [] };
      return {
        ok: true,
        rung,
        level: 0,
        levels: open.length,
        levelRungs: open.map((r) => [r]),
        source: "floor",
        p: null,
        probabilities: {},
        why: "the fake decides the first rung above the floor",
      };
    },
    verdict: async (_runDir, _profile, set) => ({
      ok: true,
      value: decisionQuestions().sets[set].rule.fallback,
      p: 0,
    }),
    probe: async () => ({ ok: true, latencyMs: 1 }),
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

/** An isolated CATHERD_HOME, a fresh git repo and a run in it. Call `afterEach(snapshotEnv())` in the file. */
export function freshRun(title = "t"): { repo: string; run: Run } {
  withHome();
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

const headOf = (run: Run): string =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: run.meta.repo, encoding: "utf8" }).trim();

/**
 * The verifier half of `land`'s gate (plan 30b): a headless record named verifier-<m> whose reply opens
 * VERDICT: PASS and ends with the HEAD it checked, and catherd's own passing check of <m> on that commit.
 */
export async function passVerifier(
  run: Run,
  m: string,
  at = new Date().toISOString(),
  head = headOf(run),
): Promise<void> {
  const dispatchId = newDispatchId();
  const replyPath = `roles/verifier-${m}/${dispatchId}/reply.md`;
  mkdirSync(join(run.dir, dirname(replyPath)), { recursive: true });
  writeFileSync(join(run.dir, replyPath), `VERDICT: PASS\nHEAD: ${head}\nSTATUS: complete — ok\n`);
  await appendRecord(
    run,
    makeRecord({
      runId: run.id,
      dispatchId,
      name: `verifier-${m}`,
      role: "verifier",
      lane: null,
      rung: "claude-code:claude-opus-5-5#low",
      backend: "claude-code",
      startedAt: at,
      endedAt: at,
      tokens: { input: 0, cached: 0, output: 0 },
      changedOwned: [],
      access: "workspace-write",
      replyStatus: "complete",
      replyPath,
      head,
    }),
  );
  appendCheckRecord(run.meta.repo, {
    at,
    run: run.id,
    milestone: m,
    command: "true",
    head,
    exit: 0,
    durationMs: 0,
    fails: [],
    log: "",
    secrets: "clean",
  });
}

/**
 * What `land`'s gate asks for (spec 1.1 §6, plan 30b): a reviewer record named reviewer-<m>, and the verifier
 * half (`passVerifier`). Both ok and stamped `at` (default now), which must not be before the milestone's lanes
 * started. `head` defaults to the repo's HEAD, so call it after the commit being landed.
 */
export async function passGate(
  run: Run,
  m: string,
  at = new Date().toISOString(),
  head = headOf(run),
): Promise<void> {
  await appendRecord(
    run,
    makeRecord({
      runId: run.id,
      dispatchId: newDispatchId(),
      name: `reviewer-${m}`,
      role: "reviewer",
      lane: null,
      rung: "codex:gpt-6-sol#high",
      startedAt: at,
      endedAt: at,
      tokens: { input: 0, cached: 0, output: 0 },
      changedOwned: [],
      access: "read-only",
    }),
  );
  await passVerifier(run, m, at, head);
  const plan = join(run.dir, "plan.md");
  const command = existsSync(plan) ? milestoneCheck(readFileSync(plan, "utf8"), m) : null;
  for (const item of command === null ? [] : checkItems(command))
    appendCheckRecord(run.meta.repo, {
      at,
      run: run.id,
      milestone: m,
      command: item,
      head,
      exit: 0,
      durationMs: 0,
      fails: [],
      log: "",
      secrets: "clean",
    });
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

/**
 * A lane's route row as `dispatch` writes it for a coordinator's rung, and as every earlier catherd wrote it: the
 * lane starts on the role's first rung, the profile's rungs are its ladder. The readers of old runs (climbs,
 * outcomes, the protocol's next step) are tested on these rows.
 */
export async function route(
  deps: Deps,
  i: { run: string; laneFile: string; role: Role; row?: Partial<RouteRow> },
): Promise<{ lane: string; rung: string; ladder: string[] }> {
  const run = findRun(i.run);
  const lane = (i.laneFile.match(/^lanes\/(.+)\.md$/) as RegExpMatchArray)[1] as string;
  const ladder = deps.profiles.forRepo(run.meta.repo).roles[i.role]?.rungs ?? [];
  appendRoute(run, {
    at: new Date(deps.now()).toISOString(),
    lane,
    role: i.role,
    rung: ladder[0] as string,
    ladder,
    source: "route",
    decidedBy: "default",
    from: null,
    reason: null,
    kind: null,
    difficulty: null,
    why: "the role's first rung",
    ...i.row,
  });
  return { lane, rung: ladder[0] as string, ladder };
}

/**
 * One rung up the lane's ladder, as an earlier catherd's `climb` wrote it: a `climb` row, and past the top rung
 * the lane's open outcome. Returns the rung it stands on and whether that is the top.
 */
export function climb(
  deps: Deps,
  i: { run: string; lane: string; reason: ClimbReason; evidence?: string; env?: boolean },
): { rung: string; top: boolean } {
  const run = findRun(i.run);
  const cur = currentRoute(readRoutes(run), i.lane) as RouteRow;
  const next = nextRung(cur.ladder, cur.rung);
  const at = new Date(deps.now()).toISOString();
  appendRoute(run, {
    ...cur,
    at,
    source: "climb",
    from: cur.rung,
    rung: next ?? cur.rung,
    reason: i.evidence ? `${i.reason}: ${i.evidence}` : i.reason,
    env: i.env === true,
  });
  if (!next) {
    const routes = readRoutes(run);
    const o = laneOutcome(routes, i.lane, false, at);
    if (o) {
      appendOutcome(run, o);
      appendRoute(run, outcomeRouteRow(routes, o));
    }
  }
  return { rung: next ?? cur.rung, top: next === null };
}
