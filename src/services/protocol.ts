import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord } from "../domain/record.ts";
import type { RouteRow } from "../domain/route.ts";
import { ensurePrivateDir, readJsonl, writeTextAtomic } from "../infra/store.ts";
import { type Dispatch, listDispatches, liveDispatches } from "./dispatches.ts";
import type { VerifierStep } from "./gate-service.ts";
import {
  landedMilestones,
  milestoneReviewer,
  milestoneStart,
  namesMilestone,
  reviewerPassed,
  verifierPassed,
} from "./milestones.ts";
import { readAgentRuns, readRecords, readRoutes, type Run, runPaths } from "./run-store.ts";

// Spec 1.1 §10: the protocol's next step, derived from the run's own files so a session that lost its
// context (a compaction, a restart) re-enters the milestone loop where it stands; and each landed
// milestone's digest.

/** The milestone loop, six lines, as run_start and peek return it. */
export const PROTOCOL_CHECKLIST = [
  "1. route and preflight the milestone's lanes (dispatch routes a lane not routed yet)",
  "2. dispatch every independent lane one after another, then end your turn: results arrive as catherd messages",
  "3. per result: result(run, name), its STATUS and changedOwned, then its fast check once",
  "4. reviewer-<M> once over the milestone diff, then one fix round",
  "5. the verifier in the foreground, with gate_check and gate_pass, recorded as record_agent_run(name: verifier-<M>)",
  "6. commit, then land(run, <M>, …); an owner question parks the milestone (park) and the run goes on",
];

const milestoneOf = (lane: string): string => lane.split(".")[0] as string;
const byNumber = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** The run's lanes, from lanes/*.md, in milestone and lane order. */
function laneIds(run: Run): string[] {
  const dir = runPaths(run.dir).lanes;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -".md".length))
    .filter((l) => l.includes("."))
    .sort(byNumber);
}

/**
 * Whether `lane` needs no dispatch now: its latest dispatch or native agent run since its latest route row
 * (a climb writes one) is still running, or ended ok with no blocked or refused reply. A lane whose last
 * try failed, hit a limit, was blocked, or was climbed since goes back to dispatch.
 */
function laneDone(run: Run, lane: string, routes: RouteRow[], live: Dispatch[]): boolean {
  const from = Math.max(...routes.filter((r) => r.lane === lane).map((r) => Date.parse(r.at)));
  // a dispatch routes its lane first, so a try at the route's own time counts as after it
  const after = (t: string) => !(Date.parse(t) < from);
  const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
  const running = new Set(live.map((d) => d.admit.dispatchId));
  const tries = [
    ...listDispatches(run)
      .filter((d) => d.admit.lane === lane && after(d.admit.admittedAt))
      .map((d) => {
        const r = records.get(d.admit.dispatchId);
        const ok = r
          ? r.status === "ok" && r.replyStatus !== "blocked" && r.replyStatus !== "refused"
          : running.has(d.admit.dispatchId);
        return { at: Date.parse(d.admit.admittedAt), ok };
      }),
    ...readAgentRuns(run)
      .filter((a) => a.lane === lane && after(a.at))
      .map((a) => ({ at: Date.parse(a.at), ok: a.status === "ok" })),
  ];
  const latest = tries.reduce<(typeof tries)[number] | null>(
    (best, t) => (best === null || t.at >= best.at ? t : best),
    null,
  );
  return latest?.ok ?? false;
}

/**
 * The step the milestone loop is at: the first milestone neither landed nor parked, and within it the
 * first of route, dispatch, collect, reviewer, verifier and land that is still to do.
 */
export function protocolNext(run: Run, parked: string[], now = Date.now()): string {
  const lanes = laneIds(run);
  if (lanes.length === 0)
    return "plan: the architect writes plan.md and lanes/Mx.Ly.md (or you, for a fix run)";
  const landed = new Set(landedMilestones(run));
  const milestones = [...new Set(lanes.map(milestoneOf))].sort(byNumber);
  const m = milestones.find((x) => !landed.has(x) && !parked.includes(x));
  if (!m)
    return parked.length
      ? `${parked.join(", ")} parked: wait for the owner`
      : "finish: the final gate, then the report";
  const mine = lanes.filter((l) => milestoneOf(l) === m);
  const routes = readRoutes(run);
  const routed = new Set(routes.map((r) => r.lane));
  if (mine.some((l) => !routed.has(l))) return `route and preflight ${m}'s lanes`;
  const live = liveDispatches(run, now);
  const waiting = mine.filter((l) => !laneDone(run, l, routes, live));
  if (waiting.length) return `dispatch ${waiting.join(", ")}`;
  const running = live.filter((d) => d.admit.lane !== null && mine.includes(d.admit.lane));
  if (running.length) return `${m}: lanes running (${running.map((d) => d.admit.name).join(", ")})`;
  const start = milestoneStart(run, m);
  if (!reviewerPassed(run, m, start)) return `${m}: reviewer`;
  if (!verifierPassed(run, m, start)) return `${m}: verifier`;
  return `land ${m}`;
}

/** What run_start and peek return beside the step: the six-line loop. */
export const protocolView = (run: Run, parked: string[], now?: number) => ({
  next: protocolNext(run, parked, now),
  checklist: PROTOCOL_CHECKLIST,
});

const FINDING = /^\s*(?:[-*]\s*)?(BLOCKER|BUG|NIT)\b/;

function findingCounts(run: Run, r: RunRecord | undefined): string {
  if (!r?.replyPath) return "no reply";
  const file = join(run.dir, r.replyPath);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const n = { BLOCKER: 0, BUG: 0, NIT: 0 };
  for (const line of text.split("\n")) {
    const k = FINDING.exec(line)?.[1] as keyof typeof n | undefined;
    if (k) n[k]++;
  }
  const total = n.BLOCKER + n.BUG + n.NIT;
  return `${total} finding(s): ${n.BLOCKER} BLOCKER, ${n.BUG} BUG, ${n.NIT} NIT`;
}

const k = (x: number) => (x >= 1000 ? `${Math.round(x / 1000)}k` : String(x));

/**
 * Spec 1.1 §10: `R/digests/<m>.md`, written by `land`: the A-lines it names, the commit, the lanes with
 * their rungs and climbs, the reviewer's findings, the verifier's verdict with its carried items, minutes
 * and tokens. Returns its path relative to the run folder.
 */
export function writeDigest(
  run: Run,
  i: { milestone: string; what: string; commit: string; evidence: string; minutes: number; at: string },
): string {
  const m = i.milestone;
  const start = milestoneStart(run, m);
  const inM = (lane: string | null | undefined) => typeof lane === "string" && lane.startsWith(`${m}.`);
  const named = new Set([...`${i.what} ${i.evidence}`.matchAll(/\bA(\d+)\b/g)].map((x) => `A${x[1]}`));
  const aLines = run.meta.aLines.filter((a) => named.has(/^\s*(A\d+)/.exec(a)?.[1] ?? ""));
  const routes = readRoutes(run).filter((r) => inM(r.lane));
  const lanes = [...new Set(routes.map((r) => r.lane))].sort(byNumber).map((lane) => {
    const rows = routes.filter((r) => r.lane === lane);
    const climbs = rows.filter((r) => r.source === "climb" && r.from !== r.rung);
    const first = rows[0]?.rung ?? "?";
    const last = rows.at(-1)?.rung ?? first;
    return `- ${lane} · ${first}${last !== first ? ` → ${last}` : ""}${climbs.length ? ` · climbs: ${climbs.map((c) => c.reason ?? "").join("; ")}` : ""}`;
  });
  const records = readRecords(run).records;
  // the reviewer the gate counted: since the milestone's lanes started, a dispatch or a native subagent
  const reviewer = milestoneReviewer(run, m, start);
  const agents = readAgentRuns(run);
  const verifier = agents.findLast((a) => a.role === "verifier" && namesMilestone(a.name, m));
  const steps = readJsonl<VerifierStep>(join(run.dir, "verifier.jsonl")).rows.filter(
    (s) => s.carried && (start === null || Date.parse(s.at) >= Date.parse(start)),
  );
  const mineRecords = records.filter((r) => inM(r.lane) || namesMilestone(r.name, m));
  const tokens = mineRecords.reduce(
    (t, r) => ({
      input: t.input + r.tokens.input,
      cached: t.cached + r.tokens.cached,
      output: t.output + r.tokens.output,
    }),
    { input: 0, cached: 0, output: 0 },
  );
  const reported = agents
    .filter((a) => inM(a.lane) || namesMilestone(a.name, m))
    .reduce((n, a) => n + a.totalTokens, 0);
  const text = [
    `# ${m} — ${i.what}`,
    "",
    `Commit ${i.commit} · ${i.minutes} min · landed ${i.at}`,
    `A-lines: ${aLines.length ? aLines.join("; ") : "none named in what or evidence"}`,
    "",
    "Lanes:",
    ...(lanes.length ? lanes : ["- none routed"]),
    "",
    `Reviewer: ${reviewer ? `${reviewer.name} · ${reviewer.record ? findingCounts(run, reviewer.record) : "a Claude subagent (findings in its reply)"}` : "none"}`,
    `Verifier: ${verifier ? `${verifier.status === "ok" ? "PASS" : verifier.status} (${verifier.name})` : "none"}${steps.length ? ` · carried: ${steps.map((s) => `${s.item}${s.commit ? ` from ${s.commit}` : ""}`).join(", ")}` : ""}`,
    `Evidence: ${i.evidence}`,
    `Tokens: ${k(tokens.input)} in (${k(tokens.cached)} cached) · ${k(tokens.output)} out · Claude subagents ${k(reported)} (reported)`,
    "",
  ].join("\n");
  const dir = join(run.dir, "digests");
  ensurePrivateDir(dir);
  writeTextAtomic(join(dir, `${m}.md`), text);
  return `digests/${m}.md`;
}
