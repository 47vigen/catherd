import { errorMessage } from "../domain/errors.ts";
import { quotaOf } from "../domain/failover.ts";
import {
  aboveFloor,
  difficultyQuestions,
  judgeVerdict,
  levelsOf,
  pickLevel,
  VERDICT_OPTIONS,
  type VerdictSetName,
} from "../domain/decision.ts";
import { headlessRung } from "../domain/ids.ts";
import { DECISION_UNSET_FIX } from "../domain/profile.ts";
import type { Role } from "../domain/roles.ts";
import {
  decisionCandidates,
  noRungCause,
  type RoutingProfile,
  rolesWithoutRung,
  tieBreak,
} from "../domain/select.ts";
import { log } from "../infra/log.ts";
import { catalogQuery, freshenDiscovery, loadCatalog, startIndex } from "./catalog-service.ts";
import {
  type AskOpts,
  askDecision,
  type DecisionConfig,
  decisionQuestions,
  probeDecision,
} from "./decision-service.ts";
import type { DecideAnswer, DecideRequest, ProfileView, RoutingPort } from "./ports.ts";

export function routingProfile(
  v: ProfileView,
  role: Role,
  usage: Record<string, number> = {},
): RoutingProfile {
  const rc = v.roles[role];
  return {
    usage,
    billing: v.billing,
    maxEffort: v.maxEffort ?? {},
    role: {
      enabled: rc?.enabled ?? false,
      rungs: rc?.rungs ?? [],
      ...(rc?.defaultRung ? { defaultRung: rc.defaultRung } : {}),
    },
  };
}

/** How long a decision waits on the daily discovery refresh before deciding on the cached listing. */
const DISCOVERY_BUDGET_MS = 5_000;

export interface RoutingOpts extends AskOpts {
  /** how long a decision waits on the discovery refresh (DISCOVERY_BUDGET_MS) */
  discoveryBudgetMs?: number;
}

/** A wedged listing never holds a decision: past `ms` it decides on the cache while the refresh finishes. */
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

const UNSET = `the decision model is not set: ${DECISION_UNSET_FIX}`;

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
  const p = routingProfile(req.profile, req.role, req.usage);
  await freshenWithin(p.role.rungs, req.repo, o.discoveryBudgetMs ?? DISCOVERY_BUDGET_MS);
  const cands = decisionCandidates(loadCatalog({ repo: req.repo, runDir: req.runDir }), p, req.role);
  const refused = req.exclude.map(headlessRung);
  const open = new Set(
    cands
      .filter((x) => !refused.includes(headlessRung(x.rung)) && !req.held.includes(quotaOf(x.info.parsed)))
      .map((x) => x.rung),
  );
  const above = aboveFloor(levelsOf(cands), req.floor, req.strict);
  const levels = above
    .map((l) => ({ ...l, rungs: l.rungs.filter((r) => open.has(r)) }))
    .filter((l) => l.rungs.length > 0)
    .map((l, level) => ({ ...l, level }));
  // a level above the floor with a rung that only a quota hold keeps out: wait for it, as a failover does
  if (
    levels.length === 0 &&
    above.some((l) => l.rungs.some((r) => !open.has(r) && !refused.includes(headlessRung(r))))
  )
    return {
      ok: false,
      exhausted: false,
      held: true,
      error: `every rung of the ${req.role} above the floor is on a held quota`,
      rungs: [],
    };
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
  if (n === 1) {
    const t = choose(0);
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
  const v = judgeVerdict(rule, id, VERDICT_OPTIONS[set] as readonly string[], asked.answers);
  return { ok: true, value: v.value, p: v.probability ?? 0 };
}

/** The routing port over the catalog and the profile's decision model (spec §5); `o` lets tests inject its transport. */
export function routingService(o: RoutingOpts = {}): RoutingPort {
  return {
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
