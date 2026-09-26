import { BUDGET_CHEAP_AT } from "../domain/budget.ts";
import {
  type JevAnswers,
  judgeRoute,
  judgeVerdict,
  laneState,
  type SetName,
  scrubSecrets,
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

/**
 * Spec §5.4: kind and difficulty from Jev (§5.5's rule), else the lane file's `Kind:`/`Difficulty:`,
 * else the role's default rung. A role with one usable rung never asks Jev.
 */
async function route(req: RouteRequest, o: JevOpts): Promise<RouteAnswer> {
  const p = routingProfile(req.profile, req.role, req.spentFraction);
  await freshenDiscovery(p.role.rungs);
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
export function routingService(o: JevOpts = {}): RoutingPort {
  return {
    route: (req) => route(req, o),
    finding: (runDir, laneText, finding) =>
      verdict(
        runDir,
        "finding",
        { lane: laneState(laneText), finding: scrubSecrets(finding) },
        ["design", "code", "unclear"] as const,
        o,
      ),
    sameDefect: (runDir, before, after) =>
      verdict(
        runDir,
        "same-defect",
        { before: scrubSecrets(before), after: scrubSecrets(after) },
        ["yes", "no"] as const,
        o,
      ),
    catalog: (filter) => catalogQuery(filter),
  };
}
