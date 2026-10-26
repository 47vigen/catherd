import { basename } from "node:path";
import { assertNativeHost } from "./backends.ts";
import { percentilesOf } from "../domain/bars.ts";
import { BUDGET_CHEAP_AT } from "../domain/budget.ts";
import {
  aboveFloor,
  difficultyQuestions,
  judgeVerdict as judgeDecisionVerdict,
  levelsOf,
  pickLevel,
  sha256,
  VERDICT_OPTIONS as DECISION_OPTIONS,
  type VerdictSetName,
} from "../domain/decision.ts";
import { errorMessage } from "../domain/errors.ts";
import { quotaOf } from "../domain/failover.ts";
import {
  type JevAnswers,
  judgeRoute,
  judgeVerdict,
  VERDICT_OPTIONS,
  laneState,
  type SetName,
  scrubFree,
} from "../domain/jev.ts";
import { type Difficulty, type Kind, parseLaneHeader } from "../domain/lane.ts";
import type { Role } from "../domain/roles.ts";
import type { RouteJev } from "../domain/route.ts";
import { laneSlack } from "../domain/slack.ts";
import { CHORE_WHY, learnedStart, type OutcomeStat } from "../domain/track-record.ts";
import type { Catalog } from "../domain/catalog.ts";
import {
  candidates,
  cheapest,
  decisionCandidates,
  defaultDifficulty,
  defaultLadder,
  type Pick,
  quotaUsage,
  type RoutingProfile,
  rolesWithoutRung,
  noRungCause,
  select,
  startAt,
  tieBreak,
} from "../domain/select.ts";
import { log } from "../infra/log.ts";
import { catalogQuery, freshenDiscovery, loadCatalog, startIndex } from "./catalog-service.ts";
import { type Asked, askJev, type JevOpts, jevQuestions, logJev } from "./jev-service.ts";
import {
  type DecisionConfig,
  askDecision,
  decisionQuestions,
  logDecision,
  probeDecision,
} from "./decision-service.ts";
import type {
  DecideAnswer,
  DecideRequest,
  ProfileView,
  RouteAnswer,
  RouteRequest,
  RoutingPort,
  Verdict,
} from "./ports.ts";
import { outcomeStats } from "./outcome-summary.ts";
import { provenanceOf } from "./provenance.ts";
import { type EvidenceTable, runEvidence } from "./run-evidence.ts";
import { readEvents } from "./run-events-store.ts";

/** The most Jev route requests one batch has in flight at once. */
export const JEV_PARALLEL = 4;

function routingProfile(
  v: ProfileView,
  role: Role,
  spentFraction: number,
  usage: Record<string, number> = {},
): RoutingProfile {
  const rc = v.roles[role];
  return {
    usage,
    // spec §4.6: from 80 % of the budget on, start at the cheapest rung that clears the bar
    objective: spentFraction >= BUDGET_CHEAP_AT ? "cost" : v.objective,
    billing: v.billing,
    maxEffort: v.maxEffort ?? {},
    bars: { ...v.bars, ...rc?.bars },
    role: {
      enabled: rc?.enabled ?? false,
      rungs: rc?.rungs ?? [],
      ...(rc?.defaultRung ? { defaultRung: rc.defaultRung } : {}),
    },
  };
}

const answer = (
  pick: Pick,
  source: RouteAnswer["source"],
  kind: Kind | null,
  difficulty: Difficulty | null,
  asked: Asked | null,
  jev: RouteJev | null,
): RouteAnswer => ({
  rung: pick.rung,
  ladder: pick.ladder,
  source,
  kind,
  difficulty,
  questionSet: asked?.answers ? asked.meta.questionSet : null,
  jev,
  jevSaid: null,
  why: "",
  ...(pick.noClear ? { noClear: pick.noClear } : {}),
  ...(pick.tie ? { tie: pick.tie } : {}),
});

/** Spec 1.5 plan 24: what Jev said when it differs from the kind and difficulty the route used, else null. */
function jevSaid(
  judged: ReturnType<typeof judgeRoute> | null,
  kind: Kind | null,
  difficulty: Difficulty | null,
): string | null {
  if (!judged) return null;
  const k = judged.kind;
  const d = judged.track ? judged.difficulty : null;
  if ((k === null || k === kind) && (d === null || d === difficulty)) return null;
  return `Jev said ${k ?? "no sure kind"}/${d ?? "no sure difficulty"}`;
}

/** Spec 1.5 plan 24: the route's one-line why, for the coordinator; the provenance goes to routes.jsonl. */
function whyOf(a: RouteAnswer, hasLane: boolean, rules: readonly string[]): string {
  const what = `${a.kind}/${a.difficulty}`;
  const head =
    a.source === "default" && rules.length > 0
      ? null
      : a.source === "lane"
        ? `the lane's Kind/Difficulty, ${what}`
        : a.source === "jev"
          ? `Jev: ${what}`
          : a.source === "jev-kind"
            ? `Jev's kind with ${what}`
            : hasLane
              ? "the role's default rung: neither Jev nor the lane file gave a kind and difficulty"
              : "the role's default rung";
  const start =
    rules.length > 0
      ? [...rules, a.noClear]
      : [a.noClear ?? (a.source === "default" ? null : "the first rung in objective order that clears it")];
  return [head, a.jevSaid, ...start, a.tie].filter((x): x is string => Boolean(x)).join("; ");
}

/** Spec 1.2 §8 evidence is display only: an unreadable run on this machine never fails a route. */
function evidenceOrNone(c: Catalog): EvidenceTable | null {
  try {
    return runEvidence(c);
  } catch (e) {
    log("debug", "route", { evidence: errorMessage(e) });
    return null;
  }
}

/** How long `route` waits on the daily discovery refresh before routing on the cached listing. */
const DISCOVERY_BUDGET_MS = 5_000;

export interface RoutingOpts extends JevOpts {
  /** how long a route waits on the discovery refresh (DISCOVERY_BUDGET_MS) */
  discoveryBudgetMs?: number;
}

/** A wedged listing never holds a route: past `ms` it routes on the cache while the refresh finishes. */
async function freshenWithin(rungs: string[], repo: string, ms: number): Promise<void> {
  const refresh = freshenDiscovery(rungs, Date.now(), repo).catch((e: unknown) =>
    log("debug", "discovery", { error: errorMessage(e) }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([refresh, budget]);
  clearTimeout(timer);
}

/**
 * What every route of one call shares: the role's routing profile and the catalog, each lane's slack in the run's
 * remaining plan, and the outcome record of this machine's runs. Slack and stats are null when they cannot be read
 * (no plan yet, a 1.x run, a corrupt file): a route never fails on them.
 */
interface Prepared {
  p: RoutingProfile;
  c: Catalog;
  slack: Map<string, number> | null;
  stats: OutcomeStat[] | null;
}

function slackOf(runDir: string): Map<string, number> | null {
  try {
    const events = readEvents({ id: basename(runDir), dir: runDir });
    const plan = events.findLast((e) => e.type === "plan.ready");
    if (!plan) return null;
    const done = new Set(events.flatMap((e) => (e.type === "milestone.landed" ? [e.milestone] : [])));
    return laneSlack(plan.milestones, done);
  } catch (e) {
    log("debug", "route", { slack: errorMessage(e) });
    return null;
  }
}

function statsOrNone(): OutcomeStat[] | null {
  try {
    return outcomeStats();
  } catch (e) {
    log("debug", "route", { outcomes: errorMessage(e) });
    return null;
  }
}

/** The cheapest capable rung of `role` under the profile, or null when it has none. */
export function cheapestRung(view: ProfileView, role: Role, repo: string, runDir: string): string | null {
  const p = routingProfile(view, role, 0);
  const c = loadCatalog({ repo, runDir });
  return candidates(c, p, role).length === 0 ? null : cheapest(c, p, role).rung;
}

async function prepare(req: RouteRequest, o: RoutingOpts): Promise<Prepared> {
  const p = routingProfile(req.profile, req.role, req.spentFraction, req.usage);
  await freshenWithin(p.role.rungs, req.repo, o.discoveryBudgetMs ?? DISCOVERY_BUDGET_MS);
  return {
    p,
    c: loadCatalog({ repo: req.repo, runDir: req.runDir }),
    slack: slackOf(req.runDir),
    stats: statsOrNone(),
  };
}

/** Jev's answer about a lane; null when the route reads no lane, empty when it asks nothing (Jev off, one usable rung). */
interface Judged {
  asked: Asked | null;
  judged: ReturnType<typeof judgeRoute> | null;
}

async function judge(req: RouteRequest, { p, c }: Prepared, o: RoutingOpts): Promise<Judged | null> {
  if (req.laneText === null) return null;
  // a chore lane starts on the cheapest rung whatever Jev would say
  if (parseLaneHeader(req.laneText).chore) return { asked: null, judged: null };
  // one usable rung: nothing for Jev to choose, but the lane's header still names its kind and difficulty
  if (req.profile.jev.use === "off" || candidates(c, p, req.role).length <= 1)
    return { asked: null, judged: null };
  const asked = await askJev(req.runDir, "route-v2", laneState(req.laneText), o);
  const judged = asked.answers ? judgeRoute(jevQuestions().sets["route-v2"].rule, asked.answers) : null;
  return { asked, judged };
}

/** The difficulty whose bar a lane with slack is held to. */
const EASIER: Record<Difficulty, Difficulty> = { copy: "copy", build: "copy", logic: "build", hard: "logic" };

/**
 * The start for a lane of `difficulty`: the bar's first rung, held to the next easier bar when the lane has slack,
 * then a cheaper rung with a better record on this machine, then (for a lane with no slack) no lower than the role's
 * default rung. The recorded difficulty stays the lane's own. A lane with no slack value routes on its bar alone.
 */
function pickFor(
  req: RouteRequest,
  { p, c, slack, stats }: Prepared,
  difficulty: Difficulty,
): { pick: Pick; rules: string[] } {
  const s = req.lane === null ? undefined : slack?.get(req.lane);
  const rules: string[] = [];
  let bar = difficulty;
  if (s !== undefined && s > 0 && EASIER[difficulty] !== difficulty) {
    bar = EASIER[difficulty];
    rules.push(`slack ${s}: held to ${bar}'s bar`);
  }
  let pick = select(c, p, req.role, bar);
  if (stats) {
    const order = candidates(c, { ...p, objective: "cost" }, req.role).map((x) => x.rung);
    const learned = learnedStart(
      stats,
      order.slice(0, Math.max(0, order.indexOf(pick.rung))),
      difficulty,
      pick.rung,
    );
    if (learned) {
      pick = startAt(c, p, req.role, learned.rung);
      rules.push(learned.why);
    }
  }
  if (s === 0 && difficulty !== "copy") {
    const all = candidates(c, p, req.role);
    const intelligence = (rung: string) => all.find((x) => x.rung === rung)?.intelligence ?? 0;
    const floor = defaultLadder(c, p, req.role);
    if (intelligence(pick.rung) < intelligence(floor.rung)) {
      pick = floor;
      rules.push("critical path: no lower than the default rung");
    }
  }
  return { pick, rules };
}

/**
 * Spec §5.4: kind and difficulty from the lane file's `Kind:`/`Difficulty:` when it declares both (spec 1.5
 * plan 24: a declared header wins, and `jevSaid` names where Jev disagreed), else from Jev (§5.5's rule), else
 * the role's default rung. A kind Jev is sure of survives a difficulty in the dead band: the difficulty then
 * comes from the lane, else the role's default difficulty (`jev-kind`). A role with one usable rung never asks
 * Jev. Plan 41: a `Chore: yes` lane starts on the cheapest rung and Jev is not asked; the other starts follow
 * `pickFor`.
 */
function decide(req: RouteRequest, prep: Prepared, j: Judged | null): RouteAnswer {
  const { p, c } = prep;
  const fallback = () => defaultLadder(c, p, req.role);
  let rules: string[] = [];
  const finish = (out: RouteAnswer): RouteAnswer => {
    out.why = whyOf(out, req.laneText !== null, rules);
    out.provenance = provenanceOf(
      c,
      out.rung,
      out.kind,
      out.difficulty,
      p.billing,
      evidenceOrNone(c),
      percentilesOf(p),
    );
    return out;
  };
  const start = (difficulty: Difficulty): Pick => {
    const r = pickFor(req, prep, difficulty);
    rules = r.rules;
    return r.pick;
  };
  if (req.laneText === null) return finish(answer(fallback(), "default", null, null, null, null));
  const lane = parseLaneHeader(req.laneText);
  if (lane.chore) {
    rules = [CHORE_WHY];
    const source = lane.kind && lane.difficulty ? "lane" : "default";
    return finish(answer(cheapest(c, p, req.role), source, lane.kind, lane.difficulty, null, null));
  }
  if (j === null) return finish(answer(fallback(), "default", null, null, null, null));
  const { asked, judged } = j;
  const jev: RouteJev | null = judged
    ? { pKind: judged.pKind, pA: judged.pA, pB: judged.pB, nouls: judged.nouls }
    : null;
  let out: RouteAnswer;
  if (lane.kind && lane.difficulty) {
    out = answer(start(lane.difficulty), "lane", lane.kind, lane.difficulty, asked, jev);
  } else if (judged?.track && judged.difficulty) {
    const kind = lane.kind ?? judged.kind ?? "repo_code";
    out = answer(start(judged.difficulty), "jev", kind, judged.difficulty, asked, jev);
  } else if (judged?.kind) {
    const kind = (lane.kind ?? judged.kind) as Kind;
    const difficulty = lane.difficulty ?? defaultDifficulty(c, p, req.role);
    out = answer(start(difficulty), "jev-kind", kind, difficulty, asked, jev);
  } else if (lane.kind) {
    const difficulty = lane.difficulty ?? defaultDifficulty(c, p, req.role);
    out = answer(start(difficulty), "lane", lane.kind, difficulty, asked, jev);
  } else {
    out = answer(fallback(), "default", null, null, asked, jev);
  }
  out.jevSaid = out.source === "default" ? null : jevSaid(judged, out.kind, out.difficulty);
  finish(out);
  if (asked) {
    logJev(req.runDir, {
      ...asked.meta,
      call: "route-v2",
      lane: req.lane,
      answers: asked.answers,
      derived: judged
        ? { ...jev, kind: judged.kind, track: judged.track, difficulty: judged.difficulty }
        : null,
      used: `${req.role} ${out.rung}`,
      source: out.source,
      why: asked.why ?? (judged ? judged.rule : "no answers"),
    });
  }
  return out;
}

async function route(req: RouteRequest, o: RoutingOpts): Promise<RouteAnswer> {
  const prep = await prepare(req, o);
  return decide(req, prep, await judge(req, prep, o));
}

/**
 * Spec 1.5 plan 24, batch `route`: the lanes of one role (one run, one profile) share one discovery refresh and
 * one catalog, and Jev is asked with at most `JEV_PARALLEL` in flight (Ruling 6: one request per lane,
 * so each keeps its own cache key and jev.jsonl row). Then each lane is decided in order, every
 * routed start counting as a use of its quota, so lanes that tie spread over the quotas.
 */
async function routeMany(reqs: RouteRequest[], o: RoutingOpts): Promise<RouteAnswer[]> {
  const first = reqs[0];
  if (!first) return [];
  const prep = await prepare(first, o);
  const judged: (Judged | null)[] = Array.from({ length: reqs.length }, () => null);
  let next = 0;
  const lane = async () => {
    while (next < reqs.length) {
      const n = next++;
      judged[n] = await judge(reqs[n] as RouteRequest, prep, o);
    }
  };
  await Promise.all(Array.from({ length: Math.min(JEV_PARALLEL, reqs.length) }, lane));
  const usage: Record<string, number> = { ...first.usage };
  return reqs.map((req, i) => {
    const out = decide(req, { ...prep, p: { ...prep.p, usage: { ...usage } } }, judged[i] ?? null);
    const q = quotaUsage([out.rung]);
    for (const [k, n] of Object.entries(q)) usage[k] = (usage[k] ?? 0) + n;
    return out;
  });
}

async function verdict<T extends string>(
  runDir: string,
  set: Extract<SetName, "finding" | "same-defect" | "stop" | "failure-class">,
  state: Record<string, unknown>,
  options: readonly T[],
  use: "auto" | "off",
  o: JevOpts,
): Promise<Verdict<T>> {
  const { rule, questions } = jevQuestions().sets[set];
  // a verdict set holds one question; failure-class names it failure_class, not after the set
  const id = Object.keys(questions)[0] ?? set;
  // spec §5.5: Jev off means no question and no jev.jsonl row; the rule's default answers
  if (use === "off") return judgeVerdict(rule, id, options, null);
  const asked = await askJev(runDir, set, state, o);
  const v = judgeVerdict(rule, id, options, asked.answers as JevAnswers | null);
  logJev(runDir, {
    ...asked.meta,
    call: set,
    lane: null,
    answers: asked.answers,
    derived: null,
    used: v.value,
    source: v.source,
    why: asked.why ?? `p ${v.probability} ${v.source === "jev" ? "≥" : "<"} ${rule.min}`,
  });
  return v;
}

const UNSET =
  "the decision model is not set: catherd profile set decision.url https://<your-gateway>/v1 and decision.model <model>";

/** The profile's decision model, or the text that says it is not set (D25). */
function decisionConfig(v: ProfileView): DecisionConfig | string {
  const { url, model, minConfidence } = v.decision;
  return url && model ? { url, model, minConfidence } : UNSET;
}

/**
 * Plan 44 task 14: the levels of the role's rungs above the floor, then the decision model's pick of one. The floor
 * is applied to every candidate first, so a floor rung that is held or refused still holds the weaker rungs back.
 */
async function decideRung(req: DecideRequest, o: RoutingOpts): Promise<DecideAnswer> {
  const p = routingProfile(req.profile, req.role, req.state.spentFraction, req.usage);
  await freshenWithin(p.role.rungs, req.repo, o.discoveryBudgetMs ?? DISCOVERY_BUDGET_MS);
  const cands = decisionCandidates(loadCatalog({ repo: req.repo, runDir: req.runDir }), p, req.role);
  const open = new Set(
    cands
      .filter((x) => !req.exclude.includes(x.rung) && !req.held.includes(quotaOf(x.info.parsed)))
      .map((x) => x.rung),
  );
  const levels = aboveFloor(levelsOf(cands), req.floor, req.strict)
    .map((l) => ({ ...l, rungs: l.rungs.filter((r) => open.has(r)) }))
    .filter((l) => l.rungs.length > 0)
    .map((l, level) => ({ ...l, level }));
  if (levels.length === 0)
    return req.strict && req.floor !== null
      ? { ok: false, exhausted: true, floor: req.floor }
      : { ok: false, exhausted: false, error: "no rung", rungs: [] };
  const all = levels.flatMap((l) => l.rungs);
  const cfg = decisionConfig(req.profile);
  if (typeof cfg === "string") return { ok: false, exhausted: false, error: cfg, rungs: all };
  const n = levels.length;
  const levelRungs = levels.map((l) => l.rungs);
  // within a level only rungs of the first one's cost tier compete: headroom is free only inside a tier
  const tier = (rung: string) => cands.find((x) => x.rung === rung)?.cost.tier;
  const choose = (level: number) => {
    const rungs = levelRungs[level] as string[];
    return tieBreak(
      rungs.filter((r) => tier(r) === tier(rungs[0] as string)),
      req.usage,
    );
  };
  const row = (asked: Awaited<ReturnType<typeof askDecision>> | null, extra: Record<string, unknown>) =>
    logDecision(req.runDir, {
      call: "decide",
      key: asked?.meta.key ?? "",
      stateHash: asked?.meta.stateHash ?? "",
      model: asked?.meta.model ?? null,
      requestId: asked?.meta.requestId ?? null,
      usage: asked?.meta.usage ?? null,
      latencyMs: asked?.meta.latencyMs ?? null,
      attempts: asked?.meta.attempts ?? 0,
      // no answers: the cache reads only rows that hold them, and askDecision logged those
      answers: null,
      name: req.name,
      unit: req.unit,
      role: req.role,
      floor: req.floor,
      levels: n,
      briefHash: sha256(req.state.brief),
      ...extra,
    });
  if (n === 1) {
    const t = choose(0);
    row(null, { level: 0, rung: t.rung, source: "floor", probabilities: {} });
    return {
      ok: true,
      rung: t.rung,
      level: 0,
      levels: 1,
      levelRungs,
      source: "floor",
      p: null,
      probabilities: {},
      why: ["one level", t.why].filter(Boolean).join("; "),
    };
  }
  const f = decisionQuestions();
  const state = {
    ...req.state,
    rungs: levels.flatMap((l) =>
      l.rungs.map((rung) => ({ level: l.level, rung, intelligence: l.intelligence })),
    ),
  };
  const asked = await askDecision(
    req.runDir,
    cfg,
    "difficulty",
    state,
    difficultyQuestions(f, req.role, n),
    o,
  );
  const answers = asked.answers;
  const score = answers?.difficulty;
  if (!answers || score?.type !== "score")
    return { ok: false, exhausted: false, error: asked.why ?? "no usable answer", rungs: all };
  const nouls = Object.fromEntries(
    Object.entries(answers).flatMap(([id, a]) => (a.type === "noul" ? [[id, a.noul]] : [])),
  );
  const { floor, cap, noulMin } = f.sets.difficulty;
  const pick = pickLevel(score.probabilities, n, cfg.minConfidence, nouls, { floor, cap, noulMin });
  const t = choose(pick.level);
  row(asked, {
    level: pick.level,
    rung: t.rung,
    source: "model",
    probabilities: score.probabilities,
    rule: pick.rule,
  });
  return {
    ok: true,
    rung: t.rung,
    level: pick.level,
    levels: n,
    levelRungs,
    source: "model",
    p: pick.p,
    probabilities: score.probabilities,
    why: [pick.rule, t.why].filter(Boolean).join("; "),
  };
}

/** One verdict set asked of the profile's model: no answer is `ok: false`, an unsure one the rule's fallback. */
async function decisionVerdict(
  runDir: string,
  profile: ProfileView,
  set: VerdictSetName,
  state: Record<string, unknown>,
  o: RoutingOpts,
): Promise<{ ok: true; value: string; p: number } | { ok: false; error: string }> {
  const cfg = decisionConfig(profile);
  if (typeof cfg === "string") return { ok: false, error: cfg };
  const { rule, questions } = decisionQuestions().sets[set];
  // a verdict set holds one question; failure-class names it failure_class, not after the set
  const id = Object.keys(questions)[0] ?? set;
  const asked = await askDecision(runDir, cfg, set, state, questions, o);
  if (!asked.answers) return { ok: false, error: asked.why ?? "no usable answer" };
  const v = judgeDecisionVerdict(rule, id, DECISION_OPTIONS[set] as readonly string[], asked.answers);
  return { ok: true, value: v.value, p: v.probability ?? 0 };
}

/** The routing port over the 1.0 catalog and Jev (spec §5); `o` lets tests inject Jev's transport. */
export function routingService(o: RoutingOpts = {}): RoutingPort {
  return {
    route: async (req) => {
      const result = await route(req, o);
      assertNativeHost(result.rung, req.host ?? "unknown");
      return result;
    },
    routeMany: async (reqs) => {
      const results = await routeMany(reqs, o);
      results.forEach((r, i) => assertNativeHost(r.rung, reqs[i]?.host ?? "unknown"));
      return results;
    },
    finding: (runDir, laneText, finding, use) =>
      verdict(
        runDir,
        "finding",
        { lane: laneState(laneText), finding: scrubFree(finding) },
        VERDICT_OPTIONS.finding,
        use,
        o,
      ),
    sameDefect: (runDir, before, after, use) =>
      verdict(
        runDir,
        "same-defect",
        { before: scrubFree(before), after: scrubFree(after) },
        VERDICT_OPTIONS["same-defect"],
        use,
        o,
      ),
    stopCause: (runDir, status, reply, use) =>
      verdict(runDir, "stop", { status, reply: scrubFree(reply.slice(-4000)) }, VERDICT_OPTIONS.stop, use, o),
    failureClass: (runDir, text, use) =>
      verdict(
        runDir,
        "failure-class",
        { text: scrubFree(text.slice(-4000)) },
        VERDICT_OPTIONS["failure-class"],
        use,
        o,
      ),
    decide: (req) => decideRung(req, o),
    verdict: (runDir, profile, set, state) => decisionVerdict(runDir, profile, set, state, o),
    probe: async (profile) => {
      const cfg = decisionConfig(profile);
      return typeof cfg === "string" ? { ok: false, error: cfg } : probeDecision(cfg, o);
    },
    checkStart: async (view, repo) => {
      const { catalog, index } = await startIndex(repo);
      const unusable = rolesWithoutRung(catalog, view);
      return {
        unusable,
        causes: Object.fromEntries(unusable.map((role) => [role, noRungCause(catalog, view, role)])),
        index,
      };
    },
    catalog: (filter, billing) => catalogQuery(filter, billing),
  };
}
