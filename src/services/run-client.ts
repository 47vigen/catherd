import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CatherdError } from "../domain/errors.ts";
import type { ProfilePatch } from "../domain/profile.ts";
import { ROLES } from "../domain/roles.ts";
import { liveDispatches } from "../domain/run-state.ts";
import { ensureDaemon } from "./daemon.ts";
import type { Deps } from "./ports.ts";
import { answer, openQuestions } from "./questions.ts";
import { appendEvent, isDaemonRun, readEvents, replayRun, withEventsLock } from "./run-events-store.ts";
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

/** Starts a 2.0 run: its folder, its pin, `run.started`, and its daemon. */
export async function runStart(
  deps: Deps,
  i: { repo: string; title: string; aLines: string[] },
): Promise<{ run: string; dir: string; daemon: "revived" | "alive"; notifyUrl: string; next: string }> {
  const started = await startRun(deps, i);
  const run = findRun(started.run);
  await appendEvent(
    run,
    {
      type: "run.started",
      repo: run.meta.repo,
      title: i.title,
      aLines: i.aLines,
      plan: [],
      base: null,
      engine: "2.0",
      rolesOff: ROLES.filter((r) => !runProfile(deps, run).roles[r]?.enabled),
    },
    new Date(deps.now()),
  );
  const notifyUrl = deps.profiles.notifyUrl();
  const daemon = ensureDaemon(run) === "alive" ? "alive" : "revived";
  return {
    run: run.id,
    dir: run.dir,
    daemon,
    notifyUrl,
    next: `the run drives itself: status(run) shows it; parked questions reach ${notifyUrl} and this session`,
  };
}

/** Answers a parked unit: the owner's words reach the daemon as `question.answered`. */
export async function answerUnit(
  deps: Deps,
  i: { run: string; unit: string; answer: string },
): Promise<{ unit: string; parked: string[] }> {
  const run = daemonRun(i.run);
  // the check and the append are one step: two answers to one question never both get through
  await withEventsLock(run, async (add) => {
    const open = Object.keys(replayRun(run).questions);
    if (!open.includes(i.unit))
      throw new CatherdError("E_INPUT_INVALID", `${i.unit} has no open question`, {
        fix: open.length
          ? `the open ones: ${open.join(", ")}`
          : "status(run) shows the run's state: nothing waits for an answer now",
      });
    // a milestone's park is in questions.jsonl too, which land's gate reads
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
  const run = daemonRun(i.run);
  const s = replayRun(run);
  const live = liveDispatches(s).map((d) => d.name);
  if (!s.cancelling && s.phase !== "ended") {
    await appendEvent(run, { type: "cancel.requested", by: "owner" }, new Date(deps.now()));
    ensureDaemon(run);
  }
  return { cancelling: true, live };
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
  const digests = new Map(
    readEvents(run).flatMap((e) =>
      e.type === "milestone.landed" ? [[e.milestone, e.digestPath] as const] : [],
    ),
  );
  const file = join(run.dir, "report.md");
  const has = existsSync(file);
  return {
    phase: s.phase,
    outcome: s.outcome,
    reportPath: has ? file : null,
    report: has ? readFileSync(file, "utf8") : null,
    milestones: s.milestones.map((m) => ({
      id: m.id,
      status: m.status,
      commit: m.commit,
      digestPath: digests.get(m.id) ?? null,
      knownIssues: m.knownIssues,
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
