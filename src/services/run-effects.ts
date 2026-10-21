import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CatherdError, errorMessage, isCatherdError } from "../domain/errors.ts";
import { type BlockedReason, foreignFailure, parseBlockedReason } from "../domain/blocked.ts";
import { quotaOf } from "../domain/failover.ts";
import { parseFailLines, parseFindings } from "../domain/findings.ts";
import { headlessRung, tryParseRung } from "../domain/ids.ts";
import { type JudgeKind, judgeName, parseJudgeReply } from "../domain/judge.ts";
import { onlyAllowedHits, parseLaneHeader } from "../domain/lane.ts";
import { changedDecisions, reapprovalQuestion } from "../domain/plan-doc.ts";
import type { RunRecord } from "../domain/record.ts";
import { currentRoute } from "../domain/route.ts";
import type { Role } from "../domain/roles.ts";
import { type MilestonePlan, RUN_UNIT, type RunEventInput } from "../domain/run-events.ts";
import { type Action, unitOf } from "../domain/run-machine.ts";
import { lanesOf, milestoneOf, ownerOfFile, type RunState } from "../domain/run-state.ts";
import { endCollect, requestCancel, tryCollect } from "../infra/dispatch-dir.ts";
import { currentBranch, fetchBase, gitRun, isAncestor } from "../infra/git.ts";
import { heavySlots, withHeavySlot } from "../infra/heavy-lock.ts";
import { log } from "../infra/log.ts";
import { admit } from "./admission.ts";
import { cancel, launcher } from "./dispatch-service.ts";
import { type Dispatch, listDispatches } from "./dispatches.ts";
import { finalizeDispatch, waitForFinish } from "./finalize.ts";
import { failoverRung } from "./failover-rungs.ts";
import { climb, land, routeLanes } from "./lane-service.ts";
import { blockedByEnvironment, landedCommitOf, replyVerdict } from "./milestones.ts";
import { machineGate } from "./milestone-check.ts";
import { sendRunNotice } from "./notify-service.ts";
import { planProblems } from "./plan-input.ts";
import type { Deps } from "./ports.ts";
import { checkEnvFor, preflight, runCheck } from "./preflight.ts";
import { park } from "./questions.ts";
import { briefFor, judgeBrief } from "./run-briefs.ts";
import { appendEvent, appendEvents, readEvents, replayRun } from "./run-events-store.ts";
import { writeRunReport } from "./run-report.ts";
import { runProfile } from "./run-pin.ts";
import { appendRoute, readRecords, readRoutes, type Run, runPaths } from "./run-store.ts";

/**
 * What carries the machine's actions out. `run` appends the events the action produces (a long one when it is
 * done), never throws: a failure becomes an `effect.failed` event.
 */
export interface Effects {
  run(a: Action, state: RunState): Promise<void>;
}

/** Limits a test shortens. */
export const effectLimits = { checkMs: 600_000, commitMs: 300_000 };

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
function laneOwnsOf(run: Run, lane: string): { own: string[]; siblings: string[] } {
  const dir = runPaths(run.dir).lanes;
  const prefix = lane.slice(0, lane.indexOf(".") + 1);
  const owns = (id: string): string[] => parseLaneHeader(read(join(dir, `${id}.md`))).owns;
  const ids = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".md") && f.startsWith(prefix))
        .map((f) => f.slice(0, -3))
    : [];
  return { own: owns(lane), siblings: ids.filter((id) => id !== lane).flatMap(owns) };
}

/** The sibling entries a failed lane check blames when it blames only them: the lane counts as done. */
function foreignOf(run: Run, lane: string, log: string): string[] {
  const { own, siblings } = laneOwnsOf(run, lane);
  return foreignFailure(log, own, siblings);
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
    else if (PASS_LINE.test(first)) verdict = "pass";
    // a reply with no readable verdict is not a pass: the next fix round starts from what it said
    else if (record.status === "ok") verdict = "fail";
    if (verdict === "fail") {
      findings = parseFailLines(reply);
      if (!FIRST_LINE.test(first) && findings.length === 0)
        findings = [{ label: "BLOCKER", text: `no VERDICT line: ${first || "empty reply"}`, file: null }];
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
    replyPath: record.replyPath,
  };
}

const ID = /^M[\w-]*\.\S+$/;
const HEADING = /^##\s+(M\d+)\b\s*(?:[—–:.-]\s*)?(.*)$/;
const AFTER = /^\s*[*_]*After[*_]*\s*:[*_]*\s*(.*)$/i;

const ROLE_OF_KIND: Record<string, Role> = { prose: "writer", research: "researcher" };

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
      const h = parseLaneHeader(read(join(dir, `${id}.md`)));
      return {
        id,
        milestone: id.slice(0, id.indexOf(".")),
        role: (h.kind ? ROLE_OF_KIND[h.kind] : undefined) ?? ("worker" as Role),
        kind: h.kind,
        after: h.after,
        owns: h.owns,
      };
    });
  if (lanes.length === 0) throw new CatherdError("E_LANE_INVALID", "the architect wrote no lane files");
  const heads: { id: string; title: string; after: string[] }[] = [];
  for (const line of read(runPaths(run.dir).plan).split("\n")) {
    const h = HEADING.exec(line);
    if (h) heads.push({ id: h[1] as string, title: (h[2] ?? "").trim() || (h[1] as string), after: [] });
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
        after: (head?.after ?? []).filter((a) => a !== id),
        lanes: mine.map(({ milestone: _m, ...l }) => l),
      },
    ];
  });
}

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
    a: { name: string; role: Role; lane: string | null; rung: string | null; failoverFrom: string | null },
    s: RunState,
  ): Promise<{ rung: string } | { code: string; message: string }> {
    const profile = runProfile(deps, run);
    let rung = a.failoverFrom ?? a.rung;
    if (!rung && a.lane) rung = currentRoute(readRoutes(run), a.lane)?.rung ?? null;
    if (!rung && a.role === "judge") rung = profile.roles.judge?.rungs[0] ?? null;
    if (!rung) {
      const [routed] = await routeLanes(deps, { run: run.id, laneFiles: [undefined], role: a.role });
      rung = routed?.rung ?? null;
    }
    if (!rung) throw new CatherdError("E_ADMIT_RUNG", `no rung for the ${a.role}`);
    const parsed = tryParseRung(rung);
    const held = heldQuotas(s);
    if (a.failoverFrom || (parsed !== null && held.includes(quotaOf(parsed)))) {
      const stand = failoverRung(deps, run, a.role, rung, held);
      if (a.failoverFrom) recordFailover(a, a.failoverFrom, stand, s);
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
            ? { type: "judge.decided", id: judge.id, unit, kind: judge.kind, decision, dispatchId: id }
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
      append({ type: "dispatch.refused", name: a.name, unit: a.unit, code, message });
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
    let admitted: Awaited<ReturnType<typeof admit>>;
    try {
      admitted = await admit(deps, run, {
        role: a.role,
        name: a.name,
        brief,
        rung: picked.rung,
        thread: a.thread,
        lane: a.lane,
        failoverFrom: a.failoverFrom,
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
      log("warn", "daemon", { run: run.id, name: a.name, launch: errorMessage(e) });
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
    const problems = planProblems(run);
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
    // one write: a crash between the two would lose the owner's change request
    await appendEvents(
      run,
      [
        ...(changed.length > 0
          ? [
              {
                type: "question.parked" as const,
                unit: RUN_UNIT,
                question: reapprovalQuestion(run.id, changed),
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
      const out = await routeLanes(deps, { run: run.id, laneFiles: ids.map((id) => `lanes/${id}.md`), role });
      for (const r of out) if (r.lane) routed.push({ lane: r.lane, rung: r.rung, ladder: r.ladder });
    }
    await append({ type: "lanes.routed", milestone: a.milestone, lanes: routed });
    const rep = await preflight(deps, { run: run.id, milestone: a.milestone, confirmed: a.confirmed });
    await append(
      rep.needsConfirmation
        ? {
            type: "preflight.done",
            milestone: a.milestone,
            blocking: [],
            confirm: rep.commands.map((c) => `${c.lane}: ${c.check ?? "(no fast check)"}`),
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
    const env = await checkEnvFor(run.meta.repo);
    const slots = heavySlots(runProfile(deps, run).heavy);
    const r = await withHeavySlot(
      slots,
      (_slot, tmp) =>
        runCheck(run.meta.repo, check, effectLimits.checkMs, { ...env, TMPDIR: tmp, GOTMPDIR: tmp }),
      { tmpBase: process.env.TMPDIR },
    );
    // an absence check whose only hits are the lane's Allow: exceptions has passed
    const allowed = r.code !== 0 && !r.timedOut && onlyAllowedHits(r.lines, header.allow);
    const failed = !allowed && r.code !== 0;
    await append({
      type: "check.ran",
      lane: a.lane,
      exit: allowed ? 0 : r.code,
      tail: r.tail.join("\n"),
      // a check that fails only in a sibling's files still counts: the sibling is not done writing them
      foreign: failed ? foreignOf(run, a.lane, (r.lines.length ? r.lines : r.tail).join("\n")) : [],
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
        log("warn", "daemon", { run: run.id, action: "classify", error: errorMessage(e) });
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
    const repo = run.meta.repo;
    const failed = (r: { out: string; err: string; timedOut: boolean }) =>
      append({
        type: "commit.failed",
        milestone: a.milestone,
        round: a.round,
        tail: r.timedOut ? "git timed out" : tailOf(`${r.out}\n${r.err}`),
      });
    // a merge of the base is open: the files it left in conflict are resolved now, and the merge itself is committed
    const merging = (m?.integrateFiles.length ?? 0) > 0;
    for (const f of merging ? (m?.integrateFiles ?? []) : []) paths.add(f);
    for (const p of paths) {
      const r = await gitRun(repo, ["--literal-pathspecs", "add", "-A", "--", p], effectLimits.commitMs);
      // an Owns: entry the lane never created is no error
      if (r.code !== 0 && !/did not match any files/.test(r.err)) return void (await failed(r));
    }
    if (merging) {
      // a file the worker left unresolved must not become the milestone's commit
      for (const f of m?.integrateFiles ?? []) {
        const text = existsSync(join(repo, f)) ? readFileSync(join(repo, f), "utf8") : "";
        if (/^<{7} /m.test(text) && /^>{7} /m.test(text))
          return void (await failed({ out: "", err: `${f} still holds conflict markers`, timedOut: false }));
      }
      // an open merge is committed whole: a partial commit is refused while one is in progress
      const c = await gitRun(repo, ["commit", "--no-edit"], effectLimits.commitMs);
      if (c.code !== 0) return void (await failed(c));
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
      if (files.length) {
        const title = lower(m?.title ?? a.milestone);
        const suffix = a.round === 0 ? "" : `, review round ${a.round}`;
        const subject = `${`${a.round === 0 ? "feat" : "fix"}: ${title}`.slice(0, 100 - suffix.length)}${suffix}`;
        const c = await gitRun(
          repo,
          ["--literal-pathspecs", "commit", "--only", "-m", subject, "--", ...files],
          effectLimits.commitMs,
        );
        if (c.code !== 0) return void (await failed(c));
      }
    }
    const head = await gitRun(repo, ["rev-parse", "HEAD"]);
    if (head.code !== 0) return void (await failed(head));
    await append({ type: "commit.made", milestone: a.milestone, round: a.round, commit: head.out.trim() });
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
        return void (await append({ type: "base.behind", milestone: a.milestone }));
      if (!fetched) stale = `; fetch of origin/${s.base} failed: using the copy from the last fetch`;
    }
    try {
      const r = await land(deps, {
        run: run.id,
        milestone: a.milestone,
        what: m.title,
        commit: m.commit,
        evidence: `verifier-${a.milestone} PASS on ${m.commit.slice(0, 12)}${issues}${stale}`,
        next: `the daemon continues after ${a.milestone}`,
      });
      await append({
        type: "milestone.landed",
        milestone: a.milestone,
        commit: m.commit,
        knownIssues: a.knownIssues,
        digestPath: r.digestPath,
        ...(s.base !== null ? { branch: await currentBranch(run.meta.repo) } : {}),
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
    const repo = run.meta.repo;
    const base = s.base;
    if (base === null) throw new CatherdError("E_RUN_COMMIT", `${a.milestone} has no base branch to merge`);
    await fetchBase(repo, base);
    const branch = (await currentBranch(repo)) ?? "HEAD";
    const r = await gitRun(
      repo,
      ["merge", "--no-ff", "-m", `Merge origin/${base} into ${branch}`, `origin/${base}`],
      effectLimits.commitMs,
    );
    if (r.code === 0) {
      const head = await gitRun(repo, ["rev-parse", "HEAD"]);
      if (head.code !== 0) throw new Error(`git rev-parse HEAD failed: ${tailOf(head.err)}`);
      return void (await append({ type: "integrate.done", milestone: a.milestone, commit: head.out.trim() }));
    }
    const unmerged = await gitRun(repo, ["diff", "--name-only", "--diff-filter=U"]);
    const files = unmerged.out.split("\n").filter(Boolean);
    if (unmerged.code !== 0 || files.length === 0)
      throw new Error(`merging origin/${base} failed: ${tailOf(`${r.out}\n${r.err}`, 5)}`);
    await append({ type: "integrate.conflict", milestone: a.milestone, files });
  }

  /** Whether origin's base holds the milestone's landed commit now; silent when it does not (or cannot be told). */
  async function checkMerged(a: Extract<Action, { type: "checkMerged" }>, s: RunState): Promise<void> {
    const commit = landedCommitOf(run, a.milestone);
    if (s.base === null || !commit) return;
    await fetchBase(run.meta.repo, s.base);
    if ((await isAncestor(run.meta.repo, commit, `origin/${s.base}`)) === true)
      await append({ type: "milestone.merged", milestone: a.milestone });
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
      case "commit":
        return commit(a, s);
      case "climb": {
        const r = await climb(deps, { run: run.id, lane: a.lane, reason: a.reason });
        return void (await append({ type: "lane.climbed", lane: a.lane, rung: r.rung, top: r.top }));
      }
      case "park":
        // the push question is the daemon's own: a 1.5 question would hold the run's pause and ask twice
        if (milestoneOf(s, a.unit) && a.reason !== "push")
          await park(deps, { run: run.id, milestone: a.unit, question: a.question });
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
        return void (await append({ type: "report.posted", kind: a.kind, unit: a.unit, text: a.text }));
      case "notify":
        // the phone; the session hears the run's reports through its notifier
        await sendRunNotice(deps, run, { unit: a.unit, moment: a.moment });
        return;
      case "finish": {
        // what each landed milestone's check passed on only through the base or a rerun
        const audits: Record<string, string[]> = {};
        for (const m of s.milestones) {
          if (!m.commit || (m.status !== "landed" && m.status !== "merged")) continue;
          const g = await machineGate(run, m.id, m.commit).catch(() => null);
          if (g?.audit.length) audits[m.id] = g.audit;
        }
        const reportPath = writeRunReport(run, s, readEvents(run), audits);
        return void (await append({ type: "run.ended", outcome: a.outcome, reportPath }));
      }
      case "classify":
        return classify(a);
      case "checkMerged":
        return checkMerged(a, s);
      case "integrate":
        return integrate(a, s);
    }
  }

  return {
    async run(a, s) {
      try {
        await perform(a, s);
      } catch (e) {
        log("warn", "daemon", { run: run.id, action: a.type, error: errorMessage(e) });
        try {
          await append({
            type: "effect.failed",
            action: a.type,
            unit: unitOf(a, s),
            message: errorMessage(e),
          });
        } catch (inner) {
          log("error", "daemon", { run: run.id, action: a.type, lost: errorMessage(inner) });
        }
      }
    },
  };
}
