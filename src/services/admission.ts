import type { KnownHost } from "../domain/host.ts";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { BackendAdapter } from "../adapters/backend.ts";
import { budgetStatus, formatBudget } from "../domain/budget.ts";
import { CatherdError, errorMessage } from "../domain/errors.ts";
import { assertId, formatRung, newDispatchId, parseRung } from "../domain/ids.ts";
import { assertLaneHeader, overlaps } from "../domain/lane.ts";
import { roleTimeouts } from "../domain/profile.ts";
import type { RunRecord } from "../domain/record.ts";
import { composeBrief } from "../domain/brief.ts";
import { briefOwns, DOCS_OWNS } from "../domain/changes.ts";
import { grantsScratch, ROLE_SERVER_BACKENDS } from "../domain/role-tools.ts";
import type { Role } from "../domain/roles.ts";
import { formatRoleScope, ROLE_ENV } from "../domain/role-scope.ts";
import { dispatchPaths, markForCollect } from "../infra/dispatch-dir.ts";
import { withFileLock } from "../infra/filelock.ts";
import { statusSnapshot } from "../infra/git.ts";
import { launchSupervisor } from "../infra/launch.ts";
import { DISPATCH_ID_ENV } from "../infra/lock-activity.ts";
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
  scratchDir,
  setLatest,
} from "./dispatches.ts";
import { finalizeDispatch } from "./finalize.ts";
import { gateEnvParts, readGateEnv } from "./gate-env.ts";
import { assertNotPaused } from "./pause.ts";
import { currentOwns } from "./lane-edit.ts";
import { unfinishedAfter } from "./protocol.ts";
import { runProfile } from "./run-pin.ts";
import type { Deps } from "./ports.ts";
import { readRecords, recordsOnThread, type Run, runPaths, supersededBy } from "./run-store.ts";
import { currentSession } from "./sessions.ts";
import { verifierBrief } from "./verifier-brief.ts";
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

/** The role's scratch folder, created (0700) and by its real path, on a backend that grants it; else null. */
function roleScratch(run: Run, name: string, backend: string, isolated: boolean): string | null {
  if (!grantsScratch(backend, isolated)) return null;
  const dir = scratchDir(run, name);
  ensurePrivateDir(dir);
  return realpathSync(dir);
}

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

/** Refuses a dispatch into a run `runs supersede` closed, naming the run that took over. */
function assertNotSuperseded(run: Run): void {
  const closed = supersededBy(run);
  if (closed)
    throw new CatherdError("E_RUN_NOT_LIVE", `run ${run.id} is superseded by ${closed.by}`, {
      fix: `dispatch in run ${closed.by}`,
    });
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
  // a machine or workspace pause refuses every dispatch it covers, with its reason (spec 1.5 "Group pause")
  assertNotPaused(run);
  assertNotSuperseded(run);
  const rung = parseRung(i.rung);
  // spec 1.5: the run's pinned profile, access and isolation, whatever the repo runs on now
  const profile = runProfile(deps, run);
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
  // spec 1.5 plan 21: the writer's implicit docs lane, for attribution only
  const ownsImplicit = i.role === "writer" && i.lane === null ? (briefOwns(i.brief) ?? DOCS_OWNS) : null;
  // spec 1.5 "Lane editing": an After: line orders lanes that compile against each other
  const before = i.lane === null ? [] : unfinishedAfter(run, i.lane);
  if (before.length)
    throw new CatherdError(
      "E_ADMIT_ORDER",
      `${i.lane} runs after ${before.join(", ")} (its After: line), which ${before.length > 1 ? "have" : "has"} not finished`,
      { fix: `dispatch ${i.lane} once ${before.join(", ")} ${before.length > 1 ? "end" : "ends"} ok` },
    );
  const id = newDispatchId();
  const dir = join(roleDir(run, i.name), id);
  const p = dispatchPaths(dir);
  const isolated = started?.isolated ?? profile.isolated[rung.backend] ?? false;
  // spec 1.5 plan 21 (#42 findings 1, 2): the role server goes in whether the harness is isolated or not, so no
  // role is refused for isolation, and a thread an isolated run started resumes as it started
  const roleServer = ROLE_SERVER_BACKENDS.includes(rung.backend);
  await prepared(adapter, {
    rung,
    access: rc.access,
    isolated,
    repo: run.meta.repo,
    network,
  });

  await finalizeFinished(run, deps.now(), onRecorded);
  return withRunAdmission(run, deps.now, async () => {
    // again under the lock `runs supersede` writes under: a supersede that landed since the check above wins
    assertNotSuperseded(run);
    // the scratch is created under the admission lock `catherd runs clean` takes too, so cleanup never removes
    // the scratch of a dispatch it does not see live yet (PR #46)
    const scratch = roleScratch(run, i.name, rung.backend, isolated);
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
      ...(roleServer ? { roleMcp: { run: run.id, role: i.role } } : {}),
      ...(scratch ? { scratch } : {}),
    });
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
      // a running lane holds what owns_add granted it since its admission, too
      const held = d.admit.lane ? [...d.admit.owns, ...currentOwns(run, d.admit.lane)] : d.admit.owns;
      const shared = overlaps(owns, held);
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
      ...(ownsImplicit ? { ownsImplicit } : {}),
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
    // plan 23: the verifier runs with the repo's gate environment (DOCKER_HOST, a proxy, …)
    const gate =
      i.role === "verifier" ? gateEnvParts(await readGateEnv(run.meta.repo)) : { values: {}, refs: {} };
    // spec 1.1 §6: every brief ends with its role's reply contract, failover stand-ins' included; spec 1.5 plan 21:
    // before it, the lane file as it stands now, and who the role is, its scratch and its catherd tools; plan 23:
    // a verifier's brief also carries the gate's rules and the run's recorded items
    writeTextAtomic(
      p.brief,
      composeBrief(await verifierBrief(run, i.role, i.name, i.brief), {
        run: run.id,
        name: i.name,
        role: i.role,
        lane: i.lane === null ? null : { id: i.lane, text: readFileSync(laneFile(run, i.lane), "utf8") },
        scratch,
        roleServer,
      }),
    );
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
        // spec 1.5 plan 21: the supervisor gives the role its identity and, where granted, its scratch TMPDIR;
        // plan 23: a `catherd lock` in the role reports to this dispatch, so a long gate keeps its wall alive
        // plan 23: each dispatch its own testcontainers session, so parallel lanes never share a reaper;
        // the gate env never overrides the role's identity, scratch, dispatch id, PWD or isolated home
        env: {
          ...gate.values,
          ...plan.env,
          [ROLE_ENV]: formatRoleScope({ run: run.id, name: i.name }),
          ...(scratch ? { TMPDIR: scratch } : {}),
          [DISPATCH_ID_ENV]: id,
          TESTCONTAINERS_SESSION_ID: id,
          PWD: plan.cwd,
        },
        // a secret of the gate env by reference only: the supervisor reads it from its own env at spawn
        ...(Object.keys(gate.refs).length ? { envFrom: gate.refs } : {}),
        cwd: plan.cwd,
        stdinPath: plan.stdinPath,
        // plan 23: a role's own timeouts win over the profile's (a verifier's long gate)
        idleMs: roleTimeouts(profile, rc).idleMin * 60_000,
        wallMs: roleTimeouts(profile, rc).wallMin * 60_000,
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
