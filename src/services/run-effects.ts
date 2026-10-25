import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeSubject, mrCommand, unitMilestone } from "../domain/branch.ts";
import { CatherdError, errorMessage, isCatherdError } from "../domain/errors.ts";
import {
  type BlockedReason,
  foreignFailure,
  parseBlockedReason,
  siblingLanesNamed,
} from "../domain/blocked.ts";
import { quotaOf } from "../domain/failover.ts";
import { fileOf, parseFailLines, parseFindings, unlistedFail } from "../domain/findings.ts";
import { headlessRung, tryParseRung } from "../domain/ids.ts";
import { type JudgeKind, judgeName, parseJudgeReply } from "../domain/judge.ts";
import { milestoneAfter, onlyAllowedHits, parseLaneHeader } from "../domain/lane.ts";
import { milestoneProblems } from "../domain/plan-lint.ts";
import { mayStartMilestone, memoryLimitsOf, memoryLoad, neededMb } from "../domain/milestone-memory.ts";
import { changedDecisions, formatCommand, milestoneCheck, reapprovalQuestion } from "../domain/plan-doc.ts";
import type { RunRecord } from "../domain/record.ts";
import { currentRoute } from "../domain/route.ts";
import type { Role } from "../domain/roles.ts";
import { type Finding, type MilestonePlan, RUN_UNIT, type RunEventInput } from "../domain/run-events.ts";
import { type Action, unitOf } from "../domain/run-machine.ts";
import { lanesOf, milestoneOf, ownerOfFile, type RunState } from "../domain/run-state.ts";
import { endCollect, requestCancel, tryCollect } from "../infra/dispatch-dir.ts";
import { currentBranch, fetchBase, gitOrigin, gitRun, isAncestor, worktreeIdentity } from "../infra/git.ts";
import { heavyLimits, heavySlots, LOCK_HELD_ENV, type LockWait, withHeavySlot } from "../infra/heavy-lock.ts";
import { log } from "../infra/log.ts";
import { admit } from "./admission.ts";
import { cancel, launcher } from "./dispatch-service.ts";
import { type Dispatch, listDispatches } from "./dispatches.ts";
import { finalizeDispatch, waitForFinish } from "./finalize.ts";
import { failoverRung } from "./failover-rungs.ts";
import { climb, land, routeLanes } from "./lane-service.ts";
import { blockedByEnvironment, landedCommitOf, replyVerdict } from "./milestones.ts";
import {
  freshFailures,
  machineGate,
  missingBaselines,
  readChecks,
  runMilestoneCheck,
  verdictCarries,
} from "./milestone-check.ts";
import { baseTree, branchPusher, claimTree, memoryReader, removeTree } from "./milestone-tree.ts";
import { sendRunNotice } from "./notify-service.ts";
import {
  deliveredALines,
  deliveredALineTexts,
  planDocs,
  planProblems,
  uncoveredALines,
} from "./plan-input.ts";
import type { Deps } from "./ports.ts";
import { checkEnvFor, preflight, runCheck } from "./preflight.ts";
import { park } from "./questions.ts";
import { briefFor, judgeBrief } from "./run-briefs.ts";
import { appendEvent, appendEvents, readEvents, replayRun, withEventsLock } from "./run-events-store.ts";
import { writeRunReport } from "./run-report.ts";
import { cheapestRung } from "./routing-service.ts";
import { runProfile } from "./run-pin.ts";
import { appendRoute, readRecords, readRoutes, type Run, runPaths } from "./run-store.ts";
import { composeProjectOf, treeOf } from "./tree-path.ts";
import { refreshState } from "./state.ts";

/**
 * What carries the machine's actions out. `run` appends the events the action produces (a long one when it is
 * done), never throws: a failure becomes an `effect.failed` event.
 */
export interface Effects {
  run(a: Action, state: RunState): Promise<void>;
}

/** Limits a test shortens. */
export const effectLimits = { checkMs: 600_000, commitMs: 300_000 };

/** The milestone check the daemon runs (plan 40 D1); a test replaces it. */
export const milestoneChecker = { run: runMilestoneCheck };

/** The most failing lines of one item that become findings; the rest stay in its check log. */
const FINDINGS_PER_ITEM = 20;
const MERGE_ATTEMPTS = 3;
/** a push refused only because origin moved since the fetch; a hook refusal or a conflict is not this */
const LOST_RACE = /\((?:fetch first|non-fast-forward)\)|cannot lock ref|failed to update ref/;

type CheckInput = Parameters<typeof runMilestoneCheck>[0];

/** Runs a check until it answers: past its wait limit it answers running, and the next call waits for the same run. */
async function untilChecked(i: CheckInput, o: { onWait?: (w: LockWait | null) => void }): Promise<void> {
  let r = await milestoneChecker.run(i, o);
  while (r.running) r = await milestoneChecker.run(i, o);
}

/** The lane a finding's file belongs to, by the longest `Owns:` entry. */
export const ownerOf = ownerOfFile;

const read = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/** A lane's `Owns:` entries, and those of the other lanes of its milestone; empty when a lane file is gone. */
function laneOwnsOf(
  run: Run,
  lane: string,
): {
  own: string[];
  siblings: string[];
  lanes: { id: string; owns: string[] }[];
} {
  const dir = runPaths(run.dir).lanes;
  const prefix = lane.slice(0, lane.indexOf(".") + 1);
  const owns = (id: string): string[] => parseLaneHeader(read(join(dir, `${id}.md`))).owns;
  const ids = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".md") && f.startsWith(prefix))
        .map((f) => f.slice(0, -3))
    : [];
  const lanes = ids.filter((id) => id !== lane).map((id) => ({ id, owns: owns(id) }));
  return { own: owns(lane), siblings: lanes.flatMap((l) => l.owns), lanes };
}

/** The sibling entries a failed lane check blames when it blames only them: the lane counts as done. */
function foreignOf(run: Run, lane: string, log: string): string[] {
  const { own, siblings } = laneOwnsOf(run, lane);
  return foreignFailure(log, own, siblings);
}

/** The sibling lanes a failed lane check names, whether or not it names the lane's own files too. */
function siblingsOf(run: Run, lane: string, log: string): string[] {
  return siblingLanesNamed(log, laneOwnsOf(run, lane).lanes);
}

const FIRST_LINE = /^VERDICT:\s*FAIL\b/i;
const PASS_LINE = /^VERDICT: PASS\b/;

/**
 * The `dispatch.ended` event of a finished dispatch: the record's status, the reply's findings (a reviewer's
 * BLOCKER, BUG and NIT lines, a failing verifier's lines) and the verifier's verdict, the reason a blocked reply
 * names, the HEAD a verifier checked, and the sibling files a `check_broken` lane blames.
 */
export function endedEvent(run: Run, record: RunRecord, unit: string): RunEventInput {
  const reply = record.replyPath ? read(join(run.dir, record.replyPath)) : "";
  let verdict: "pass" | "fail" | "blocked" | null = null;
  let probe: string | null = null;
  let findings = record.role === "reviewer" || record.role === "ui-reviewer" ? parseFindings(reply) : [];
  if (record.role === "verifier") {
    const first = replyVerdict(run, record) ?? "";
    probe = blockedByEnvironment(first);
    if (probe !== null) verdict = "blocked";
    else if (PASS_LINE.test(first)) {
      verdict = "pass";
      // plan 34: a PASS lands with the NITs it lists as known issues
      findings = parseFindings(reply).filter((f) => f.label === "NIT");
    }
    // a reply with no readable verdict is not a pass: the next fix round starts from what it said
    else if (record.status === "ok") verdict = "fail";
    if (verdict === "fail") {
      findings = parseFailLines(reply);
      // a FAIL that lists no failing line still routes what it said, so the fix round never starts empty
      if (findings.length === 0)
        findings = FIRST_LINE.test(first)
          ? [unlistedFail(reply)]
          : [
              {
                label: "BLOCKER",
                text: `no VERDICT line: ${first || "empty reply"}`,
                file: null,
              },
            ];
    }
  }
  const stopped = record.replyStatus === "blocked" || record.replyStatus === "refused";
  const reason = stopped ? (parseBlockedReason(record.replyWhy)?.reason ?? null) : null;
  return {
    type: "dispatch.ended",
    dispatchId: record.dispatchId,
    name: record.name,
    unit,
    status: record.status,
    replyStatus: record.replyStatus,
    reason,
    why: record.replyWhy ?? record.error?.message ?? "",
    thread: record.thread,
    head: record.head ?? null,
    environment: record.environment ?? (probe ? probe : null),
    verdict,
    findings,
    foreign: reason === "check_broken" && record.lane ? foreignOf(run, record.lane, reply) : [],
    siblings: reason === "check_broken" && record.lane ? siblingsOf(run, record.lane, reply) : [],
    replyPath: record.replyPath,
  };
}

const ID = /^M[\w-]*\.\S+$/;
const HEADING = /^##\s+(M\d+)\b\s*(?:[—–:.-]\s*)?(.*)$/;
const AFTER = /^\s*[*_]*After[*_]*\s*:[*_]*\s*(.*)$/i;

const ROLE_OF_KIND: Record<string, Role> = {
  prose: "writer",
  research: "researcher",
};

/** The plan the architect wrote: milestones from plan.md's `## M<n> …` headings, their lanes from lanes/*.md. */
export function planOf(run: Run): MilestonePlan[] {
  const dir = runPaths(run.dir).lanes;
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
  const natural = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });
  const lanes = files
    .map((f) => f.slice(0, -3))
    .filter((id) => ID.test(id))
    .sort(natural)
    .map((id) => {
      const text = read(join(dir, `${id}.md`));
      const h = parseLaneHeader(text);
      return {
        id,
        milestone: id.slice(0, id.indexOf(".")),
        role: (h.kind ? ROLE_OF_KIND[h.kind] : undefined) ?? ("worker" as Role),
        kind: h.kind,
        after: h.after,
        owns: h.owns,
        // without the Owns: line, which owns_add rewrites while a lane runs (plan 43 D6)
        digest: createHash("sha256")
          .update(text.replace(/^Owns:.*(?:\r?\n|$)/gm, ""))
          .digest("hex")
          .slice(0, 16),
      };
    });
  if (lanes.length === 0) throw new CatherdError("E_LANE_INVALID", "the architect wrote no lane files");
  const heads: { id: string; title: string; after: string[] }[] = [];
  for (const line of read(runPaths(run.dir).plan).split("\n")) {
    const h = HEADING.exec(line);
    if (h)
      heads.push({
        id: h[1] as string,
        title: (h[2] ?? "").trim() || (h[1] as string),
        after: [],
      });
    else if (line.startsWith("## ")) heads.push({ id: "", title: "", after: [] });
    else if (heads.length) {
      const a = AFTER.exec(line)?.[1];
      if (a) (heads.at(-1) as { after: string[] }).after.push(...(a.match(/\bM\d+\b/g) ?? []));
    }
  }
  const known = heads.filter((h) => h.id);
  const ids = [...new Set([...known.map((h) => h.id), ...lanes.map((l) => l.milestone).sort(natural)])];
  return ids.flatMap((id) => {
    const mine = lanes.filter((l) => l.milestone === id);
    if (mine.length === 0) return [];
    const head = known.find((h) => h.id === id);
    return [
      {
        id,
        title: head?.title ?? id,
        // a plan.md heading's After: line, and the milestones the milestone's lanes name (plan 35 D7)
        after: [
          ...new Set([
            ...(head?.after ?? []).filter((a) => a !== id),
            ...milestoneAfter(
              lanes.map((l) => ({ id: l.id, after: l.after })),
              id,
            ),
          ]),
        ].sort(natural),
        lanes: mine.map(({ milestone: _m, ...l }) => l),
      },
    ];
  });
}

/** Milestones whose dependencies add to a matching section of an owner or approved plan. */
function widenedAfter(run: Run, plan: MilestonePlan[]): { milestone: string; added: string[] }[] {
  const sources = replayRun(run).plan.length ? planDocs(run).map((doc) => doc.text) : [];
  const approved = read(join(run.dir, "plan-approved.md"));
  if (approved) sources.push(approved);
  const prior = sources.map((text) => {
    const sections = new Map<string, Set<string>>();
    let current: Set<string> | undefined;
    for (const line of text.split("\n")) {
      const heading = HEADING.exec(line);
      if (heading) {
        current = new Set();
        sections.set(heading[1] as string, current);
      } else if (line.startsWith("## ")) current = undefined;
      else {
        const after = AFTER.exec(line)?.[1];
        if (after) for (const id of after.match(/\bM\d+\b/g) ?? []) current?.add(id);
      }
    }
    return sections;
  });
  return plan.flatMap((m) => {
    const approvedAfter = approved ? prior.at(-1)?.get(m.id) : undefined;
    const baselines = approvedAfter
      ? [approvedAfter]
      : prior.flatMap((sections) => {
          const after = sections.get(m.id);
          return after ? [after] : [];
        });
    const added = m.after.filter((id) => baselines.some((after) => !after.has(id)));
    return added.length ? [{ milestone: m.id, added }] : [];
  });
}

const outcomeNext = (outcome: "done" | "cancelled" | "failed"): string =>
  `the run ${outcome === "done" ? "finished" : outcome}; read report.md for what landed and what remains`;

const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** The last `n` lines of what a command printed. */
const tailOf = (text: string, n = 40): string =>
  text
    .split("\n")
    .filter((l) => l.trim())
    .slice(-n)
    .join("\n");

/** The effects that carry a run's actions out through the existing services. */
export function realEffects(deps: Deps, run: Run): Effects {
  const at = (): Date => new Date(deps.now());
  const append = (e: RunEventInput) => appendEvent(run, e, at());
  /** A step's first lock wait, as one `lock.waiting` event; the event is written while the wait goes on. */
  const waitingOnce = (unit: string): ((w: LockWait | null) => void) => {
    let told = false;
    return (w) => {
      if (!w || told) return;
      told = true;
      append({
        type: "lock.waiting",
        unit,
        lock: w.lock,
        holder: w.holder,
        ahead: w.ahead,
      }).catch((e) => log("warn", "daemon", { run: run.id, unit, error: errorMessage(e) }));
    };
  };
  const watching = new Set<string>();

  const heldQuotas = (s: RunState): string[] =>
    Object.entries(s.holds)
      .filter(([, until]) => until > s.at)
      .map(([q]) => q);

  /** Plan 33: every failover, chosen or none, is a row in routes.jsonl; a failed append never fails the dispatch. */
  function recordFailover(
    a: { name: string; role: Role; lane: string | null },
    from: string,
    rung: string | null,
    s: RunState,
  ): void {
    try {
      appendRoute(run, {
        at: at().toISOString(),
        lane: a.lane,
        role: a.role,
        name: a.name,
        source: "failover",
        from,
        rung,
        why: rung
          ? `failed over from ${from} to ${rung}`
          : `no stand-in for ${from}: every candidate is held or below it`,
        held: heldQuotas(s).sort(),
      });
    } catch (e) {
      log("warn", "routes", { failover: errorMessage(e) });
    }
  }

  /** The rung a dispatch runs on, or a refusal's code and message. */
  async function rungFor(
    a: {
      name: string;
      role: Role;
      lane: string | null;
      rung: string | null;
      failoverFrom: string | null;
      cheap?: boolean;
    },
    s: RunState,
  ): Promise<{ rung: string } | { code: string; message: string }> {
    const profile = runProfile(deps, run);
    let rung = a.failoverFrom ?? a.rung;
    // a mechanical fix runs once on the cheapest rung; the held-quota check below still applies to it
    if (a.cheap && !a.failoverFrom) rung = cheapestRung(profile, a.role, run.meta.repo, run.dir) ?? rung;
    if (!rung && a.lane) rung = currentRoute(readRoutes(run), a.lane)?.rung ?? null;
    if (!rung && a.role === "judge") rung = profile.roles.judge?.rungs[0] ?? null;
    if (!rung) {
      const [routed] = await routeLanes(deps, {
        run: run.id,
        laneFiles: [undefined],
        role: a.role,
      });
      rung = routed?.rung ?? null;
    }
    if (!rung) throw new CatherdError("E_ADMIT_RUNG", `no rung for the ${a.role}`);
    const parsed = tryParseRung(rung);
    const held = heldQuotas(s);
    if (a.failoverFrom || (parsed !== null && held.includes(quotaOf(parsed)))) {
      const stand = failoverRung(deps, run, a.role, rung, held);
      recordFailover(a, a.failoverFrom ?? rung, stand, s);
      if (!stand)
        return {
          code: "E_ALL_HELD",
          message: `every rung of the ${a.role} is on a held quota (${held.join(", ")})`,
        };
      rung = stand;
    }
    return { rung: headlessRung(rung) };
  }

  /** Waits for a dispatch to end, then appends what it said: a judge's decision first, then `dispatch.ended`. */
  async function settle(
    d: Dispatch,
    unit: string,
    judge: { id: string; kind: JudgeKind } | null,
  ): Promise<void> {
    const id = d.admit.dispatchId;
    if (watching.has(id)) return;
    watching.add(id);
    try {
      await waitForFinish(d, { pollMs: deps.pollMs, now: deps.now });
      const record = await finalizeDispatch(run, d);
      if (replayRun(run).dispatches[id]?.ended) return;
      // a daemon that died between judge.decided and dispatch.ended decided it already
      const decidedBefore = readEvents(run).some((e) => e.type === "judge.decided" && e.dispatchId === id);
      if (judge && record.status !== "limit" && !decidedBefore) {
        const reply = record.replyPath ? read(join(run.dir, record.replyPath)) : "";
        const decision = record.status === "ok" ? parseJudgeReply(reply, judge.kind) : null;
        await append(
          decision
            ? {
                type: "judge.decided",
                id: judge.id,
                unit,
                kind: judge.kind,
                decision,
                dispatchId: id,
              }
            : {
                type: "judge.failed",
                id: judge.id,
                unit,
                why:
                  record.status === "ok"
                    ? "the reply holds no decision its kind allows"
                    : `the judge ${record.status}`,
              },
        );
      }
      await append(endedEvent(run, record, unit));
      // catherd announces nothing about a role of a daemon run: the run's reports do
      if (await tryCollect(d.dir)) endCollect(d.dir);
    } finally {
      watching.delete(id);
    }
  }

  const judgeOf = (name: string, s: RunState): { id: string; kind: JudgeKind } | null => {
    const id = name.replace(/^judge-/, "");
    return name.startsWith("judge-") ? { id, kind: s.judges[id]?.kind ?? "unexpected" } : null;
  };

  /** An admitted dispatch of `name` that the log never heard of. */
  const orphanOf = (name: string, s: RunState): Dispatch | undefined =>
    listDispatches(run).find((d) => d.admit.name === name && !s.dispatches[d.admit.dispatchId]);

  /** Plan 43 D10: the lane's rung under the profile as it is now, recorded as routed; null when it is the same rung or none. */
  async function rerouteLane(
    lane: string,
    role: Role,
    milestone: string,
    was: string,
  ): Promise<string | null> {
    let routed: Awaited<ReturnType<typeof routeLanes>>[number] | undefined;
    try {
      [routed] = await routeLanes(deps, { run: run.id, laneFiles: [`lanes/${lane}.md`], role });
    } catch {
      return null;
    }
    const rung = routed ? headlessRung(routed.rung) : null;
    if (!routed || !rung || rung === was) return null;
    await append({
      type: "lanes.routed",
      milestone,
      lanes: [{ lane, rung: routed.rung, ladder: routed.ladder }],
    });
    return rung;
  }

  async function start(
    a: {
      unit: string;
      name: string;
      role: Role;
      lane: string | null;
      rung: string | null;
      thread: string | null;
      failoverFrom: string | null;
    },
    brief: string,
    s: RunState,
    judge: { id: string; kind: JudgeKind } | null,
  ): Promise<void> {
    const refuse = (code: string, message: string) =>
      append({
        type: "dispatch.refused",
        name: a.name,
        unit: a.unit,
        code,
        message,
      });
    // the daemon died between its admission and its event: the dispatch is recorded and watched, never launched twice
    const adopt = async (found: Dispatch): Promise<void> => {
      await append({
        type: "dispatch.started",
        dispatchId: found.admit.dispatchId,
        name: a.name,
        role: a.role,
        unit: a.unit,
        lane: a.lane,
        rung: found.admit.rung,
        thread: found.admit.thread,
        ...(judge ? { judgeKind: judge.kind } : {}),
      });
      await settle(found, a.unit, judge);
    };
    const orphan = orphanOf(a.name, s);
    if (orphan) return adopt(orphan);
    const picked = await rungFor(a, s);
    if ("code" in picked) return void (await refuse(picked.code, picked.message));
    const tryAdmit = (rung: string, thread: string | null) =>
      admit(deps, run, {
        role: a.role,
        name: a.name,
        brief,
        rung,
        thread,
        lane: a.lane,
        failoverFrom: a.failoverFrom,
        // plan 35: a base run's milestone works in its own worktree
        cwd: treeOf(run, unitMilestone(a.unit)),
      });
    let admitted: Awaited<ReturnType<typeof admit>>;
    try {
      admitted = await tryAdmit(picked.rung, a.thread).catch(async (e: unknown) => {
        // plan 43 D10: a profile edit can leave a lane's rung off its ladder; route the lane again, admit once more
        const m = unitMilestone(a.unit);
        if (!isCatherdError(e) || e.code !== "E_ADMIT_RUNG" || a.failoverFrom || !a.lane || m === null)
          throw e;
        const again = await rerouteLane(a.lane, a.role, m, picked.rung);
        if (!again) throw e;
        // the old rung's thread resumes only on its own backend
        const same = tryParseRung(again)?.backend === tryParseRung(picked.rung)?.backend;
        return tryAdmit(again, same ? a.thread : null);
      });
    } catch (e) {
      if (!isCatherdError(e)) throw e;
      if (e.code === "E_ADMIT_DUPLICATE") {
        const orphan = orphanOf(a.name, s);
        if (orphan) return await adopt(orphan);
      }
      return void (await refuse(e.code, e.message));
    }
    const { d, specPath } = admitted;
    // a cancel that landed while this start was in flight: the role must not start after the run is cancelled
    const now = replayRun(run);
    if (now.cancelling || now.phase === "ended") {
      requestCancel(d.dir);
      await finalizeDispatch(run, d);
      if (await tryCollect(d.dir)) endCollect(d.dir);
      return void (await refuse("E_RUN_CANCELLED", "the run was cancelled before the role started"));
    }
    try {
      launcher.launch(d, specPath);
    } catch (e) {
      // watched all the same: a dispatch that never started is recorded as lost once its start grace passes
      log("warn", "daemon", {
        run: run.id,
        name: a.name,
        launch: errorMessage(e),
      });
    }
    await append({
      type: "dispatch.started",
      dispatchId: d.admit.dispatchId,
      name: a.name,
      role: a.role,
      unit: a.unit,
      lane: a.lane,
      rung: d.admit.rung,
      thread: a.thread,
      ...(judge ? { judgeKind: judge.kind } : {}),
    });
    await settle(d, a.unit, judge);
  }

  /**
   * The architect's plan into `plan.ready`, once the plan backs every lane. A gap is `effect.failed`: its architect
   * is sent back with it. An edit to a decision the owner approved asks them again before the plan is read.
   */
  async function readPlan(): Promise<void> {
    const milestones = planOf(run);
    const problems = [...planProblems(run), ...milestoneProblems(milestones)];
    if (problems.length > 0) {
      await append({
        type: "effect.failed",
        action: "readPlan",
        unit: RUN_UNIT,
        message: `the plan needs: ${problems.join("; ")}`,
      });
      return;
    }
    const approved = read(join(run.dir, "plan-approved.md"));
    const changed = approved ? changedDecisions(approved, read(runPaths(run.dir).plan)) : [];
    const widened = widenedAfter(run, milestones);
    const questions = [
      ...(changed.length ? [reapprovalQuestion(run.id, changed)] : []),
      ...(widened.length
        ? [
            `The plan adds milestone dependencies: ${widened.map((m) => `${m.milestone} now waits for ${m.added.join(", ")}`).join("; ")}. Approve with: catherd answer ${run.id} run approve`,
          ]
        : []),
    ];
    // one write: a crash between the two would lose the owner's change request
    await appendEvents(
      run,
      [
        ...(questions.length > 0
          ? [
              {
                type: "question.parked" as const,
                unit: RUN_UNIT,
                question: questions.join("\n\n"),
                reason: "approval" as const,
              },
            ]
          : []),
        { type: "plan.ready", milestones },
      ],
      at(),
    );
  }

  async function route(a: Extract<Action, { type: "route" }>, s: RunState): Promise<void> {
    const lanes = lanesOf(s, a.milestone);
    const roles = [...new Set(lanes.map((l) => l.role))];
    const routed: { lane: string; rung: string; ladder: string[] }[] = [];
    for (const role of roles) {
      const ids = lanes.filter((l) => l.role === role).map((l) => l.id);
      const out = await routeLanes(deps, {
        run: run.id,
        laneFiles: ids.map((id) => `lanes/${id}.md`),
        role,
      });
      for (const r of out) if (r.lane) routed.push({ lane: r.lane, rung: r.rung, ladder: r.ladder });
    }
    await append({
      type: "lanes.routed",
      milestone: a.milestone,
      lanes: routed,
    });
    const rep = await preflight(deps, {
      run: run.id,
      milestone: a.milestone,
      confirmed: a.confirmed,
    });
    await append(
      rep.needsConfirmation
        ? {
            type: "preflight.done",
            milestone: a.milestone,
            blocking: [],
            confirm: rep.commands.map((c) => `${c.lane}: ${c.check ?? "(no fast check)"}`),
            lint: rep.lint,
          }
        : {
            type: "preflight.done",
            milestone: a.milestone,
            blocking: rep.results
              .filter((r) => r.outcome === "cannot-start")
              .map((r) => ({
                lane: r.lane,
                note: r.note ?? (tailOf(r.tail.join("\n"), 3) || "cannot start"),
              })),
            confirm: null,
            lint: rep.lint,
          },
    );
  }

  async function fastCheck(a: Extract<Action, { type: "fastCheck" }>): Promise<void> {
    const header = parseLaneHeader(read(join(runPaths(run.dir).lanes, `${a.lane}.md`)));
    if (!header.fastCheck) {
      await append({
        type: "check.ran",
        lane: a.lane,
        exit: 0,
        tail: "the lane has no fast check",
        foreign: [],
      });
      return;
    }
    const check = header.fastCheck;
    const cwd = treeOf(run, unitMilestone(a.lane));
    const env = await checkEnvFor(run.meta.repo);
    const compose = composeProjectOf(run, unitMilestone(a.lane));
    if (compose) env.COMPOSE_PROJECT_NAME ??= compose;
    const slots = heavySlots(runProfile(deps, run).heavy);
    const requested = Date.now();
    const { tree, r, startedAt, durationMs, waitedMs } = await withHeavySlot(
      slots,
      async (_slot, tmp) => {
        const tree = await worktreeIdentity(cwd);
        const started = Date.now();
        const r = await runCheck(cwd, check, effectLimits.checkMs, {
          ...env,
          TMPDIR: tmp,
          GOTMPDIR: tmp,
          // a `catherd lock` inside the check runs at once: this check holds its slot already
          [LOCK_HELD_ENV]: "1",
        });
        return {
          tree,
          r,
          startedAt: new Date(started).toISOString(),
          durationMs: Date.now() - started,
          waitedMs: started - requested,
        };
      },
      { onWait: waitingOnce(a.lane) },
    );
    // an absence check whose only hits are the lane's Allow: exceptions has passed
    const allowed = r.code !== 0 && !r.timedOut && onlyAllowedHits(r.lines, header.allow);
    const failed = !allowed && r.code !== 0;
    await append({
      type: "check.ran",
      lane: a.lane,
      exit: allowed ? 0 : r.code,
      tail: r.tail.join("\n"),
      tree,
      // a check that fails only in a sibling's files still counts: the sibling is not done writing them
      foreign: failed ? foreignOf(run, a.lane, (r.lines.length ? r.lines : r.tail).join("\n")) : [],
      siblings: failed ? siblingsOf(run, a.lane, (r.lines.length ? r.lines : r.tail).join("\n")) : [],
      startedAt,
      durationMs,
      waitedMs,
    });
  }

  /** Plan 40 D13: each failing item with no baseline record runs once on the base's own tree, which is removed after. */
  async function runBaselines(m: string, head: string): Promise<void> {
    const items = await missingBaselines(run, m, head);
    if (items.length === 0) return;
    let tree: Awaited<ReturnType<typeof baseTree>>;
    try {
      tree = await baseTree(deps, run, m);
    } catch (e) {
      // the items keep no baseline, so their lines count as fresh; the log says why
      log("warn", "daemon", {
        run: run.id,
        milestone: m,
        baseline: errorMessage(e),
      });
      return;
    }
    try {
      for (const command of items)
        await untilChecked({ run: run.id, milestone: m, command, at: tree.dir }, {});
    } finally {
      await tree.remove();
    }
  }

  /**
   * The daemon's check of a milestone's commit (plan 40 D1). In a base run the base is merged in first (D4). Then the
   * Check runs in its worker, and each failing item with no baseline runs once on the base's own tree (D13). The
   * verdict is `milestone.checked`: fresh failing lines are findings, and the A-lines the Check does not show are
   * left to the verifier.
   */
  async function machineCheck(a: Extract<Action, { type: "machineCheck" }>, s: RunState): Promise<void> {
    const repo = run.meta.repo;
    if (s.base !== null) {
      await fetchBase(repo, s.base);
      if ((await isAncestor(repo, `origin/${s.base}`, a.commit)) === false)
        return void (await append({
          type: "base.behind",
          milestone: a.milestone,
        }));
    }
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const plan = read(runPaths(run.dir).plan);
    const command = milestoneCheck(plan, a.milestone);
    // with no Check nothing is covered: every delivered A-line goes to the verifier, marked or not (plan 40 D2)
    const uncovered =
      command === null ? deliveredALineTexts(run, a.milestone) : uncoveredALines(run, a.milestone);
    let missing: string[] = [];
    let findings: Finding[] = [];
    if (command !== null) {
      await untilChecked(
        { run: run.id, milestone: a.milestone, command },
        { onWait: waitingOnce(a.milestone) },
      );
      await runBaselines(a.milestone, a.commit);
      missing = (await machineGate(run, a.milestone, a.commit)).missing;
      findings = (await freshFailures(run, a.milestone, a.commit)).flatMap(({ item, lines, files }) =>
        lines.slice(0, FINDINGS_PER_ITEM).map((line) => {
          const of = files[line] ?? [];
          return {
            label: "BLOCKER" as const,
            text: `\`${item}\` fails: ${line}${of.length ? ` — in ${of.join(", ")}` : ""}`,
            file: of[0] ?? fileOf(line),
          };
        }),
      );
    }
    const verified = milestoneOf(s, a.milestone)?.verifierPassedOn ?? null;
    const verdictCarried =
      verified !== null &&
      verified !== a.commit &&
      (await verdictCarries(run, a.milestone, verified, a.commit));
    await append({
      type: "milestone.checked",
      milestone: a.milestone,
      head: a.commit,
      command,
      missing,
      findings,
      uncovered,
      checkOnly:
        command !== null && deliveredALines(run, plan, a.milestone).size > 0 && uncovered.length === 0,
      verdictCarried,
      startedAt,
      durationMs: Date.now() - started,
      // the waits of the records this check wrote: a carried record waited for nothing of its own
      waitedMs: readChecks(repo)
        .filter((r) => r.run === run.id && r.milestone === a.milestone && !r.carriedFrom && r.at >= startedAt)
        .reduce((sum, r) => sum + (r.waitedMs ?? 0), 0),
    });
  }

  /** Why a stop gave no reason: Jev reads the end of the reply; null when it is off, unsure or says other. */
  async function classify(a: Extract<Action, { type: "classify" }>): Promise<void> {
    const record = readRecords(run).records.find((r) => r.dispatchId === a.dispatchId);
    let reason: BlockedReason | null = null;
    if (record) {
      const reply = record.replyPath ? read(join(run.dir, record.replyPath)) : "";
      try {
        const v = await deps.routing.stopCause(
          run.dir,
          `${record.status}${record.replyStatus ? `, STATUS ${record.replyStatus}` : ""}`,
          reply,
          runProfile(deps, run).jev.use,
        );
        if (v.source === "jev" && v.value !== "other") reason = v.value;
      } catch (e) {
        log("warn", "daemon", {
          run: run.id,
          action: "classify",
          error: errorMessage(e),
        });
      }
    }
    await append({ type: "stop.classified", dispatchId: a.dispatchId, reason });
  }

  async function commit(a: Extract<Action, { type: "commit" }>, s: RunState): Promise<void> {
    const m = milestoneOf(s, a.milestone);
    const lanes = lanesOf(s, a.milestone);
    const ids = new Set(lanes.map((l) => l.id));
    const paths = new Set(lanes.flatMap((l) => l.owns));
    for (const r of readRecords(run).records)
      if (r.lane && ids.has(r.lane)) for (const p of [...r.changedOwned, ...r.violations]) paths.add(p);
    // plan 35: a base run's milestone is committed in its own worktree, on its own branch
    const repo = treeOf(run, a.milestone);
    const failed = (r: { out: string; err: string; timedOut: boolean }, hook = false) =>
      append({
        type: "commit.failed",
        milestone: a.milestone,
        round: a.round,
        tail: r.timedOut ? "git timed out" : tailOf(`${r.out}\n${r.err}`),
        ...(hook ? { hook: true } : {}),
      });
    // a merge of the base is open: the files it left in conflict are resolved now, and the merge itself is committed
    const merging = (m?.integrateFiles.length ?? 0) > 0;
    for (const f of merging ? (m?.integrateFiles ?? []) : []) paths.add(f);
    for (const p of paths) {
      const r = await gitRun(repo, ["--literal-pathspecs", "add", "-A", "--", p], effectLimits.commitMs);
      // an Owns: entry the lane never created, or one git ignores (plan 40 D11), is no error
      if (r.code !== 0 && !/did not match any files|The following paths are ignored/.test(r.err))
        return void (await failed(r));
    }
    if (merging) {
      // a file the worker left unresolved must not become the milestone's commit
      for (const f of m?.integrateFiles ?? []) {
        const text = existsSync(join(repo, f)) ? readFileSync(join(repo, f), "utf8") : "";
        if (/^<{7} /m.test(text) && /^>{7} /m.test(text))
          return void (await failed({
            out: "",
            err: `${f} still holds conflict markers`,
            timedOut: false,
          }));
      }
      // an open merge is committed whole: a partial commit is refused while one is in progress
      const c = await gitRun(repo, ["commit", "--no-edit"], effectLimits.commitMs);
      if (c.code !== 0) return void (await failed(c, !c.timedOut));
    } else {
      // only what the milestone owns: work staged elsewhere stays staged and out of the commit
      const staged = paths.size
        ? await gitRun(
            repo,
            ["--literal-pathspecs", "diff", "--cached", "--name-only", "-z", "--", ...paths],
            effectLimits.commitMs,
          )
        : { code: 0, out: "", err: "", timedOut: false };
      if (staged.code !== 0) return void (await failed(staged));
      const files = staged.out.split("\0").filter(Boolean);
      // a staged deletion is no argument for the formatter: a missing path makes oxfmt or prettier format nothing
      const present = files.filter((f) => existsSync(join(repo, f)));
      const format = present.length ? formatCommand(read(runPaths(run.dir).plan), a.milestone) : null;
      if (format) {
        // plan 43 D11: the plan's formatter runs on the staged files; a failure is logged and the hook decides
        const quoted = present.map((f) => `'${f.replaceAll("'", `'\\''`)}'`).join(" ");
        const r = await runCheck(
          repo,
          `${format} ${quoted}`,
          effectLimits.commitMs,
          await checkEnvFor(repo),
        ).catch((e: unknown) => ({ code: null, timedOut: false, tail: [errorMessage(e)] }));
        if (r.code !== 0)
          log("warn", "daemon", { run: run.id, action: "format", exit: r.code, tail: r.tail.join("\n") });
        const added = await gitRun(
          repo,
          ["--literal-pathspecs", "add", "--", ...present],
          effectLimits.commitMs,
        );
        if (added.code !== 0) return void (await failed(added));
      }
      if (files.length) {
        const title = lower(m?.title ?? a.milestone);
        const suffix = a.round === 0 ? "" : `, review round ${a.round}`;
        const subject = `${`${a.round === 0 ? "feat" : "fix"}: ${title}`.slice(0, 100 - suffix.length)}${suffix}`;
        const c = await gitRun(
          repo,
          ["--literal-pathspecs", "commit", "--only", "-m", subject, "--", ...files],
          effectLimits.commitMs,
        );
        if (c.code !== 0) return void (await failed(c, !c.timedOut));
      }
    }
    const head = await gitRun(repo, ["rev-parse", "HEAD"]);
    if (head.code !== 0) return void (await failed(head));
    await append({
      type: "commit.made",
      milestone: a.milestone,
      round: a.round,
      commit: head.out.trim(),
    });
  }

  async function landIt(a: Extract<Action, { type: "land" }>, s: RunState): Promise<void> {
    const m = milestoneOf(s, a.milestone);
    if (!m?.commit) throw new CatherdError("E_RUN_COMMIT", `${a.milestone} has no commit to land`);
    const issues = a.knownIssues.length ? `; ${a.knownIssues.length} known issue(s)` : "";
    // a base run lands only what origin's base is behind; a base that moved is merged in first (spec 2.0, decision 21)
    let stale = "";
    if (s.base !== null) {
      const repo = run.meta.repo;
      const fetched = await fetchBase(repo, s.base);
      if ((await isAncestor(repo, `origin/${s.base}`, m.commit)) === false)
        return void (await append({
          type: "base.behind",
          milestone: a.milestone,
        }));
      if (!fetched) stale = `; fetch of origin/${s.base} failed: using the copy from the last fetch`;
    }
    try {
      const outcome = replayRun(run).outcome;
      const r = await land(deps, {
        run: run.id,
        milestone: a.milestone,
        what: m.title,
        commit: m.commit,
        evidence: `verifier-${a.milestone} PASS on ${m.commit.slice(0, 12)}${issues}${stale}`,
        next: outcome ? outcomeNext(outcome) : `the daemon continues after ${a.milestone}`,
      });
      await append({
        type: "milestone.landed",
        milestone: a.milestone,
        commit: m.commit,
        knownIssues: a.knownIssues,
        digestPath: r.digestPath,
        ...(s.base !== null
          ? {
              branch: m.branch ?? (await currentBranch(treeOf(run, a.milestone))),
            }
          : {}),
      });
    } catch (e) {
      if (!isCatherdError(e)) throw e;
      await append({
        type: "land.refused",
        milestone: a.milestone,
        code: e.code,
        message: e.message,
        fix: e.fix ?? "",
      });
    }
  }

  /** Merges origin's base into the run's branch: done with the merge commit, or the files left in conflict. */
  async function integrate(a: Extract<Action, { type: "integrate" }>, s: RunState): Promise<void> {
    const repo = treeOf(run, a.milestone);
    const base = s.base;
    if (base === null) throw new CatherdError("E_RUN_COMMIT", `${a.milestone} has no base branch to merge`);
    await fetchBase(repo, base);
    const branch = milestoneOf(s, a.milestone)?.branch ?? (await currentBranch(repo)) ?? "HEAD";
    const r = await gitRun(
      repo,
      ["merge", "--no-ff", "-m", `Merge origin/${base} into ${branch}`, `origin/${base}`],
      effectLimits.commitMs,
    );
    if (r.code === 0) {
      const head = await gitRun(repo, ["rev-parse", "HEAD"]);
      if (head.code !== 0) throw new Error(`git rev-parse HEAD failed: ${tailOf(head.err)}`);
      // a merge can move a submodule pointer; setup runs once per tree, so the checkout follows here (plan 43 D17)
      const sub = await gitRun(repo, ["submodule", "update", "--init", "--recursive"], effectLimits.commitMs);
      if (sub.code !== 0)
        throw new Error(`git submodule update failed: ${tailOf(`${sub.out}\n${sub.err}`, 5)}`);
      return void (await append({
        type: "integrate.done",
        milestone: a.milestone,
        commit: head.out.trim(),
      }));
    }
    const unmerged = await gitRun(repo, ["diff", "--name-only", "--diff-filter=U"]);
    const files = unmerged.out.split("\n").filter(Boolean);
    if (unmerged.code !== 0 || files.length === 0)
      throw new Error(`merging origin/${base} failed: ${tailOf(`${r.out}\n${r.err}`, 5)}`);
    await append({ type: "integrate.conflict", milestone: a.milestone, files });
  }

  /**
   * Whether the milestone is merged: origin's base holds its landed commit, or the owner's answer counted it so. A
   * merged milestone's clean worktree goes (a dirty one stays, logged), and then `milestone.merged` follows; silent
   * while it is not merged, or cannot be told.
   */
  async function checkMerged(a: Extract<Action, { type: "checkMerged" }>, s: RunState): Promise<void> {
    if (s.base === null) return;
    const commit = landedCommitOf(run, a.milestone);
    let merged = milestoneOf(s, a.milestone)?.status === "merged";
    if (!merged && commit) {
      await fetchBase(run.meta.repo, s.base);
      merged = (await isAncestor(run.meta.repo, commit, `origin/${s.base}`)) === true;
    }
    if (!merged) return;
    const gone = await removeTree(run, a.milestone);
    if (gone.hint)
      log("warn", "trees", {
        run: run.id,
        milestone: a.milestone,
        hint: gone.hint,
      });
    await append({ type: "milestone.merged", milestone: a.milestone });
  }

  /**
   * Plan 43 D20: merges a landed milestone into origin's base from a detached worktree of its own (the owner's checkout
   * may be dirty or elsewhere), pushes it without force and drops the milestone's tree. Any git failure leaves origin
   * alone and is `merge.failed`, which turns into the owner's push question.
   */
  async function mergeLanded(a: Extract<Action, { type: "mergeLanded" }>, s: RunState): Promise<void> {
    const m = milestoneOf(s, a.milestone);
    const commit = m?.commit ?? landedCommitOf(run, a.milestone);
    if (!m || s.base === null || !commit)
      return void (await append({
        type: "merge.failed",
        milestone: a.milestone,
        error: s.base === null ? "the run has no base branch" : "no landed commit to merge",
      }));
    const repo = run.meta.repo;
    const wt = join(run.dir, "scratch", `merge-${a.milestone}`);
    const fail = async (r: { out: string; err: string; timedOut: boolean }): Promise<void> => {
      await append({
        type: "merge.failed",
        milestone: a.milestone,
        error: r.timedOut ? "git timed out" : tailOf(`${r.out}\n${r.err}`, 5),
      });
    };
    try {
      for (let attempt = 1; ; attempt++) {
        const fetched = await gitRun(repo, ["fetch", "-q", "origin", s.base], effectLimits.commitMs);
        if (fetched.code !== 0) return await fail(fetched);
        await gitRun(repo, ["worktree", "remove", "--force", wt], effectLimits.commitMs); // left by a crashed try
        const added = await gitRun(
          repo,
          ["worktree", "add", "--detach", wt, `origin/${s.base}`],
          effectLimits.commitMs,
        );
        if (added.code !== 0) return await fail(added);
        const merged = await gitRun(
          wt,
          ["merge", "--no-ff", "-m", mergeSubject(run.id, a.milestone, m.title), commit],
          effectLimits.commitMs,
        );
        if (merged.code !== 0) return await fail(merged);
        const pushed = await gitRun(
          wt,
          ["push", "origin", `HEAD:refs/heads/${s.base}`],
          effectLimits.commitMs,
        );
        if (pushed.code === 0) break;
        // another push moved the base first (two milestones landing together): merge again on top of it
        if (attempt >= MERGE_ATTEMPTS || !LOST_RACE.test(`${pushed.out}\n${pushed.err}`))
          return await fail(pushed);
      }
      const head = await gitRun(wt, ["rev-parse", "HEAD"]);
      const gone = await removeTree(run, a.milestone);
      if (gone.hint) log("warn", "trees", { run: run.id, milestone: a.milestone, hint: gone.hint });
      await append({
        type: "milestone.merged",
        milestone: a.milestone,
        by: "catherd",
        ...(head.code === 0 ? { commit: head.out.trim() } : {}),
      });
    } finally {
      await gitRun(repo, ["worktree", "remove", "--force", wt], effectLimits.commitMs);
    }
  }

  /**
   * A memory check, then the milestone's worktree: `tree.deferred` while the machine has no room for another, and
   * while another is working on a disk short of its reserve (plan 40 D14).
   */
  async function claim(a: Extract<Action, { type: "claimTree" }>, s: RunState): Promise<void> {
    const limits = memoryLimitsOf(runProfile(deps, run));
    const load = memoryLoad(s.milestones, deps.now(), limits);
    const availableMb = memoryReader.read();
    if (!mayStartMilestone({ availableMb, ...load }, limits))
      return void (await append({
        type: "tree.deferred",
        milestone: a.milestone,
        availableMb,
        needMb: neededMb(load.ramping, limits),
      }));
    const freeMb = heavyLimits.freeMb();
    if (load.working > 0 && freeMb < heavyLimits.diskReserveMb)
      return void (await append({
        type: "tree.deferred",
        milestone: a.milestone,
        availableMb: freeMb,
        needMb: heavyLimits.diskReserveMb,
        resource: "disk",
      }));
    const c = await claimTree(deps, run, a.milestone, {
      known: milestoneOf(s, a.milestone)?.branch != null,
    });
    for (const hint of c.hints) log("warn", "trees", { run: run.id, milestone: a.milestone, hint });
    await append({
      type: "tree.ready",
      milestone: a.milestone,
      tree: c.tree,
      branch: c.branch,
      base: c.base,
      hints: c.hints,
    });
  }

  /** The owner's `push` answer: the one push catherd makes, of this milestone's own branch. It opens no MR. */
  async function pushBranch(a: Extract<Action, { type: "pushBranch" }>, s: RunState): Promise<void> {
    const m = milestoneOf(s, a.milestone);
    if (!m?.tree || !m.branch || s.base === null)
      throw new CatherdError("E_TREE", `${a.milestone} has no branch to push`);
    await branchPusher.push(m.tree, m.branch);
    const mr = mrCommand({
      originUrl: (await gitOrigin(run.meta.repo)) ?? "",
      base: s.base,
      branch: m.branch,
      body: m.digestPath ?? "",
    });
    await append({
      type: "branch.pushed",
      milestone: a.milestone,
      branch: m.branch,
      remote: "origin",
      mr,
    });
  }

  async function perform(a: Action, s: RunState): Promise<void> {
    switch (a.type) {
      case "dispatch":
        return start(a, briefFor(run, s, a), s, null);
      case "judge":
        return start(
          {
            unit: a.input.unit,
            name: judgeName(a.input.id),
            role: "judge",
            lane: null,
            rung: null,
            thread: null,
            failoverFrom: null,
          },
          judgeBrief(run, a.input),
          s,
          { id: a.input.id, kind: a.input.kind },
        );
      case "watch": {
        const v = s.dispatches[a.dispatchId];
        if (!v || v.ended) return;
        const d = listDispatches(run).find((x) => x.admit.dispatchId === a.dispatchId);
        if (!d) throw new Error(`dispatch ${a.dispatchId} has no folder`);
        return settle(d, v.unit, v.role === "judge" ? judgeOf(v.name, s) : null);
      }
      case "readPlan":
        return readPlan();
      case "route":
        return route(a, s);
      case "fastCheck":
        return fastCheck(a);
      case "machineCheck":
        return machineCheck(a, s);
      case "commit":
        return commit(a, s);
      case "climb": {
        const r = await climb(deps, {
          run: run.id,
          lane: a.lane,
          reason: a.reason,
        });
        return void (await append({
          type: "lane.climbed",
          lane: a.lane,
          rung: r.rung,
          top: r.top,
        }));
      }
      case "park":
        // the push question is the daemon's own: a 1.5 question would hold the run's pause and ask twice
        if (milestoneOf(s, a.unit) && a.reason !== "push")
          await park(deps, {
            run: run.id,
            milestone: a.unit,
            question: a.question,
          });
        return void (await append({
          type: "question.parked",
          unit: a.unit,
          question: a.question,
          reason: a.reason,
        }));
      case "land":
        return landIt(a, s);
      case "cancel": {
        for (const id of a.dispatchIds) {
          const d = listDispatches(run).find((x) => x.admit.dispatchId === id);
          if (!d) continue;
          try {
            await cancel(deps, run.id, d.admit.name);
          } catch (e) {
            if (!(isCatherdError(e) && e.code === "E_RUN_NOT_LIVE")) throw e;
          }
        }
        return;
      }
      case "report":
        return void (await append({
          type: "report.posted",
          kind: a.kind,
          unit: a.unit,
          text: a.text,
        }));
      case "notify":
        // the phone; the session hears the run's reports through its notifier
        await sendRunNotice(deps, run, { unit: a.unit, moment: a.moment });
        return;
      case "remind": {
        // The action's snapshot binds it to the parked event, even if a replacement has identical text/time.
        const pending = (): boolean => {
          const current = replayRun(run);
          const question = current.questions[a.unit];
          return (
            current.phase !== "ended" &&
            !!s.questions[a.unit] &&
            !!question &&
            question.reminded < a.n &&
            !readEvents(run, s.seq + 1).some(
              (e) => (e.type === "question.parked" || e.type === "question.answered") && e.unit === a.unit,
            )
          );
        };
        if (!pending()) return;
        await sendRunNotice(deps, run, { unit: a.unit, moment: "blocked" });
        // Answer/replacement and the reminder append cannot interleave after this identity check.
        await withEventsLock(run, (add) => {
          if (pending()) add({ type: "question.reminded", unit: a.unit, n: a.n }, at());
        });
        return;
      }
      case "finish": {
        // what each landed milestone's check passed on only through the base or a rerun
        const audits: Record<string, string[]> = {};
        for (const m of s.milestones) {
          if (!m.commit || (m.status !== "landed" && m.status !== "merged")) continue;
          const g = await machineGate(run, m.id, m.commit).catch(() => null);
          if (g?.audit.length) audits[m.id] = g.audit;
        }
        const reportPath = writeRunReport(run, s, readEvents(run), audits, a.proposals);
        await append({ type: "run.ended", outcome: a.outcome, reportPath });
        await refreshState(run, { next: outcomeNext(a.outcome), parked: [] });
        return;
      }
      case "classify":
        return classify(a);
      case "checkMerged":
        return checkMerged(a, s);
      case "integrate":
        return integrate(a, s);
      case "claimTree":
        return claim(a, s);
      case "pushBranch":
        return pushBranch(a, s);
      case "mergeLanded":
        return mergeLanded(a, s);
    }
  }

  return {
    async run(a, s) {
      try {
        await perform(a, s);
      } catch (e) {
        log("warn", "daemon", {
          run: run.id,
          action: a.type,
          error: errorMessage(e),
        });
        try {
          await append({
            type: "effect.failed",
            action: a.type,
            unit: unitOf(a, s),
            message: errorMessage(e),
          });
        } catch (inner) {
          log("error", "daemon", {
            run: run.id,
            action: a.type,
            lost: errorMessage(inner),
          });
        }
      }
    },
  };
}
