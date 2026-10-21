import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CatherdError, errorMessage, isCatherdError } from "../domain/errors.ts";
import { quotaOf } from "../domain/failover.ts";
import { parseFailLines, parseFindings } from "../domain/findings.ts";
import { headlessRung, tryParseRung } from "../domain/ids.ts";
import { type JudgeKind, judgeName, parseJudgeReply } from "../domain/judge.ts";
import { onlyAllowedHits, parseLaneHeader } from "../domain/lane.ts";
import type { RunRecord } from "../domain/record.ts";
import { currentRoute } from "../domain/route.ts";
import type { Role } from "../domain/roles.ts";
import type { MilestonePlan, RunEventInput } from "../domain/run-events.ts";
import { type Action, unitOf } from "../domain/run-machine.ts";
import { lanesOf, milestoneOf, ownerOfFile, type RunState } from "../domain/run-state.ts";
import { endCollect, tryCollect } from "../infra/dispatch-dir.ts";
import { gitRun } from "../infra/git.ts";
import { heavySlots, withHeavySlot } from "../infra/heavy-lock.ts";
import { log } from "../infra/log.ts";
import { admit } from "./admission.ts";
import { cancel, launcher } from "./dispatch-service.ts";
import { type Dispatch, listDispatches } from "./dispatches.ts";
import { finalizeDispatch, waitForFinish } from "./finalize.ts";
import { failoverRung } from "./failover-rungs.ts";
import { climb, land, routeLanes } from "./lane-service.ts";
import { blockedByEnvironment, replyVerdict } from "./milestones.ts";
import { sendRunNotice } from "./notify-service.ts";
import type { Deps } from "./ports.ts";
import { checkEnvFor, preflight, runCheck } from "./preflight.ts";
import { park } from "./questions.ts";
import { briefFor, judgeBrief } from "./run-briefs.ts";
import { appendEvent, readEvents, replayRun } from "./run-events-store.ts";
import { writeRunReport } from "./run-report.ts";
import { runProfile } from "./run-pin.ts";
import { readRecords, readRoutes, type Run, runPaths } from "./run-store.ts";

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

const FIRST_LINE = /^VERDICT:\s*FAIL\b/i;
const PASS_LINE = /^VERDICT: PASS\b/;

/**
 * The `dispatch.ended` event of a finished dispatch: the record's status, the reply's findings (a reviewer's
 * BLOCKER, BUG and NIT lines, a failing verifier's lines) and the verifier's verdict. 30b adds `reason`, `head`
 * and `foreign`.
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
  return {
    type: "dispatch.ended",
    dispatchId: record.dispatchId,
    name: record.name,
    unit,
    status: record.status,
    replyStatus: record.replyStatus,
    reason: null,
    why: record.replyWhy ?? record.error?.message ?? "",
    thread: record.thread,
    head: null,
    environment: record.environment ?? (probe ? probe : null),
    verdict,
    findings,
    foreign: [],
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

  /** The rung a dispatch runs on, or a refusal's code and message. */
  async function rungFor(
    a: { role: Role; lane: string | null; rung: string | null; failoverFrom: string | null },
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
      if (judge && record.status !== "limit") {
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
    const r = await withHeavySlot(slots, () => runCheck(run.meta.repo, check, effectLimits.checkMs, env));
    // an absence check whose only hits are the lane's Allow: exceptions has passed
    const allowed = r.code !== 0 && !r.timedOut && onlyAllowedHits(r.lines, header.allow);
    await append({
      type: "check.ran",
      lane: a.lane,
      exit: allowed ? 0 : r.code,
      tail: r.tail.join("\n"),
      foreign: [],
    });
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
    for (const p of paths) {
      const r = await gitRun(repo, ["--literal-pathspecs", "add", "-A", "--", p], effectLimits.commitMs);
      // an Owns: entry the lane never created is no error
      if (r.code !== 0 && !/did not match any files/.test(r.err)) return void (await failed(r));
    }
    const staged = await gitRun(repo, ["diff", "--cached", "--quiet"], effectLimits.commitMs);
    if (staged.code !== 0 && staged.code !== 1) return void (await failed(staged));
    if (staged.code === 1) {
      const title = lower(m?.title ?? a.milestone);
      const suffix = a.round === 0 ? "" : `, review round ${a.round}`;
      const subject = `${`${a.round === 0 ? "feat" : "fix"}: ${title}`.slice(0, 100 - suffix.length)}${suffix}`;
      const c = await gitRun(repo, ["commit", "-m", subject], effectLimits.commitMs);
      if (c.code !== 0) return void (await failed(c));
    }
    const head = await gitRun(repo, ["rev-parse", "HEAD"]);
    if (head.code !== 0) return void (await failed(head));
    await append({ type: "commit.made", milestone: a.milestone, round: a.round, commit: head.out.trim() });
  }

  async function landIt(a: Extract<Action, { type: "land" }>, s: RunState): Promise<void> {
    const m = milestoneOf(s, a.milestone);
    if (!m?.commit) throw new CatherdError("E_RUN_COMMIT", `${a.milestone} has no commit to land`);
    const issues = a.knownIssues.length ? `; ${a.knownIssues.length} known issue(s)` : "";
    try {
      const r = await land(deps, {
        run: run.id,
        milestone: a.milestone,
        what: m.title,
        commit: m.commit,
        evidence: `verifier-${a.milestone} PASS on ${m.commit.slice(0, 12)}${issues}`,
        next: `the daemon continues after ${a.milestone}`,
      });
      await append({
        type: "milestone.landed",
        milestone: a.milestone,
        commit: m.commit,
        knownIssues: a.knownIssues,
        digestPath: r.digestPath,
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
        return void (await append({ type: "plan.ready", milestones: planOf(run) }));
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
        if (milestoneOf(s, a.unit))
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
        const reportPath = writeRunReport(run, s, readEvents(run));
        return void (await append({ type: "run.ended", outcome: a.outcome, reportPath }));
      }
      case "classify":
      case "checkMerged":
      case "integrate":
        throw new Error(`${a.type} needs catherd 30b`);
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
