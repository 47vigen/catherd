import {
  type Catalog,
  DIFFICULTIES,
  KINDS,
  type Profile,
  type Role,
  type RouteDecision,
  type RungId,
} from "../types.ts";
import { callJev, type JevAnswers, type JevOpts, logJev, QUESTIONS } from "./jev.ts";
import { candidates, defaultLadder, select } from "./select.ts";

const ROUTE_MIN = 0.75;
const FINDING_MIN = 0.75;
const SAME_DEFECT_MIN = 0.7;
// spec §11b: at 80% of budget spent, the start rung is the cheapest bar-clearing one, regardless
// of objective, so a run that is close to its budget stops paying for speed or a favored model.
const BUDGET_FORCE = 0.8;

function read<T extends string>(
  answers: JevAnswers | null,
  id: string,
  options: readonly T[],
): { value: T; confidence: number } | null {
  const a = answers?.[id];
  return a && (options as readonly string[]).includes(a.choice)
    ? { value: a.choice as T, confidence: a.confidence }
    : null;
}

/** The cheapest bar-clearing pick, whatever the profile's own objective. */
function cheapestPick(
  p: Profile,
  c: Catalog,
  role: Role,
  kind: string | undefined,
  difficulty: string | undefined,
): { rung: RungId; ladder: RungId[] } {
  const costP = p.objective === "cost" ? p : { ...p, objective: "cost" as const };
  const isKind = (k: string): k is (typeof KINDS)[number] => (KINDS as readonly string[]).includes(k);
  const isDifficulty = (d: string): d is (typeof DIFFICULTIES)[number] =>
    (DIFFICULTIES as readonly string[]).includes(d);
  return kind && difficulty && isKind(kind) && isDifficulty(difficulty)
    ? select(costP, c, role, kind, difficulty)
    : defaultLadder(costP, c, role);
}

export async function route(
  o: {
    runDir: string;
    profile: Profile;
    catalog: Catalog;
    role: Role;
    laneText: string;
    budget?: { spentFraction: number };
  } & JevOpts,
): Promise<RouteDecision> {
  const { profile: p, catalog: c, role } = o;
  if (candidates(p, c, role).length <= 1) {
    return {
      kind: null,
      difficulty: null,
      confidence: { kind: null, difficulty: null },
      source: "default",
      ...defaultLadder(p, c, role),
    };
  }
  const { answers, error } = await callJev(
    { kind: QUESTIONS.kind, difficulty: QUESTIONS.difficulty },
    { lane: o.laneText },
    o,
  );
  const kind = read(answers, "kind", KINDS);
  const difficulty = read(answers, "difficulty", DIFFICULTIES);
  let pick = defaultLadder(p, c, role);
  let source: "jev" | "default" = "default";
  if (kind && difficulty && Math.min(kind.confidence, difficulty.confidence) >= ROUTE_MIN) {
    pick = select(p, c, role, kind.value, difficulty.value);
    source = "jev";
  }
  if ((o.budget?.spentFraction ?? 0) >= BUDGET_FORCE) {
    pick = cheapestPick(p, c, role, kind?.value, difficulty?.value);
  }
  logJev(o.runDir, {
    questions: ["kind", "difficulty"],
    answers,
    used: `${role} ${pick.rung}`,
    source,
    why:
      error ??
      `kind ${kind?.confidence}, difficulty ${difficulty?.confidence}: ${source === "jev" ? "both ≥" : "below"} ${ROUTE_MIN}`,
  });
  return {
    kind: kind?.value ?? null,
    difficulty: difficulty?.value ?? null,
    confidence: { kind: kind?.confidence ?? null, difficulty: difficulty?.confidence ?? null },
    source,
    ...pick,
  };
}

async function decide<T extends string>(
  runDir: string,
  id: "finding" | "same-defect",
  state: Record<string, string>,
  options: readonly T[],
  min: number,
  fallback: T,
  o: JevOpts,
): Promise<{ value: T; confidence: number | null; source: "jev" | "default" }> {
  const { answers, error } = await callJev({ [id]: QUESTIONS[id] }, state, o);
  const a = read(answers, id, options);
  const sure = a !== null && a.confidence >= min;
  const value = sure ? a.value : fallback;
  const source = sure ? "jev" : "default";
  logJev(runDir, {
    questions: [id],
    answers,
    used: value,
    source,
    why: error ?? `${a?.confidence} ${sure ? "≥" : "<"} ${min}`,
  });
  return { value, confidence: a?.confidence ?? null, source };
}

export function askFinding(
  runDir: string,
  laneText: string,
  finding: string,
  o: JevOpts = {},
): Promise<{ value: "design" | "code" | "unclear"; confidence: number | null; source: "jev" | "default" }> {
  return decide(
    runDir,
    "finding",
    { lane: laneText, finding },
    ["design", "code", "unclear"] as const,
    FINDING_MIN,
    "code",
    o,
  );
}

export function askSameDefect(
  runDir: string,
  before: string,
  after: string,
  o: JevOpts = {},
): Promise<{ value: "yes" | "no"; confidence: number | null; source: "jev" | "default" }> {
  return decide(runDir, "same-defect", { before, after }, ["yes", "no"] as const, SAME_DEFECT_MIN, "no", o);
}

export function nextRung(ladder: RungId[], current: RungId): RungId | null {
  const i = ladder.indexOf(current);
  return i >= 0 && i < ladder.length - 1 ? (ladder[i + 1] as RungId) : null;
}
