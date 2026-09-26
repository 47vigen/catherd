import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  canonicalJson,
  type JevAnswers,
  type JevFile,
  JevFileSchema,
  parseReply,
  questionSetId,
  requestKey,
  type SetName,
  sha256,
} from "../domain/jev.ts";
import { assetPath } from "../infra/assets.ts";
import { type JevTransport, jevRequest } from "../infra/jev-client.ts";
import { configDir } from "../infra/paths.ts";
import { appendJsonl, ensureJsonlHeader, readJsonl, readVersioned, writeJsonAtomic } from "../infra/store.ts";

let file: JevFile | null = null;
/** catalog/jev.json: the question sets and their rules (spec §5.5). */
export const jevQuestions = (): JevFile =>
  (file ??= readVersioned(assetPath("catalog/jev.json"), JevFileSchema, 1));

export const credentialsPath = (): string => join(configDir(), "credentials.json");
const CredentialsSchema = z.looseObject({
  schema: z.literal(1).default(1),
  typesafeApiKey: z.string().optional(),
});

/** Spec §5.5: `TYPESAFE_API_KEY`, else `<config>/credentials.json`; null when neither has one. */
export function jevKey(): string | null {
  const env = process.env.TYPESAFE_API_KEY?.trim();
  if (env) return env;
  if (!existsSync(credentialsPath())) return null;
  try {
    return readVersioned(credentialsPath(), CredentialsSchema, 1).typesafeApiKey?.trim() || null;
  } catch {
    return null;
  }
}

/** Keeps any other credential, and the file at mode 600 (spec §10.4). */
export function saveJevKey(key: string): void {
  let cur: z.infer<typeof CredentialsSchema> = { schema: 1 };
  try {
    if (existsSync(credentialsPath())) cur = readVersioned(credentialsPath(), CredentialsSchema, 1);
  } catch {}
  writeJsonAtomic(credentialsPath(), { ...cur, schema: 1, typesafeApiKey: key.trim() }, { mode: 0o600 });
}

/** A key works when Jev lists its models: no inference, and no dependence on a question set. */
export async function testJevKey(key: string, o: JevTransport = {}): Promise<boolean> {
  return (await jevRequest("GET", "/models", key, undefined, o)).ok;
}

export interface JevOpts extends JevTransport {
  /** a key to use instead of jevKey(); null means none */
  key?: string | null;
}

/** One jev.jsonl row (spec §5.5): never the state, only its hash. */
export interface JevRow {
  at: string;
  call: SetName;
  lane: string | null;
  questionSet: string;
  key: string;
  stateHash: string;
  model: string | null;
  requestId: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  latencyMs: number | null;
  attempts: number;
  cached: boolean;
  answers: JevAnswers | null;
  derived: Record<string, unknown> | null;
  used: string;
  source: "jev" | "lane" | "default";
  why: string;
}

export interface Asked {
  answers: JevAnswers | null;
  /** why Jev gave no answers ("no key", "http 401", …), or a note on answers from an unpinned model */
  why: string | null;
  meta: Omit<JevRow, "at" | "answers" | "derived" | "used" | "source" | "why" | "call" | "lane">;
}

const jevLog = (runDir: string) => join(runDir, "jev.jsonl");

export function logJev(runDir: string, row: Omit<JevRow, "at">, now = Date.now()): void {
  const f = jevLog(runDir);
  ensureJsonlHeader(f, "jev");
  appendJsonl(f, { at: new Date(now).toISOString(), ...row });
}

/**
 * Asks one question set about `state`. A request this run already had answered (same model, state and
 * questions) is answered from jev.jsonl, so a re-routed lane gets the same decision.
 */
export async function askJev(runDir: string, set: SetName, state: unknown, o: JevOpts = {}): Promise<Asked> {
  const f = jevQuestions();
  const questions = f.sets[set].questions;
  const key = requestKey(f.model, state, questions);
  const meta: Asked["meta"] = {
    questionSet: questionSetId(f, set),
    key,
    stateHash: sha256(canonicalJson(state)),
    model: null,
    requestId: null,
    usage: null,
    latencyMs: null,
    attempts: 0,
    cached: false,
  };
  const hit = readJsonl<Partial<JevRow>>(jevLog(runDir)).rows.find((r) => r.key === key && r.answers);
  if (hit?.answers)
    return { answers: hit.answers, why: null, meta: { ...meta, model: hit.model ?? null, cached: true } };
  const apiKey = o.key === undefined ? jevKey() : o.key;
  if (!apiKey) return { answers: null, why: "no key", meta };
  const res = await jevRequest("POST", "/systemone", apiKey, { model: f.model, state, questions }, o);
  meta.latencyMs = res.latencyMs;
  meta.attempts = res.attempts;
  if (!res.ok) return { answers: null, why: res.error, meta };
  meta.requestId = res.requestId;
  const parsed = parseReply(questions, res.body);
  if (!parsed.ok) return { answers: null, why: parsed.error, meta };
  meta.model = parsed.model;
  meta.usage = parsed.usage;
  const drift = parsed.model === f.model ? null : `answered by ${parsed.model}, not the pinned ${f.model}`;
  return { answers: parsed.answers, why: drift, meta };
}
