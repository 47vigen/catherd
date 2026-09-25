import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { budgetStatus, formatBudget } from "../domain/budget.ts";
import { CatherdError } from "../domain/errors.ts";
import { assertId, formatRung, newDispatchId, parseRung } from "../domain/ids.ts";
import { overlaps, parseLaneHeader } from "../domain/lane.ts";
import type { Role } from "../domain/roles.ts";
import { dispatchPaths } from "../infra/dispatch-dir.ts";
import { workerEnv } from "../infra/env.ts";
import { withFileLock } from "../infra/filelock.ts";
import { statusSnapshot } from "../infra/git.ts";
import { launchSupervisor } from "../infra/launch.ts";
import { processStartTime } from "../infra/proc.ts";
import { writeJsonAtomic, writeTextAtomic } from "../infra/store.ts";
import { readyAdapter } from "./backends.ts";
import { spendOf } from "./budget.ts";
import {
  type Admit,
  admitPath,
  type Dispatch,
  launchPath,
  listDispatches,
  liveDispatches,
  roleDir,
  setLatest,
} from "./dispatches.ts";
import type { Deps } from "./ports.ts";
import { readRecords, type Run, runPaths } from "./run-store.ts";

export interface AdmitInput {
  role: Role;
  name: string;
  brief: string;
  rung: string;
  thread: string | null;
  lane: string | null;
  failoverFrom: string | null;
}

/** Spec §3.3: SIGTERM, then SIGKILL this long after. */
export const KILL_GRACE_MS = 10_000;

export const laneFile = (run: Run, lane: string): string => join(runPaths(run.dir).lanes, `${lane}.md`);

export function laneOwns(run: Run, lane: string): string[] {
  const file = laneFile(run, lane);
  if (!existsSync(file))
    throw new CatherdError("E_LANE_INVALID", `no lane file lanes/${lane}.md`, {
      fix: "write it with write_run_file first",
    });
  const owns = parseLaneHeader(readFileSync(file, "utf8")).owns;
  if (owns.length === 0)
    throw new CatherdError("E_LANE_INVALID", `lanes/${lane}.md has no Owns: line`, {
      fix: "add `Owns: <paths>` below the lane's title",
    });
  return owns;
}

/**
 * Spec §4.4 step 1. The checks that read shared state and the write that makes the dispatch live
 * happen under the run's admission lock, so parallel dispatches always see each other (audit C1).
 */
export async function admit(deps: Deps, run: Run, i: AdmitInput): Promise<{ d: Dispatch; specPath: string }> {
  assertId("role name", i.name);
  if (i.lane !== null) assertId("lane", i.lane);
  const rung = parseRung(i.rung);
  const profile = deps.profiles.forRepo(run.meta.repo);
  const rc = profile.roles[i.role];
  if (!rc?.enabled)
    throw new CatherdError("E_ADMIT_RUNG", `the ${i.role} role is off in profile ${profile.name}`, {
      fix: "skip the role, or turn it on with profile_set",
    });
  if (rung.backend === "claude")
    throw new CatherdError("E_ADMIT_RUNG", `${i.rung} is a native Claude rung`, {
      fix: `run it as Agent(subagent_type: "${deps.routing.agentFor(i.role, i.rung)}"), then record_agent_run`,
    });
  const allowed = new Set([...rc.rungs, ...rc.rungs.flatMap((r) => profile.failover[r] ?? [])]);
  if (!allowed.has(formatRung(rung)))
    throw new CatherdError(
      "E_ADMIT_RUNG",
      `${i.rung} is not on the ${i.role} ladder of profile ${profile.name}`,
      {
        fix: `use the rung route returned; the ladder is ${rc.rungs.join(", ") || "empty"}`,
      },
    );
  const { adapter, probe } = await readyAdapter(rung.backend);
  if (i.thread !== null && !(adapter.resume.supported && adapter.resume.threadPattern.test(i.thread)))
    throw new CatherdError("E_ADMIT_THREAD", `"${i.thread}" is not a ${adapter.id} thread id`, {
      fix: "pass the thread from the role's earlier record, or none for a fresh thread",
    });
  const owns = i.lane === null ? [] : laneOwns(run, i.lane);
  const id = newDispatchId();
  const dir = join(roleDir(run, i.name), id);
  const p = dispatchPaths(dir);
  const isolated = profile.isolated[rung.backend] ?? false;
  const plan = adapter.plan({
    rung,
    access: rc.access,
    thread: i.thread,
    isolated,
    repo: run.meta.repo,
    briefPath: p.brief,
    replyPath: p.reply,
    dispatchDir: dir,
  });

  return withFileLock(runPaths(run.dir).admission, async () => {
    const records = readRecords(run).records;
    const live = liveDispatches(run, deps.now());
    const same = live.find((d) => d.admit.name === i.name);
    if (same)
      throw new CatherdError("E_ADMIT_DUPLICATE", `${i.name} is already running on ${same.admit.rung}`, {
        fix: `wait for it, or cancel(run, "${i.name}")`,
      });
    for (const d of live) {
      const shared = overlaps(owns, d.admit.owns);
      if (shared.length)
        throw new CatherdError(
          "E_ADMIT_OVERLAP",
          `${i.name} owns ${shared.join(", ")}, which running ${d.admit.name} owns`,
          {
            fix: `dispatch it after ${d.admit.name} finishes`,
          },
        );
    }
    const budget = budgetStatus(spendOf(run, records, live, deps.now()), profile.budget);
    if (budget && budget.fraction >= 1)
      throw new CatherdError("E_RUN_BUDGET", `the run budget is spent: ${formatBudget(budget)}`, {
        fix: "ask the user to raise profile.budget, or finish the run with what landed",
      });
    const admitted: Admit = {
      schema: 1,
      runId: run.id,
      dispatchId: id,
      name: i.name,
      role: i.role,
      lane: i.lane,
      owns,
      rung: formatRung(rung),
      backend: rung.backend,
      thread: i.thread,
      attempt: listDispatches(run).filter((d) => d.admit.name === i.name).length + 1,
      failoverFrom: i.failoverFrom,
      access: rc.access,
      isolated,
      cliVersion: probe.version,
      admittedAt: new Date(deps.now()).toISOString(),
      repo: run.meta.repo,
      before: await statusSnapshot(run.meta.repo),
    };
    mkdirSync(dir, { recursive: true });
    writeTextAtomic(p.brief, i.brief);
    writeJsonAtomic(p.spec, {
      schema: 1,
      backend: rung.backend,
      dispatchDir: dir,
      cmd: plan.cmd,
      args: plan.args,
      env: workerEnv(process.env, plan.env, plan.cwd),
      cwd: plan.cwd,
      stdinPath: plan.stdinPath,
      idleMs: profile.timeouts.idleMin * 60_000,
      wallMs: profile.timeouts.wallMin * 60_000,
      killGraceMs: KILL_GRACE_MS,
      graceAfterFinalMs: adapter.graceAfterFinalMs,
      pollMs: deps.pollMs,
    });
    writeJsonAtomic(admitPath(dir), admitted);
    setLatest(run, i.name, id);
    return { d: { dir, admit: admitted }, specPath: p.spec };
  });
}

/** Starts the dispatch's supervisor and records who it is; a supervisor that cannot start ends the dispatch as lost. */
export function launch(d: Dispatch, specPath: string): void {
  try {
    const pid = launchSupervisor(specPath);
    writeJsonAtomic(launchPath(d.dir), {
      schema: 1,
      supervisorPid: pid,
      supervisorStartTime: processStartTime(pid),
    });
  } catch (e) {
    const p = dispatchPaths(d.dir);
    appendFileSync(p.stderr, `catherd: could not start the supervisor: ${(e as Error).message}\n`);
    writeJsonAtomic(p.exit, {
      schema: 1,
      code: null,
      signal: null,
      reason: "lost",
      endedAt: new Date().toISOString(),
    });
  }
}
