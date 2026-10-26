import { z } from "zod";
import { BLOCKED_REASONS } from "./blocked.ts";
import { headlessRung } from "./ids.ts";
import type { Role } from "./roles.ts";
import { scrubKeyShapes, scrubSecretAssignments } from "./secrets.ts";

// Plan 44 Part A: the decision model's levels, level texts, state and pick rule, with the question
// schemas and verdict helpers.

export const DECISION_SOURCES = ["model", "floor", "failover", "coordinator"] as const;
export type DecisionSource = (typeof DECISION_SOURCES)[number];
export type Family = "code" | "review" | "plan";

const ChoiceQ = z.object({
  type: z.literal("choice"),
  instructions: z.string(),
  criteria: z.record(z.string(), z.string()),
});
const ScoreQ = z.object({
  type: z.literal("score"),
  instructions: z.string(),
  criteria: z.array(z.string()).min(2).max(10),
});
const NoulQ = z.object({
  type: z.literal("noul"),
  instructions: z.string(),
  criteria: z.object({ true: z.string(), false: z.string() }).optional(),
});
const QuestionSchema = z.discriminatedUnion("type", [ChoiceQ, ScoreQ, NoulQ]);
export type DecisionQuestion = z.infer<typeof QuestionSchema>;

const SixTexts = z.array(z.string()).length(6);
const VerdictRuleSchema = z.object({ min: z.number().min(0).max(1), fallback: z.string() });
export type VerdictRule = z.infer<typeof VerdictRuleSchema>;
const VerdictSet = z.object({ questions: z.record(z.string(), QuestionSchema), rule: VerdictRuleSchema });

/** catalog/decision.json. */
export const DecisionFileSchema = z.looseObject({
  schema: z.literal(1),
  sets: z.object({
    difficulty: z
      .object({
        instructions: z.string(),
        /** six level texts per family, weakest to strongest */
        levels: z.object({ code: SixTexts, review: SixTexts, plan: SixTexts }),
        nouls: z.record(z.string(), NoulQ),
        /** a yes to any of these floors the level at "new logic"; the floor wins over the cap */
        floor: z.array(z.string()),
        /** a yes to any of these holds the level at "follows an example" */
        cap: z.array(z.string()),
        noulMin: z.number().min(0).max(1),
      })
      .superRefine((d, ctx) => {
        for (const id of [...d.floor, ...d.cap])
          if (!(id in d.nouls))
            ctx.addIssue({ code: "custom", message: `${id} is no noul question of difficulty` });
      }),
    stop: VerdictSet,
    "failure-class": VerdictSet,
  }),
});
export type DecisionFile = z.infer<typeof DecisionFileSchema>;
export type VerdictSetName = "stop" | "failure-class";

/** The answers each verdict set's caller accepts; a set's `fallback` must be one of them. */
export const VERDICT_OPTIONS = {
  stop: [...BLOCKED_REASONS, "other"],
  "failure-class": ["product", "harness"],
} as const;

/** JSON with object keys sorted at every depth, so equal data always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export const sha256 = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex");

/** The per-run cache key of one request. */
export const requestKey = (model: string, state: unknown, questions: unknown): string =>
  sha256(canonicalJson({ model, state, questions }));

/**
 * Key-shaped strings (domain/secrets.ts) and `key = value` secrets replaced by [secret]; the pair, a
 * bearer and a URL's user keep their names.
 */
export const scrubSecrets = (text: string): string =>
  scrubSecretAssignments(scrubKeyShapes(text, "[secret]"), "[secret]");

/** Free text sent to the decision model (a finding, a defect): secrets scrubbed, nothing else cut (R4). */
export const scrubFree = (text: string): string => scrubSecrets(text);

const Prob = z.record(z.string(), z.number().min(0).max(1));
const AnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities: Prob, confidence: z.number() }),
  z.object({ type: z.literal("score"), score: z.number(), probabilities: Prob, confidence: z.number() }),
  z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
]);
type DecisionAnswer = z.infer<typeof AnswerSchema>;
export type DecisionAnswers = Record<string, DecisionAnswer>;

const ReplySchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

export type ParsedReply =
  | {
      ok: true;
      model: string;
      usage: { input_tokens: number; output_tokens: number } | null;
      answers: DecisionAnswers;
    }
  | { ok: false; error: string };

/** Every question answered, each in its own type and within its options, or an error naming the first. */
export function parseReply(questions: Record<string, DecisionQuestion>, body: unknown): ParsedReply {
  const r = ReplySchema.safeParse(body);
  if (!r.success) return { ok: false, error: "unexpected response" };
  const answers: DecisionAnswers = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = AnswerSchema.safeParse(r.data.answers[id]);
    if (!a.success || a.data.type !== q.type) return { ok: false, error: `no valid answer to ${id}` };
    if (a.data.type === "choice" && q.type === "choice" && !Object.hasOwn(q.criteria, a.data.choice))
      return { ok: false, error: `no valid answer to ${id}` };
    if (
      a.data.type === "score" &&
      q.type === "score" &&
      (Object.keys(a.data.probabilities).some((l) => !/^\d+$/.test(l) || Number(l) >= q.criteria.length) ||
        // no probability mass is no answer: it would pick the strongest level
        Object.values(a.data.probabilities).reduce((x, y) => x + y, 0) < 1e-6)
    )
      return { ok: false, error: `no valid answer to ${id}` };
    answers[id] = a.data;
  }
  return { ok: true, model: r.data.model, usage: r.data.usage ?? null, answers };
}

export interface Verdict<T extends string> {
  value: T;
  /** the chosen answer's probability, when the model answered */
  probability: number | null;
  /** the model's own confidence statistic, when it answered */
  confidence: number | null;
  source: "model" | "default";
}

/** A verdict set's chosen answer, unless the model is less sure than the rule's `min`: then the rule's fallback. */
export function judgeVerdict<T extends string>(
  rule: VerdictRule,
  id: string,
  options: readonly T[],
  answers: DecisionAnswers | null,
): Verdict<T> {
  const a = answers?.[id];
  const fallback = rule.fallback as T;
  if (!a || a.type !== "choice" || !(options as readonly string[]).includes(a.choice))
    return { value: fallback, probability: null, confidence: null, source: "default" };
  const p = a.probabilities[a.choice] ?? 0;
  const sure = p >= rule.min;
  return {
    value: sure ? (a.choice as T) : fallback,
    probability: p,
    confidence: a.confidence,
    source: sure ? "model" : "default",
  };
}

// --- levels ---------------------------------------------------------------------------------------

export interface Level {
  level: number;
  rungs: string[];
  intelligence: number;
}
export interface LevelPick {
  level: number;
  p: number | null;
  rule: string;
}
export interface NoulRule {
  floor: string[];
  cap: string[];
  noulMin: number;
}

const FAMILY: Record<Role, Family> = {
  worker: "code",
  writer: "code",
  artist: "code",
  researcher: "code",
  reviewer: "review",
  "ui-reviewer": "review",
  verifier: "review",
  architect: "plan",
  judge: "plan",
};
export const familyOf = (role: Role): Family => FAMILY[role];

/** Weakest first; rungs of equal intelligence share one level, in the order given. */
export function levelsOf(cands: readonly { rung: string; intelligence: number }[]): Level[] {
  const byIntelligence = new Map<number, string[]>();
  for (const c of cands)
    byIntelligence.set(c.intelligence, [...(byIntelligence.get(c.intelligence) ?? []), c.rung]);
  return [...byIntelligence]
    .sort((a, b) => a[0] - b[0])
    .map(([intelligence, rungs], level) => ({ level, rungs, intelligence }));
}

/**
 * The levels the floor rung allows, renumbered from 0: the floor's own level stays, unless `strict` drops it.
 * A floor that is no candidate (a stand-in of another backend, a rung gone from the listing) is placed by its
 * `floorIntelligence`; with none known, a strict floor allows nothing and a plain one every level.
 */
export function aboveFloor(
  levels: readonly Level[],
  floor: string | null,
  strict: boolean,
  floorIntelligence: number | null = null,
): Level[] {
  const renumber = (ls: readonly Level[]): Level[] => ls.map((l, level) => ({ ...l, level }));
  if (floor === null) return renumber(levels);
  // the daemon records a `claude:` rung as `claude-code:`, so the floor matches in either spelling
  const at = levels.findIndex((l) => l.rungs.some((r) => headlessRung(r) === headlessRung(floor)));
  if (at >= 0) return renumber(levels.slice(strict ? at + 1 : at));
  if (floorIntelligence === null) return strict ? [] : renumber(levels);
  return renumber(
    levels.filter((l) => (strict ? l.intelligence > floorIntelligence : l.intelligence >= floorIntelligence)),
  );
}

/** Level k of n as an index into the six texts. */
export const sixIndex = (k: number, n: number): number => (n < 2 ? 0 : Math.round((k * 5) / (n - 1)));

/** N level texts, evenly spaced over the six; fewer than two levels ask nothing. */
export function levelTexts(six: readonly string[], n: number): string[] {
  return n < 2 ? [] : Array.from({ length: n }, (_, k) => six[sixIndex(k, n)] ?? "");
}

/** `difficulty` (a score with one criterion per level) beside the noul signals; empty for fewer than two levels. */
export function difficultyQuestions(
  f: DecisionFile,
  role: Role,
  n: number,
): Record<string, DecisionQuestion> {
  const d = f.sets.difficulty;
  if (n < 2) return {};
  return {
    difficulty: {
      type: "score",
      instructions: d.instructions,
      criteria: levelTexts(d.levels[familyOf(role)], n),
    },
    ...d.nouls,
  };
}

// Rounded before comparing: 0.1 + 0.7 is 0.7999999999999999 in floating point, and must reach 0.8.
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * A level at probability `min` or more wins; else the lowest level whose own probability and everything
 * above it reaches `min` (the cumulative from the top); a model that gave too little mass gets the
 * strongest level. A noul yes then floors the level at the first whose six-index is 3 (new logic), or
 * else caps it at the last whose six-index is 2 (follows an example): the floor wins.
 */
export function pickLevel(
  probs: Readonly<Record<string, number>>,
  n: number,
  min: number,
  nouls: Readonly<Record<string, number>> = {},
  rule?: NoulRule,
): LevelPick {
  const p = (k: number) => probs[String(k)] ?? 0;
  if (n <= 1) return { level: 0, p: null, rule: "one level" };
  let pick: LevelPick | undefined;
  for (let k = n - 1; k >= 0 && !pick; k--)
    if (round6(p(k)) >= min) pick = { level: k, p: p(k), rule: `P(${k}) ${p(k)} ≥ ${min}` };
  let sum = 0;
  for (let k = n - 1; k >= 0 && !pick; k--) {
    sum = round6(sum + p(k));
    if (sum >= min) pick = { level: k, p: sum, rule: `P(≥${k}) ${sum} ≥ ${min}` };
  }
  pick ??= { level: n - 1, p: null, rule: `too little probability for ${min}` };
  if (!rule) return pick;
  const yes = (ids: string[]) => ids.find((id) => (nouls[id] ?? 0) >= rule.noulMin);
  const levels = Array.from({ length: n }, (_, k) => k);
  const lift = yes(rule.floor);
  const hold = lift === undefined ? yes(rule.cap) : undefined;
  const floorAt = levels.find((k) => sixIndex(k, n) >= 3) ?? n - 1;
  const capAt = levels.findLast((k) => sixIndex(k, n) <= 2) ?? 0;
  const level =
    lift !== undefined
      ? Math.max(pick.level, floorAt)
      : hold !== undefined
        ? Math.min(pick.level, capAt)
        : pick.level;
  if (level === pick.level) return pick;
  const [what, id] = lift !== undefined ? ["floor", lift] : ["cap", hold ?? ""];
  return { level, p: p(level), rule: `${pick.rule}; ${what}: ${id} ${nouls[id]}` };
}

// --- the state --------------------------------------------------------------------------------------

export interface DecisionState {
  role: Role;
  unit: string;
  round: number;
  isFix: boolean;
  floorRung: string | null;
  rungs: { level: number; rung: string; intelligence: number }[];
  previous: { rung: string; outcome: string; stopReason: string | null }[];
  spentFraction: number;
  slack: number | null;
  brief: string;
}

/** The state sent to the decision model: the whole brief, scrubbed of secrets (R4), nothing cut. */
export const decisionState = (i: DecisionState): DecisionState => ({ ...i, brief: scrubSecrets(i.brief) });
