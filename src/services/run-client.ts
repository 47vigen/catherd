import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CAPS } from "../domain/caps.ts";
import { CatherdError, errorMessage } from "../domain/errors.ts";
import type { ProfilePatch } from "../domain/profile.ts";
import { ROLES } from "../domain/roles.ts";
import { liveDispatches } from "../domain/run-state.ts";
import { gitToplevel } from "../infra/git.ts";
import { ensureDaemon } from "./daemon.ts";
import type { Deps } from "./ports.ts";
import { copyPlanInputs, planInputPaths, resolvePlanInputs } from "./plan-input.ts";
import { ledgerOf } from "./ledger-store.ts";
import {
  appendEvent,
  isDaemonRun,
  isEarlierRun,
  readEvents,
  replayRun,
  withEventsLock,
} from "./run-events-store.ts";
import { answer, openQuestions } from "./questions.ts";
import { runProfile } from "./run-pin.ts";
import { findRun, type Run } from "./run-store.ts";
import { result, startRun } from "./run-service.ts";

/** What the session's tools, the panel and the CLI share: they only append events and read the run's state. */

/** A 1.5 run has no daemon: this client neither answers nor cancels it. */
function daemonRun(id: string): Run {
  const run = findRun(id);
  if (!isDaemonRun(run))
    throw new CatherdError("E_RUN_NOT_LIVE", `run ${id} is a 1.5 run: catherd 2.0 does not drive it`, {
      fix: "finish it with catherd 1.x",
    });
  return run;
}

/**
 * Spec D16: a run an earlier build started is read here, never driven: an answer, a cancel or a pause would wake no
 * daemon of this build. The owner finishes it with the build that started it.
 */
function drivenRun(id: string): Run {
  const run = daemonRun(id);
  if (isEarlierRun(run)) {
    const v = readEvents(run).findLast((e) => e.type === "daemon.started");
    const at = v?.type === "daemon.started" ? v.version : "<its version>";
    throw new CatherdError(
      "E_RUN_NOT_LIVE",
      `run ${id} was started by catherd ${at}: this catherd does not drive it`,
      {
        fix: `finish it with npx catherd-cli@${at}`,
      },
    );
  }
  return run;
}

/**
 * Starts a 2.0 run: its folder, its pin, `run.started`, and its daemon. The owner's plan files (`plan`, and any
 * `plan:` A-line) are checked before the run exists, copied into it, and approved as input. A daemon that does
 * not start is reported, not thrown: the run exists, and `status(run)` starts its daemon again.
 */
export async function runStart(
  deps: Deps,
  i: { repo: string; title: string; aLines: string[]; plan?: string[]; base?: string },
): Promise<{
  run: string;
  dir: string;
  daemon: "revived" | "alive" | "failed";
  warning?: string;
  notifyUrl: string;
  plan: string[];
  next: string;
}> {
  const top = await gitToplevel(i.repo);
  // a repo outside git is startRun's refusal
  const plan = top ? resolvePlanInputs(top, [...(i.plan ?? []), ...planInputPaths(i.aLines)]) : [];
  // plan 47: the architect works in the repository's checkout; a branch and its MR come with landing (plan 50)
  if (i.base)
    throw new CatherdError("E_INPUT_INVALID", "a run does not take a base yet", {
      fix: "start without base: the run works in the repository's checkout",
    });
  const started = await startRun(deps, { repo: i.repo, title: i.title, aLines: i.aLines, base: i.base });
  const run = findRun(started.run);
  copyPlanInputs(run, plan);
  await appendEvent(
    run,
    {
      type: "run.started",
      repo: run.meta.repo,
      title: i.title,
      aLines: i.aLines,
      plan,
      base: i.base ?? null,
      rolesOff: ROLES.filter((r) => !runProfile(deps, run).roles[r]?.enabled),
      caps: runProfile(deps, run).caps ?? DEFAULT_CAPS,
    },
    new Date(deps.now()),
  );
  // the architect reads the owner's plan files as input it may edit; nothing approves them (spec D2)
  const notifyUrl = deps.profiles.notifyUrl();
  let daemon: "revived" | "alive" | "failed";
  let warning: string | undefined;
  try {
    daemon = ensureDaemon(run) === "alive" ? "alive" : "revived";
  } catch (e) {
    daemon = "failed";
    warning = `the run started, its daemon did not: ${errorMessage(e)}; status(run) starts it again`;
  }
  return {
    run: run.id,
    dir: run.dir,
    daemon,
    ...(warning === undefined ? {} : { warning }),
    notifyUrl,
    plan,
    next: `the architect drives the run from its ledger and asks you only what it must: status(run) shows it; questions reach ${notifyUrl} and this session`,
  };
}

/** Answers a parked unit: the owner's words reach the daemon as `question.answered`. */
export async function answerUnit(
  deps: Deps,
  i: { run: string; unit: string; answer: string },
): Promise<{ unit: string; parked: string[] }> {
  const run = drivenRun(i.run);
  // the check and the append are one step: two answers to one question never both get through
  await withEventsLock(run, async (add) => {
    const state = replayRun(run);
    const open = Object.keys(state.questions);
    if (!open.includes(i.unit))
      throw new CatherdError("E_INPUT_INVALID", `${i.unit} has no open question`, {
        fix: open.length
          ? `the open ones: ${open.join(", ")}`
          : "status(run) shows the run's state: nothing waits for an answer now",
      });
    // the owner answers when they have fixed the plan: the roles read the copies, so copy again
    if (state.plan.length) copyPlanInputs(run, state.plan);
    // a milestone's park is in questions.jsonl too, which land's gate reads (both go in plan 50)
    if (openQuestions(run).some((q) => q.milestone === i.unit))
      await answer(deps, { run: run.id, milestone: i.unit, answer: i.answer });
    add({ type: "question.answered", unit: i.unit, answer: i.answer, by: "owner" }, new Date(deps.now()));
  });
  ensureDaemon(run);
  return { unit: i.unit, parked: Object.keys(replayRun(run).questions) };
}

/** Cancels the run; asking twice appends nothing. The daemon stops every live role, then ends the run. */
export async function cancelRun(
  deps: Deps,
  i: { run: string },
): Promise<{ cancelling: true; live: string[] }> {
  const run = drivenRun(i.run);
  const s = replayRun(run);
  const live = liveDispatches(s).map((d) => d.name);
  if (!s.cancelling && s.phase !== "ended") {
    await appendEvent(run, { type: "cancel.requested", by: "owner" }, new Date(deps.now()));
    ensureDaemon(run);
  }
  return { cancelling: true, live };
}

/** The check and the append are one step under the events lock: asking for the state the run has appends nothing. */
async function setPaused(deps: Deps, run: Run, want: boolean): Promise<void> {
  await withEventsLock(run, (add) => {
    const s = replayRun(run);
    if (s.phase === "ended")
      throw new CatherdError("E_RUN_NOT_LIVE", `run ${run.id} has ended`, {
        fix: "status(run) shows how it ended",
      });
    if ((s.paused !== null) !== want)
      add({ type: want ? "run.paused" : "run.resumed", by: "owner" }, new Date(deps.now()));
  });
  ensureDaemon(run);
}

/** Pauses the run: live roles finish, nothing new starts. Asking twice appends nothing. */
export async function pauseRun(deps: Deps, i: { run: string }): Promise<{ paused: true; since: string }> {
  const run = drivenRun(i.run);
  await setPaused(deps, run, true);
  return { paused: true, since: replayRun(run).paused as string };
}

/** Lifts the pause: the held dispatches start at once. Asking twice appends nothing. */
export async function resumeRun(deps: Deps, i: { run: string }): Promise<{ paused: false }> {
  await setPaused(deps, drivenRun(i.run), false);
  return { paused: false };
}

export interface RunResult {
  phase: ReturnType<typeof replayRun>["phase"];
  outcome: ReturnType<typeof replayRun>["outcome"];
  reportPath: string | null;
  report: string | null;
  milestones: {
    id: string;
    status: string;
    commit: string | null;
    digestPath: string | null;
    knownIssues: string[];
  }[];
  /** with a name: the role's record, as 1.5's `result(run, name)` gives it */
  role?: unknown;
}

/** The run's outcome and report; with a role's name, that role's record too. */
export async function runResult(deps: Deps, i: { run: string; name?: string }): Promise<RunResult> {
  const run = daemonRun(i.run);
  const s = replayRun(run);
  const file = join(run.dir, "report.md");
  const has = existsSync(file);
  return {
    phase: s.phase,
    outcome: s.outcome,
    reportPath: has ? file : null,
    report: has ? readFileSync(file, "utf8") : null,
    // plan 48: an architect run's milestones are its ledger tasks
    milestones: ledgerOf(run, s).map((t) => ({
      id: t.id,
      status: t.state,
      commit: null,
      digestPath: null,
      knownIssues: [],
    })),
    ...(i.name === undefined ? {} : { role: await result(deps, { run: run.id, name: i.name }) }),
  };
}

/** The one `profile` tool: get, validate or set a profile, and the phone's topic url. */
export function profileTool(
  deps: Deps,
  i: {
    action: "get" | "validate" | "set";
    name?: string;
    repo?: string;
    patch?: ProfilePatch;
    notifyUrl?: string;
  },
): unknown {
  const repo = i.repo ?? null;
  if (i.notifyUrl !== undefined) {
    deps.profiles.setNotifyUrl(i.notifyUrl);
    if (i.action === "set" && i.patch === undefined) return { notifyUrl: deps.profiles.notifyUrl() };
  }
  switch (i.action) {
    case "get":
      return deps.profiles.get(i.name, repo);
    case "validate":
      return deps.profiles.validate(i.name, repo);
    case "set":
      return deps.profiles.set(i.name, i.patch ?? {}, repo);
  }
}
