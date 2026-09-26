import { BUDGET_CHEAP_AT } from "../domain/budget.ts";
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
import { candidates, defaultLadder, type Pick, type RoutingProfile, select } from "../domain/select.ts";
import { catalogQuery, freshenDiscovery, loadCatalog } from "./catalog-service.ts";
import { type Asked, askJev, type JevOpts, jevQuestions, logJev } from "./jev-service.ts";
import type { ProfileView, RouteAnswer, RouteRequest, RoutingPort, Verdict } from "./ports.ts";

function routingProfile(v: ProfileView, role: Role, spentFraction: number): RoutingProfile {
  const rc = v.roles[role];
  return {
    // spec §4.6: from 80 % of the budget on, start at the cheapest rung that clears the bar
    objective: spentFraction >= BUDGET_CHEAP_AT ? "cost" : v.objective,
    billing: v.billing,
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
  ...pick,
  source,
  kind,
  difficulty,
  questionSet: asked?.answers ? asked.meta.questionSet : null,
  jev,
});

/** How long `route` waits on the daily discovery refresh before routing on the cached listing. */
export const DISCOVERY_BUDGET_MS = 5_000;

export interface RoutingOpts extends JevOpts {
  /** how long a route waits on the discovery refresh (DISCOVERY_BUDGET_MS) */
  discoveryBudgetMs?: number;
}

/** A wedged listing never holds a route: past `ms` it routes on the cache while the refresh finishes. */
async function freshenWithin(rungs: string[], ms: number): Promise<void> {
  const refresh = freshenDiscovery(rungs).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([refresh, budget]);
  clearTimeout(timer);
}

/**
 * Spec §5.4: kind and difficulty from Jev (§5.5's rule), else the lane file's `Kind:`/`Difficulty:`,
 * else the role's default rung. A role with one usable rung never asks Jev.
 */
async function route(req: RouteRequest, o: RoutingOpts): Promise<RouteAnswer> {
  const p = routingProfile(req.profile, req.role, req.spentFraction);
  await freshenWithin(p.role.rungs, o.discoveryBudgetMs ?? DISCOVERY_BUDGET_MS);
  const c = loadCatalog();
  const fallback = () => defaultLadder(c, p, req.role);
  if (req.laneText === null || candidates(c, p, req.role).length <= 1)
    return answer(fallback(), "default", null, null, null, null);
  const lane = parseLaneHeader(req.laneText);
  let asked: Asked | null = null;
  let judged: ReturnType<typeof judgeRoute> | null = null;
  if (req.profile.jev.use !== "off") {
    asked = await askJev(req.runDir, "route-v2", laneState(req.laneText), o);
    if (asked.answers) judged = judgeRoute(jevQuestions().sets["route-v2"].rule, asked.answers);
  }
  const jev: RouteJev | null = judged
    ? { pKind: judged.pKind, pA: judged.pA, pB: judged.pB, nouls: judged.nouls }
    : null;
  let out: RouteAnswer;
  if (judged?.track && judged.difficulty) {
    const kind = judged.kind ?? lane.kind ?? "repo_code";
    out = answer(select(c, p, req.role, kind, judged.difficulty), "jev", kind, judged.difficulty, asked, jev);
  } else {
    const kind = judged?.kind ?? lane.kind;
    out =
      kind && lane.difficulty
        ? answer(select(c, p, req.role, kind, lane.difficulty), "lane", kind, lane.difficulty, asked, jev)
        : answer(fallback(), "default", null, null, asked, jev);
  }
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

async function verdict<T extends string>(
  runDir: string,
  set: Extract<SetName, "finding" | "same-defect">,
  state: Record<string, unknown>,
  options: readonly T[],
  o: JevOpts,
): Promise<Verdict<T>> {
  const asked = await askJev(runDir, set, state, o);
  const rule = jevQuestions().sets[set].rule;
  const v = judgeVerdict(rule, set, options, asked.answers as JevAnswers | null);
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

/** The routing port over the 1.0 catalog and Jev (spec §5); `o` lets tests inject Jev's transport. */
export function routingService(o: RoutingOpts = {}): RoutingPort {
  return {
    route: (req) => route(req, o),
    finding: (runDir, laneText, finding) =>
      verdict(
        runDir,
        "finding",
        { lane: laneState(laneText), finding: scrubFree(finding) },
        VERDICT_OPTIONS.finding,
        o,
      ),
    sameDefect: (runDir, before, after) =>
      verdict(
        runDir,
        "same-defect",
        { before: scrubFree(before), after: scrubFree(after) },
        VERDICT_OPTIONS["same-defect"],
        o,
      ),
    catalog: (filter) => catalogQuery(filter),
  };
}
