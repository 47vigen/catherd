import type { KnownHost } from "../domain/host.ts";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendAdapter } from "../adapters/backend.ts";
import { budgetStatus, formatBudget } from "../domain/budget.ts";
import { CatherdError, errorMessage } from "../domain/errors.ts";
import { assertId, formatRung, newDispatchId, parseRung } from "../domain/ids.ts";
import { assertLaneHeader, overlaps } from "../domain/lane.ts";
import type { RunRecord } from "../domain/record.ts";
import { withReplyContract } from "../domain/role-prompts.ts";
import type { Role } from "../domain/roles.ts";
import { roleRequiresMcp } from "../domain/role-tools.ts";
import { dispatchPaths, markForCollect } from "../infra/dispatch-dir.ts";
import { withFileLock } from "../infra/filelock.ts";
import { statusSnapshot } from "../infra/git.ts";
import { launchSupervisor } from "../infra/launch.ts";
import { log } from "../infra/log.ts";
import { processStartTime } from "../infra/proc.ts";
import { ensurePrivateDir, PRIVATE_FILE, writeJsonAtomic, writeTextAtomic } from "../infra/store.ts";
import { readyAdapter, standInFor } from "./backends.ts";
import { spendOf } from "./budget.ts";
import {
  type Admit,
  admitPath,
  type Dispatch,
  launchPath,
  type LiveDispatch,
  listDispatches,
  pendingDispatches,
  roleDir,
  setLatest,
} from "./dispatches.ts";
import { finalizeDispatch } from "./finalize.ts";
import type { Deps } from "./ports.ts";
import { readRecords, recordsOnThread, type Run, runPaths } from "./run-store.ts";
import { currentSession } from "./sessions.ts";
import { withRunAdmission } from "./workspace-admission.ts";

export interface AdmitInput {
  role: Role;
  name: string;
  brief: string;
  rung: string;
  thread: string | null;
  lane: string | null;
  failoverFrom: string | null;
  /** the dispatch id of the limited dispatch this stand-in replaces */
  failoverOf?: string;
  /** the dispatching session (spec §3.3); absent means the session this process serves */
  sessionId?: string | null;
  host?: KnownHost;
}

/** Spec §3.3: SIGTERM, then SIGKILL this long after. */
export const KILL_GRACE_MS = 10_000;

export const laneFile = (run: Run, lane: string): string => join(runPaths(run.dir).lanes, `${lane}.md`);

function laneOwns(run: Run, lane: string): string[] {
  const file = laneFile(run, lane);
  if (!existsSync(file))
    throw new CatherdError("E_LANE_INVALID", `no lane file lanes/${lane}.md`, {
      fix: "write it with write_run_file first",
    });
  const owns = assertLaneHeader(readFileSync(file, "utf8"), `lanes/${lane}.md`).owns;
  if (owns.length === 0)
    throw new CatherdError("E_LANE_INVALID", `lanes/${lane}.md has no Owns: line`, {
      fix: "add `Owns: <paths>` below the lane's title",
    });
  return owns;
}

/** What a caller of `admit` does with each record `admit` itself writes (dispatch settles it). */
export type OnRecorded = (d: Dispatch, record: RunRecord) => Promise<unknown>;

/**
 * Records each finished dispatch of the run that has none yet, as reconcile does, so one whose waiter died
 * never blocks its name or lane, and hands each record to `onRecorded` (the caller settles it, so its owner is
 * told). Before the admission lock: a finalize may wait on another's claim. One that throws is skipped and
 * stays pending, so the refusal still names it; an `onRecorded` that throws never fails the admit.
 */
async function finalizeFinished(run: Run, now: number, onRecorded?: OnRecorded): Promise<void> {
  for (const d of pendingDispatches(run, now)) {
    if (d.state !== "finished") continue;
    let record: RunRecord;
    try {
      record = await finalizeDispatch(run, d);
    } catch {
      // stays pending: admission refuses its name and lane, and names it
      continue;
    }
    try {
      await onRecorded?.(d, record);
    } catch (e) {
      log("warn", "admit", { run: run.id, name: d.admit.name, error: errorMessage(e) });
    }
  }
}

/**
 * The cap on an adapter's prepare. Each CLI call in it is bounded already (15 s); this covers the slowest
 * bounded path (opencode: a reload, then two listings) so only a prepare that is truly stuck is refused.
 */
export const prepareLimits = { timeoutMs: 60_000 };

/** The adapter's prepare, refused with E_IO_UNEXPECTED when it has not settled within the limit. */
async function prepared(adapter: BackendAdapter, req: Parameters<NonNullable<BackendAdapter["prepare"]>>[0]) {
  if (!adapter.prepare) return;
  const ms = prepareLimits.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new CatherdError("E_IO_UNEXPECTED", `${adapter.id} did not get ready within ${ms} ms`, {
            fix: `check that the ${adapter.id} CLI starts and answers, then dispatch again`,
          }),
        ),
      ms,
    );
  });
  try {
    await Promise.race([adapter.prepare(req), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Spec §4.4 step 1. The checks that read shared state and the write that makes the dispatch live
 * happen under the run's admission lock, so parallel dispatches always see each other (audit C1).
 */
export async function admit(
  deps: Deps,
  run: Run,
  i: AdmitInput,
  onRecorded?: OnRecorded,
): Promise<{ d: Dispatch; specPath: string }> {
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
      fix: `run it as Agent(subagent_type: "${deps.profiles.agentFor(run.meta.repo, i.role, i.rung)}"), then record_agent_run`,
    });
  const allowed = new Set([
    ...rc.rungs,
    ...rc.rungs.flatMap((r) => standInFor(profile.failover, r, run.meta.repo) ?? []),
  ]);
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
  // a resumed thread lives in the home it started in (CODEX_HOME), whatever the profile says now
  const started = i.thread === null ? undefined : recordsOnThread(run, rung.backend, i.thread).at(-1);
  const network = rc.network !== false;
  // spec 1.3 §3.2: a backend that fixes a thread's access when it starts it refuses another on resume
  if (started && adapter.resume.sameAccessOnly && started.access !== rc.access)
    throw new CatherdError(
      "E_ADMIT_THREAD",
      `${adapter.id} keeps the access a thread started with: ${i.thread} ran ${started.access}, and the ${i.role} role runs ${rc.access}`,
      { fix: "dispatch a fresh thread (omit `thread`)" },
    );
  // and the network grant: grok keeps a session's sandbox profile, agy's isolated homes differ by it.
  // A record from before 1.3 carries no grant to compare.
  if (started?.network !== undefined && adapter.resume.sameAccessOnly && started.network !== network)
    throw new CatherdError(
      "E_ADMIT_THREAD",
      `${adapter.id} keeps the network grant a thread started with: ${i.thread} ran ${started.network ? "with" : "without"} the network, and the ${i.role} role runs ${network ? "with" : "without"} it`,
      { fix: "dispatch a fresh thread (omit `thread`)" },
    );
  const owns = i.lane === null ? [] : laneOwns(run, i.lane);
  const id = newDispatchId();
  const dir = join(roleDir(run, i.name), id);
  const p = dispatchPaths(dir);
  const isolated = started?.isolated ?? profile.isolated[rung.backend] ?? false;
  const needsRoleMcp = rung.backend === "codex" || rung.backend === "claude-code";
  if (needsRoleMcp && isolated && roleRequiresMcp(i.role))
    throw new CatherdError(
      "E_ADMIT_RUNG",
      `${i.role} needs catherd's run tools, which are not available in an isolated ${rung.backend} harness`,
      {
        fix: `set harness.${rung.backend}.isolated to false in profile ${profile.name}, then dispatch a fresh thread`,
      },
    );
  await prepared(adapter, {
    rung,
    access: rc.access,
    isolated,
    repo: run.meta.repo,
    network,
  });
  const plan = adapter.plan({
    rung,
    access: rc.access,
    network,
    thread: i.thread,
    isolated,
    repo: run.meta.repo,
    briefPath: p.brief,
    replyPath: p.reply,
    dispatchDir: dir,
    ...(needsRoleMcp && !isolated ? { roleMcp: { run: run.id, role: i.role } } : {}),
  });

  await finalizeFinished(run, deps.now(), onRecorded);
  return withRunAdmission(run, deps.now, async () => {
    // A dispatch blocks until its record is written, not only while it runs: its finalizer diffs the
    // tree after the exit, so a later dispatch's writes must not land in between. A finished one here
    // could not be recorded just now. The records and the pending dispatches are one snapshot, taken
    // under the lock appendRecord writes under, so no record lands between the two reads.
    const { records, pending } = await withFileLock(runPaths(run.dir).runs, () => {
      const records = readRecords(run).records;
      return { records, pending: pendingDispatches(run, deps.now(), records) };
    });
    const doing = (d: LiveDispatch): string => (d.state === "finished" ? "finished, unrecorded," : "running");
    const same = pending.find((d) => d.admit.name === i.name);
    if (same)
      throw new CatherdError(
        "E_ADMIT_DUPLICATE",
        `${i.name} is already ${doing(same)} on ${same.admit.rung}`,
        {
          fix:
            same.state === "finished"
              ? `its record could not be written; see ${same.dir}, and retry`
              : `its record is announced when it finishes; or cancel(run, "${i.name}")`,
        },
      );
    for (const d of pending) {
      const shared = overlaps(owns, d.admit.owns);
      if (shared.length)
        throw new CatherdError(
          "E_ADMIT_OVERLAP",
          `${i.name} owns ${shared.join(", ")}, which ${d.admit.name} (${doing(d)}) owns`,
          {
            fix: `dispatch it after ${d.admit.name} finishes`,
          },
        );
    }
    // a finished dispatch not yet recorded still spent its tokens: every pending one counts
    const budget = budgetStatus(spendOf(run, records, pending, deps.now()), profile.budget);
    if (budget && budget.fraction >= 1)
      throw new CatherdError("E_RUN_BUDGET", `the run budget is spent: ${formatBudget(budget)}`, {
        fix: "ask the user to raise profile.budget, or finish the run with what landed",
      });
    const before = await statusSnapshot(run.meta.repo);
    const session = currentSession(deps);
    const sessionId = i.sessionId !== undefined ? i.sessionId : (session?.sessionId ?? null);
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
      ...(i.failoverOf ? { failoverOf: i.failoverOf } : {}),
      access: rc.access,
      isolated,
      network,
      cliVersion: probe.version,
      admittedAt: new Date(deps.now()).toISOString(),
      repo: run.meta.repo,
      before,
      ...(sessionId ? { sessionId, host: i.host ?? session?.host ?? "claude-code" } : {}),
    };
    ensurePrivateDir(dir);
    // spec 1.1 §6: every brief ends with its role's reply contract, failover stand-ins' included
    writeTextAtomic(p.brief, withReplyContract(i.role, i.brief));
    // Spec §10.4: the adapter's overrides only; the supervisor adds its own inherited env at spawn
    // time (src/entry/supervise-command.ts), so no credential is ever written to disk. 0600 all the same.
    writeJsonAtomic(
      p.spec,
      {
        schema: 1,
        backend: rung.backend,
        dispatchDir: dir,
        cmd: plan.cmd,
        args: plan.args,
        env: { ...plan.env, PWD: plan.cwd },
        cwd: plan.cwd,
        stdinPath: plan.stdinPath,
        idleMs: profile.timeouts.idleMin * 60_000,
        wallMs: profile.timeouts.wallMin * 60_000,
        killGraceMs: KILL_GRACE_MS,
        graceAfterFinalMs: adapter.graceAfterFinalMs,
        pollMs: deps.pollMs,
      },
      { mode: 0o600 },
    );
    // the collect mark before admit.json: no admitted dispatch ever exists without it, so a process that
    // dies before launching it still leaves a record (lost, once its start grace passes), unread
    markForCollect(dir);
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
    appendFileSync(p.stderr, `catherd: could not start the supervisor: ${(e as Error).message}\n`, {
      mode: PRIVATE_FILE,
    });
    writeJsonAtomic(p.exit, {
      schema: 1,
      code: null,
      signal: null,
      reason: "lost",
      endedAt: new Date().toISOString(),
    });
  }
}
