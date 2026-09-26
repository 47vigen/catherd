import { z } from "zod";
import { type Difficulty, KINDS, type Kind, parseLaneHeader } from "./lane.ts";

// Spec §5.5 and research 2026-09-25-jev.md: Jev's three question types, catherd's question sets as
// versioned data (catalog/jev.json), the trimmed lane state, and the decision rules.

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
export type JevQuestion = z.infer<typeof QuestionSchema>;

const RouteRuleSchema = z.object({
  kindMin: z.number().min(0).max(1),
  trackMin: z.number().gt(0.5).max(1),
  /** exactly two levels each, in order: copy then build, logic then hard */
  trackA: z.array(z.string()).length(2),
  trackB: z.array(z.string()).length(2),
});
export type RouteRule = z.infer<typeof RouteRuleSchema>;
const VerdictRuleSchema = z.object({ min: z.number().min(0).max(1), fallback: z.string() });
export type VerdictRule = z.infer<typeof VerdictRuleSchema>;

export const JevFileSchema = z.looseObject({
  schema: z.literal(1),
  model: z.string(),
  sets: z.object({
    "route-v2": z.object({ questions: z.record(z.string(), QuestionSchema), rule: RouteRuleSchema }),
    finding: z.object({ questions: z.record(z.string(), QuestionSchema), rule: VerdictRuleSchema }),
    "same-defect": z.object({ questions: z.record(z.string(), QuestionSchema), rule: VerdictRuleSchema }),
  }),
});
export type JevFile = z.infer<typeof JevFileSchema>;
export type SetName = keyof JevFile["sets"];

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

/** `<set>#<8 hex>` over the model, questions and rule: any change to one names a new question set. */
export function questionSetId(f: JevFile, name: SetName): string {
  const set = f.sets[name];
  return `${name}#${sha256(canonicalJson({ model: f.model, questions: set.questions, rule: set.rule })).slice(0, 8)}`;
}

/** The per-run cache key of one request. */
export const requestKey = (model: string, state: unknown, questions: unknown): string =>
  sha256(canonicalJson({ model, state, questions }));

const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_]*)\s*[:=]\s*["']?[^\s"']{6,}/gi,
];

/** Known secret shapes replaced by [secret]; a `key = value` pair keeps its key. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRETS)
    out = out.replace(re, (m, key?: string) => (typeof key === "string" ? `${key}=[secret]` : "[secret]"));
  return out;
}

/** Research §5.3: code is not what Jev judges, and long state rots its answers. */
export const BODY_MAX = 6000;
const HEADER = /^\s*[*_]*(owns|fast check|kind|difficulty)[*_]*\s*:/i;

export interface LaneState {
  title: string | null;
  owns: string[];
  fast_check: string | null;
  body: string;
}

/**
 * Spec §5.5: `{ title, owns, fast_check, body }`. The body drops the header lines (so Jev never echoes
 * the architect's own Kind/Difficulty), fenced code, and secrets, and is capped at BODY_MAX characters.
 */
export function laneState(text: string): LaneState {
  const h = parseLaneHeader(text);
  const body = dropFences(text)
    .split("\n")
    .filter((l) => !/^#\s/.test(l) && !HEADER.test(l))
    .join("\n")
    .trim();
  return {
    title: h.title === null ? null : scrubSecrets(h.title),
    owns: h.owns,
    fast_check: h.fastCheck === null ? null : scrubSecrets(h.fastCheck),
    body: capBody(scrubSecrets(body)),
  };
}

/** Fenced code becomes "[code omitted]"; a fence left open runs to the end of the text, as Markdown renders it. */
const dropFences = (text: string): string =>
  text.replace(/^(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?^\1[^\n]*$|[\s\S]*$)/gm, "[code omitted]");

/** Capped at BODY_MAX characters, never ending the cut on half a surrogate pair. */
const capBody = (text: string): string =>
  text.length > BODY_MAX ? `${text.slice(0, BODY_MAX).replace(/[\uD800-\uDBFF]$/, "")}…` : text;

/** Free text sent to Jev (a finding, a defect): no fenced code, no secrets, capped like a lane's body. */
export function scrubFree(text: string): string {
  return capBody(scrubSecrets(dropFences(text).trim()));
}

const Prob = z.record(z.string(), z.number().min(0).max(1));
const AnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities: Prob, confidence: z.number() }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    probabilities: Prob,
    confidence: z.number(),
  }),
  z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
]);
export type JevAnswer = z.infer<typeof AnswerSchema>;
export type JevAnswers = Record<string, JevAnswer>;

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
      answers: JevAnswers;
    }
  | { ok: false; error: string };

/** Every question answered, each in its own type and within its options, or an error naming the first. */
export function parseReply(questions: Record<string, JevQuestion>, body: unknown): ParsedReply {
  const r = ReplySchema.safeParse(body);
  if (!r.success) return { ok: false, error: "unexpected response" };
  const answers: JevAnswers = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = AnswerSchema.safeParse(r.data.answers[id]);
    if (!a.success || a.data.type !== q.type) return { ok: false, error: `no valid answer to ${id}` };
    if (a.data.type === "choice" && q.type === "choice" && !Object.hasOwn(q.criteria, a.data.choice))
      return { ok: false, error: `no valid answer to ${id}` };
    if (
      a.data.type === "score" &&
      q.type === "score" &&
      Object.keys(a.data.probabilities).some((l) => !/^\d+$/.test(l) || Number(l) >= q.criteria.length)
    )
      return { ok: false, error: `no valid answer to ${id}` };
    answers[id] = a.data;
  }
  return { ok: true, model: r.data.model, usage: r.data.usage ?? null, answers };
}

const pOf = (a: JevAnswer | undefined, option: string): number =>
  a && a.type !== "noul" ? (a.probabilities[option] ?? 0) : 0;

export interface RouteJudgement {
  /** the kind, when p_max ≥ kindMin and it is one of catherd's kinds */
  kind: Kind | null;
  pKind: number | null;
  /** "A" (copy/build) or "B" (logic/hard) on summed probabilities, null in the dead band */
  track: "A" | "B" | null;
  difficulty: Difficulty | null;
  pA: number | null;
  pB: number | null;
  /** the atomic questions, logged for calibration only */
  nouls: Record<string, number>;
  rule: string;
}

/**
 * Spec §5.5's decision rule. Confidence is `(n·p_max − 1)/(n − 1)`, so it means different things for
 * different option counts; the rule reads probabilities instead: the kind at p_max ≥ kindMin, the track
 * when the summed probability of its levels reaches trackMin, and neither in between (the dead band).
 */
export function judgeRoute(rule: RouteRule, answers: JevAnswers): RouteJudgement {
  const k = answers.kind;
  const d = answers.difficulty;
  const nouls: Record<string, number> = {};
  for (const [id, a] of Object.entries(answers)) if (a.type === "noul") nouls[id] = a.noul;
  let kind: Kind | null = null;
  let pKind: number | null = null;
  if (k && k.type === "choice") {
    const [top, p] = Object.entries(k.probabilities).reduce((m, e) => (e[1] > m[1] ? e : m), ["", -1]);
    pKind = p < 0 ? null : p;
    if (p >= rule.kindMin && (KINDS as readonly string[]).includes(top)) kind = top as Kind;
  }
  if (!d || d.type !== "score")
    return { kind, pKind, track: null, difficulty: null, pA: null, pB: null, nouls, rule: "no difficulty" };
  // Rounded before comparing: 0.1 + 0.7 is 0.7999999999999999 in floating point, and must reach 0.8.
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  const sum = (levels: string[]) => round(levels.reduce((s, l) => s + pOf(d, l), 0));
  const pA = sum(rule.trackA);
  const pB = sum(rule.trackB);
  if (pA >= rule.trackMin)
    return {
      kind,
      pKind,
      track: "A",
      difficulty: pOf(d, rule.trackA[0] ?? "") > pOf(d, rule.trackA[1] ?? "") ? "copy" : "build",
      pA,
      pB,
      nouls,
      rule: `P(A) ${pA} ≥ ${rule.trackMin}`,
    };
  if (pB >= rule.trackMin)
    return {
      kind,
      pKind,
      track: "B",
      difficulty: pOf(d, rule.trackB[1] ?? "") > pOf(d, rule.trackB[0] ?? "") ? "hard" : "logic",
      pA,
      pB,
      nouls,
      rule: `P(B) ${pB} ≥ ${rule.trackMin}`,
    };
  return {
    kind,
    pKind,
    track: null,
    difficulty: null,
    pA,
    pB,
    nouls,
    rule: `P(A) ${pA}, P(B) ${pB}: both below ${rule.trackMin}`,
  };
}

export interface Verdict<T extends string> {
  value: T;
  /** the chosen answer's probability, when Jev answered */
  probability: number | null;
  /** Jev's own confidence statistic, when it answered */
  confidence: number | null;
  source: "jev" | "default";
}

/** Spec §5.5: `finding` and `same-defect` keep their 0.x meaning, with thresholds on probability. */
export function judgeVerdict<T extends string>(
  rule: VerdictRule,
  id: string,
  options: readonly T[],
  answers: JevAnswers | null,
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
    source: sure ? "jev" : "default",
  };
}
