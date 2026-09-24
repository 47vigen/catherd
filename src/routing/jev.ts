import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFetch } from "ofetch";
import { z } from "zod";
import { appendJsonl } from "../core/runstore.ts";
import { configDir } from "../paths.ts";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";

export interface JevQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export type JevQuestions = Record<string, JevQuestion>;
export interface JevAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export type JevAnswers = Record<string, JevAnswer>;
export interface JevOpts {
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
}
export interface JevLogRow {
  ts: string;
  questions: string[];
  answers: JevAnswers | null;
  used: string;
  source: "jev" | "default";
  why: string;
}

// Versioned with JEV_MODEL. difficulty, finding and same-defect are verbatim from the
// codex-orchestration jev.sh that ran on 2026-09-23/24; kind is new, and the recorded fixtures used it.
export const QUESTIONS = {
  kind: {
    type: "choice",
    instructions: "What kind of work does the lane in the state describe?",
    criteria: {
      repo_code: "Code and tests inside an application or library repository",
      terminal: "Shell, build, CI, infrastructure or environment work, where the terminal is the main tool",
      ui: "User-interface work judged on screen: layout, styling, components",
      prose: "Writing that is not code: docs, a changelog, release notes, a merge request body",
      research: "Finding facts to answer a question, with no change to the product",
    },
  },
  difficulty: {
    type: "choice",
    instructions: "How hard is the work described in the state for a coding agent?",
    criteria: {
      copy: "Mechanical: rename, move, copy an existing pattern verbatim",
      build: "New code that follows an existing pattern in the repo",
      logic: "Non-trivial logic: state, concurrency, data invariants, edge cases",
      hard: "Unclear cause, cross-system design, or no pattern to follow",
    },
  },
  finding: {
    type: "choice",
    instructions: "A reviewer reported `finding` on the work planned in `lane`. Where is the defect?",
    criteria: {
      design: "The plan itself is wrong: its decisions, signatures or data shapes cannot meet the goal",
      code: "The plan is sound and the code does not implement it correctly",
      unclear: "The finding does not say enough to tell",
    },
  },
  "same-defect": {
    type: "choice",
    instructions:
      "Does `after` report the same underlying defect as `before`, even if worded differently or at another line?",
    criteria: { yes: "Same underlying defect", no: "A different defect" },
  },
} satisfies JevQuestions;

const RETRY_CODES = [429, ...Array.from({ length: 100 }, (_, i) => 500 + i)];

const Reply = z.object({
  answers: z.record(
    z.string(),
    z.object({
      choice: z.string(),
      confidence: z.number(),
      probabilities: z.record(z.string(), z.number()).default(() => ({})),
    }),
  ),
});

const credentialsFile = () => join(configDir(), "credentials.json");

export function jevKey(): string | null {
  const env = process.env.TYPESAFE_API_KEY?.trim();
  if (env) return env;
  if (!existsSync(credentialsFile())) return null;
  try {
    const k: unknown = JSON.parse(readFileSync(credentialsFile(), "utf8")).typesafeApiKey;
    return typeof k === "string" && k.trim() ? k.trim() : null;
  } catch {
    return null;
  }
}

export function saveJevKey(key: string): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(credentialsFile(), `${JSON.stringify({ typesafeApiKey: key.trim() }, null, 2)}\n`, {
    mode: 0o600,
  });
  // writeFileSync's mode applies only when it creates the file.
  chmodSync(credentialsFile(), 0o600);
}

export async function callJev(
  q: JevQuestions,
  state: Record<string, string>,
  o: JevOpts & { key?: string | null } = {},
): Promise<{ answers: JevAnswers | null; error: string | null }> {
  const key = o.key === undefined ? jevKey() : o.key;
  if (!key) return { answers: null, error: "no key" };
  const base = o.retryDelayMs ?? 1000;
  let raw: unknown;
  try {
    raw = await createFetch({ fetch: o.fetchImpl ?? globalThis.fetch })(JEV_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: { model: JEV_MODEL, state, questions: q },
      retry: 3,
      retryDelay: (ctx) => base * (4 - Number(ctx.options.retry)),
      retryStatusCodes: RETRY_CODES,
      timeout: 30_000,
    });
  } catch (e) {
    const status = (e as { status?: number }).status;
    return { answers: null, error: status ? `http ${status}` : "network error" };
  }
  const parsed = Reply.safeParse(raw);
  if (!parsed.success) return { answers: null, error: "unexpected response" };
  const answers: JevAnswers = {};
  for (const [id, question] of Object.entries(q)) {
    const a = parsed.data.answers[id];
    if (!a || !Object.hasOwn(question.criteria, a.choice))
      return { answers: null, error: `no valid answer to ${id}` };
    answers[id] = a;
  }
  return { answers, error: null };
}

export function logJev(runDir: string, row: Omit<JevLogRow, "ts">): void {
  appendJsonl(join(runDir, "jev.jsonl"), { ts: new Date().toISOString(), ...row });
}

export async function askJev(
  q: JevQuestions,
  state: Record<string, string>,
  o: JevOpts & { runDir?: string } = {},
): Promise<JevAnswers | null> {
  const { answers, error } = await callJev(q, state, o);
  if (o.runDir) {
    logJev(o.runDir, {
      questions: Object.keys(q),
      answers,
      used: answers
        ? Object.entries(answers)
            .map(([id, a]) => `${id}=${a.choice}`)
            .join(" ")
        : "none",
      source: answers ? "jev" : "default",
      why: error ?? "raw answers, no threshold applied",
    });
  }
  return answers;
}

export async function testJevKey(key: string, o: JevOpts = {}): Promise<boolean> {
  const { answers } = await callJev(
    { difficulty: QUESTIONS.difficulty },
    { lane: "Rename the variable total to sum in src/cart.ts." },
    { ...o, key },
  );
  return answers !== null;
}
