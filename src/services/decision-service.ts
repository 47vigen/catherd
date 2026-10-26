import { join } from "node:path";
import {
  canonicalJson,
  type DecisionAnswers,
  type DecisionFile,
  DecisionFileSchema,
  decisionState,
  difficultyQuestions,
  parseReply,
  type DecisionQuestion,
  requestKey,
  sha256,
} from "../domain/decision.ts";
import { assetPath } from "../infra/assets.ts";
import { type DecisionTransport, decisionRequest } from "../infra/decision-client.ts";
import { addSecret, log } from "../infra/log.ts";
import { appendJsonl, ensureJsonlHeader, readJsonl, readVersioned } from "../infra/store.ts";
import { saveCredential, savedCredential } from "./credentials.ts";

// Plan 44 Part A: the decision model's service (askJev's logic over the profile's url and model).

export const DECISION_KEY_ENV = "CATHERD_DECISION_KEY";

/** `CATHERD_DECISION_KEY`, else credentials.json `decisionKey`; null sends no `Authorization` (D26). */
export function decisionKey(): string | null {
  const env = process.env[DECISION_KEY_ENV]?.trim();
  if (env) return env;
  const { key, problem } = savedCredential("decisionKey");
  if (problem) log("warn", "decision", { error: `no key: ${problem.message}` });
  return key;
}

export const saveDecisionKey = (key: string): void => saveCredential("decisionKey", key);

let file: DecisionFile | null = null;
/** catalog/decision.json: the level texts and question sets. */
export const decisionQuestions = (): DecisionFile =>
  (file ??= readVersioned(assetPath("catalog/decision.json"), DecisionFileSchema, 1));

export interface DecisionConfig {
  url: string;
  model: string;
  minConfidence: number;
}

/** One decisions.jsonl row (D28): never the state, only its hash; a caller adds its own fields. */
export type DecisionRow = {
  call: string;
  key: string;
  stateHash: string;
  model: string | null;
  requestId: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  latencyMs: number | null;
  attempts: number;
  answers: DecisionAnswers | null;
};

export interface Asked {
  answers: DecisionAnswers | null;
  /** why the model gave no answers ("http 401", "unexpected response", …) */
  why: string | null;
  meta: Omit<DecisionRow, "call" | "answers"> & { cached: boolean };
}

export type AskOpts = DecisionTransport & {
  /** a key to use instead of decisionKey(); null means none */
  key?: string | null;
};

const decisionLog = (runDir: string) => join(runDir, "decisions.jsonl");

export function logDecision(runDir: string, row: DecisionRow & Record<string, unknown>): void {
  const f = decisionLog(runDir);
  ensureJsonlHeader(f, "decisions");
  appendJsonl(f, { at: new Date().toISOString(), ...row });
}

/**
 * Asks `questions` about `state` of the profile's model at its url. A request this run already had
 * answered (same model, state and questions) is answered from decisions.jsonl; with no `runDir` nothing is
 * read or logged.
 */
export async function askDecision(
  runDir: string | null,
  cfg: DecisionConfig,
  call: string,
  state: unknown,
  questions: Record<string, DecisionQuestion>,
  o: AskOpts = {},
): Promise<Asked> {
  const key = requestKey(cfg.model, state, questions);
  const meta: Asked["meta"] = {
    key,
    stateHash: sha256(canonicalJson(state)),
    model: null,
    requestId: null,
    usage: null,
    latencyMs: null,
    attempts: 0,
    cached: false,
  };
  if (runDir)
    // a logged answer is checked like a fresh one: a row edited by hand, or cut short, is asked again
    for (const hit of readJsonl<Partial<DecisionRow>>(decisionLog(runDir)).rows) {
      if (hit.key !== key || !hit.answers) continue;
      const cached = parseReply(questions, { model: hit.model ?? "", answers: hit.answers });
      if (cached.ok)
        return {
          answers: cached.answers,
          why: null,
          meta: { ...meta, model: hit.model ?? null, cached: true },
        };
    }
  const apiKey = o.key === undefined ? decisionKey() : o.key;
  if (apiKey) addSecret(apiKey);
  const res = await decisionRequest(
    cfg.url,
    "POST",
    "/systemone",
    apiKey,
    { model: cfg.model, state, questions },
    o,
  );
  log(res.ok ? "info" : "warn", "decision", {
    call,
    stateHash: meta.stateHash,
    requestId: res.ok ? res.requestId : null,
    latencyMs: res.latencyMs,
    attempts: res.attempts,
    ...(res.ok ? {} : { error: res.error }),
  });
  meta.latencyMs = res.latencyMs;
  meta.attempts = res.attempts;
  if (!res.ok) return { answers: null, why: res.error, meta };
  meta.requestId = res.requestId;
  const parsed = parseReply(questions, res.body);
  if (!parsed.ok) return { answers: null, why: parsed.error, meta };
  meta.model = parsed.model;
  meta.usage = parsed.usage;
  if (runDir) logDecision(runDir, { call, ...meta, cached: undefined, answers: parsed.answers });
  return { answers: parsed.answers, why: null, meta };
}

/** D27: one fixed request (a worker, three rungs, a short brief); ok when the answer parses. */
export async function probeDecision(
  cfg: DecisionConfig,
  o: AskOpts = {},
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const state = decisionState({
    role: "worker",
    unit: "probe",
    round: 0,
    isFix: false,
    floorRung: null,
    rungs: [
      { level: 0, rung: "probe:a", intelligence: 30 },
      { level: 1, rung: "probe:b", intelligence: 40 },
      { level: 2, rung: "probe:c", intelligence: 50 },
    ],
    previous: [],
    spentFraction: 0,
    slack: null,
    brief: "Rename the function total to sum in src/math.ts and update its callers. Run the unit tests.",
  });
  const a = await askDecision(
    null,
    cfg,
    "probe",
    state,
    difficultyQuestions(decisionQuestions(), "worker", 3),
    o,
  );
  return a.answers
    ? { ok: true, latencyMs: a.meta.latencyMs ?? 0 }
    : { ok: false, error: a.why ?? "no answer" };
}
