import { join } from "node:path";
import { CatherdError } from "../domain/errors.ts";
import { assertId } from "../domain/ids.ts";
import { appendJsonl, ensureJsonlHeader, readJsonl } from "../infra/store.ts";
import type { Deps } from "./ports.ts";
import { findRun, type Run } from "./run-store.ts";
import { type Notes, refreshState } from "./state.ts";

// Spec 1.1 §8: an owner question parks its milestone instead of stopping the run.

interface QuestionRow {
  at: string;
  milestone: string;
  kind: "question" | "answer";
  text: string;
}

export interface OpenQuestion {
  milestone: string;
  question: string;
  at: string;
}

const questionsFile = (run: Run): string => join(run.dir, "questions.jsonl");

const rows = (run: Run): QuestionRow[] =>
  readJsonl<QuestionRow>(questionsFile(run)).rows.filter(
    (r) => typeof r?.milestone === "string" && typeof r.text === "string",
  );

/** The questions not answered yet, oldest first; a milestone answered after its question is no longer open. */
export function openQuestions(run: Run): OpenQuestion[] {
  const open = new Map<string, OpenQuestion>();
  for (const r of rows(run)) {
    if (r.kind === "question") open.set(r.milestone, { milestone: r.milestone, question: r.text, at: r.at });
    else open.delete(r.milestone);
  }
  return [...open.values()];
}

function append(run: Run, row: QuestionRow): void {
  const file = questionsFile(run);
  ensureJsonlHeader(file, "questions");
  appendJsonl(file, row);
}

/** `park`: the milestone waits on the owner; the rest of the run goes on. */
export async function park(
  deps: Deps,
  i: { run: string; milestone: string; question: string },
): Promise<{ parked: string[]; hints: string[] }> {
  const run = findRun(i.run);
  assertId("milestone", i.milestone);
  append(run, {
    at: new Date(deps.now()).toISOString(),
    milestone: i.milestone,
    kind: "question",
    text: i.question,
  });
  let parked: string[] = [];
  const { hints } = await refreshState(run, (n: Notes) => {
    parked = [...new Set([...(n.parked ?? []), i.milestone])];
    return { parked };
  });
  return {
    parked,
    hints: [
      `push the full question to the owner now (PushNotification): ${i.milestone}: ${i.question}`,
      `continue with the milestones and runs that do not depend on ${i.milestone}; when the owner answers, call answer(run, "${i.milestone}", <their answer>)`,
      ...hints,
    ],
  };
}

/** `answer`: records the owner's answer and unparks the milestone. */
export async function answer(
  deps: Deps,
  i: { run: string; milestone: string; answer: string },
): Promise<{ milestone: string; parked: string[]; hints?: string[] }> {
  const run = findRun(i.run);
  assertId("milestone", i.milestone);
  if (!openQuestions(run).some((q) => q.milestone === i.milestone))
    throw new CatherdError("E_INPUT_INVALID", `${i.milestone} has no open question`, {
      fix: "status(run) lists the open questions; park(run, milestone, question) opens one",
    });
  append(run, {
    at: new Date(deps.now()).toISOString(),
    milestone: i.milestone,
    kind: "answer",
    text: i.answer,
  });
  let parked: string[] = [];
  const { hints } = await refreshState(run, (n: Notes) => {
    parked = (n.parked ?? []).filter((m) => m !== i.milestone);
    return { parked, next: `${i.milestone}: the owner answered; continue it` };
  });
  return { milestone: i.milestone, parked, ...(hints.length ? { hints } : {}) };
}
