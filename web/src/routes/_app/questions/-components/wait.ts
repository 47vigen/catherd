import type { QuestionView } from "../../../../client";

/** How long a question has waited, and how loud that should look: a wait that holds a run back gets warmer. */
export function waited(at: string, now: Date): { minutes: number; tone: string } {
  const minutes = Math.max(0, (now.getTime() - Date.parse(at)) / 60_000);
  return { minutes, tone: minutes >= 60 ? "text-danger" : minutes >= 15 ? "text-warning" : "text-muted" };
}

export const reasonLabel = (r: QuestionView["reason"]) => (r === "needs_user" ? "needs you" : r.replaceAll("_", " "));

/** The list key of a question: a run has at most one open question per unit. */
export const keyOf = (q: Pick<QuestionView, "run" | "unit">) => `${q.run}/${q.unit}`;
