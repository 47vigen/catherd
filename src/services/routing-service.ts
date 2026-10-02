import { assertNativeHost } from "./backends.ts";
import { BUDGET_CHEAP_AT } from "../domain/budget.ts";
import { errorMessage } from "../domain/errors.ts";
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
import type { Catalog } from "../domain/catalog.ts";
import {
  candidates,
  defaultDifficulty,
  defaultLadder,
  type Pick,
  quotaUsage,
  type RoutingProfile,
  select,
} from "../domain/select.ts";
import { log } from "../infra/log.ts";
import { catalogQuery, freshenDiscovery, loadCatalog } from "./catalog-service.ts";
import { type Asked, askJev, type JevOpts, jevQuestions, logJev } from "./jev-service.ts";
import type { ProfileView, RouteAnswer, RouteRequest, RoutingPort, Verdict } from "./ports.ts";
import { provenanceOf } from "./provenance.ts";
import { type EvidenceTable, runEvidence } from "./run-evidence.ts";

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
function whyOf(a: RouteAnswer, hasLane: boolean): string {
  const what = `${a.kind}/${a.difficulty}`;
  const head =
    a.source === "lane"
      ? `the lane's Kind/Difficulty, ${what}`
      : a.source === "jev"
        ? `Jev: ${what}`
        : a.source === "jev-kind"
          ? `Jev's kind with ${what}`
          : hasLane
            ? "the role's default rung: neither Jev nor the lane file gave a kind and difficulty"
            : "the role's default rung";
  const start =
    a.noClear ?? (a.source === "default" ? null : "the first rung in objective order that clears it");
  return [head, a.jevSaid, start, a.tie].filter((x): x is string => Boolean(x)).join("; ");
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

/** What every route of one call shares: the role's routing profile and the catalog. */
interface Prepared {
  p: RoutingProfile;
  c: Catalog;
}

async function prepare(req: RouteRequest, o: RoutingOpts): Promise<Prepared> {
  const p = routingProfile(req.profile, req.role, req.spentFraction, req.usage);
  await freshenWithin(p.role.rungs, req.repo, o.discoveryBudgetMs ?? DISCOVERY_BUDGET_MS);
  return { p, c: loadCatalog({ repo: req.repo }) };
}

/** Jev's answer about a lane; null when the route reads no lane, empty when it asks nothing (Jev off, one usable rung). */
interface Judged {
  asked: Asked | null;
  judged: ReturnType<typeof judgeRoute> | null;
}

async function judge(req: RouteRequest, { p, c }: Prepared, o: RoutingOpts): Promise<Judged | null> {
  if (req.laneText === null) return null;
  // one usable rung: nothing for Jev to choose, but the lane's header still names its kind and difficulty
  if (req.profile.jev.use === "off" || candidates(c, p, req.role).length <= 1)
    return { asked: null, judged: null };
  const asked = await askJev(req.runDir, "route-v2", laneState(req.laneText), o);
  const judged = asked.answers ? judgeRoute(jevQuestions().sets["route-v2"].rule, asked.answers) : null;
  return { asked, judged };
}

/**
 * Spec §5.4: kind and difficulty from the lane file's `Kind:`/`Difficulty:` when it declares both (spec 1.5
 * plan 24: a declared header wins, and `jevSaid` names where Jev disagreed), else from Jev (§5.5's rule), else
 * the role's default rung. A kind Jev is sure of survives a difficulty in the dead band: the difficulty then
 * comes from the lane, else the role's default difficulty (`jev-kind`). A role with one usable rung never asks
 * Jev.
 */
function decide(req: RouteRequest, { p, c }: Prepared, j: Judged | null): RouteAnswer {
  const fallback = () => defaultLadder(c, p, req.role);
  const finish = (out: RouteAnswer): RouteAnswer => {
    out.why = whyOf(out, req.laneText !== null);
    out.provenance = provenanceOf(c, out.rung, out.kind, out.difficulty, p.billing, evidenceOrNone(c));
    return out;
  };
  if (req.laneText === null || j === null)
    return finish(answer(fallback(), "default", null, null, null, null));
  const lane = parseLaneHeader(req.laneText);
  const { asked, judged } = j;
  const jev: RouteJev | null = judged
    ? { pKind: judged.pKind, pA: judged.pA, pB: judged.pB, nouls: judged.nouls }
    : null;
  let out: RouteAnswer;
  if (lane.kind && lane.difficulty) {
    out = answer(
      select(c, p, req.role, lane.kind, lane.difficulty),
      "lane",
      lane.kind,
      lane.difficulty,
      asked,
      jev,
    );
  } else if (judged?.track && judged.difficulty) {
    const kind = lane.kind ?? judged.kind ?? "repo_code";
    out = answer(select(c, p, req.role, kind, judged.difficulty), "jev", kind, judged.difficulty, asked, jev);
  } else if (judged?.kind || (judged && lane.kind)) {
    const kind = (lane.kind ?? judged.kind) as Kind;
    const difficulty = lane.difficulty ?? defaultDifficulty(c, p, req.role, kind);
    out = answer(select(c, p, req.role, kind, difficulty), "jev-kind", kind, difficulty, asked, jev);
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
 * one catalog, and Jev is asked about all of them at once (Ruling 6: one request per lane, all in flight
 * together, so each keeps its own cache key and jev.jsonl row). Then each lane is decided in order, every
 * routed start counting as a use of its quota, so lanes that tie spread over the quotas.
 */
async function routeMany(reqs: RouteRequest[], o: RoutingOpts): Promise<RouteAnswer[]> {
  const first = reqs[0];
  if (!first) return [];
  const prep = await prepare(first, o);
  const judged = await Promise.all(reqs.map((r) => judge(r, prep, o)));
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
  set: Extract<SetName, "finding" | "same-defect">,
  state: Record<string, unknown>,
  options: readonly T[],
  use: "auto" | "off",
  o: JevOpts,
): Promise<Verdict<T>> {
  const rule = jevQuestions().sets[set].rule;
  // spec §5.5: Jev off means no question and no jev.jsonl row; the rule's default answers
  if (use === "off") return judgeVerdict(rule, set, options, null);
  const asked = await askJev(runDir, set, state, o);
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
    catalog: (filter, billing) => catalogQuery(filter, billing),
  };
}
