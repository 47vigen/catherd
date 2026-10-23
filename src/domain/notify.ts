import type { ParkReason } from "./run-events.ts";
import type { NotifyMoment } from "./profile.ts";

export interface NotifyMessage {
  title: string;
  message: string;
  tags: string[];
  click?: string;
  priority?: number;
}

export const QUESTION_EXCERPT = 120;

/** The run's notice, with enough context for the owner to answer a parked question. */
export function notifyMessage(i: {
  runId: string;
  runTitle: string;
  unit: string;
  moment: NotifyMoment;
  reason?: ParkReason;
  question?: string;
  outcome?: string;
  panelUrl?: string | null;
}): NotifyMessage {
  const title = `catherd · ${i.runTitle}`;
  switch (i.moment) {
    case "blocked": {
      const question = (i.question ?? `${i.unit} needs your answer.`)
        .replace(/```[^\n]*\n?|```/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const excerpt =
        question.length > QUESTION_EXCERPT ? `${question.slice(0, QUESTION_EXCERPT)}…` : question;
      return {
        title: i.reason ? `catherd · ${i.reason} · ${i.runTitle}` : title,
        message: `${excerpt} — answer: catherd answer ${i.runId} ${i.unit} "<answer>"`,
        tags: ["question"],
        ...(i.panelUrl ? { click: `${i.panelUrl}/questions` } : {}),
        ...(["blocker", "environment", "land"].includes(i.reason ?? "") ? { priority: 4 } : {}),
      };
    }
    case "milestone":
      return { title, message: `${i.unit} landed.`, tags: ["white_check_mark"] };
    case "finish":
      return {
        title,
        message: `The run ${!i.outcome || i.outcome === "done" ? "finished" : i.outcome === "cancelled" ? "was cancelled" : i.outcome}: catherd status ${i.runId}`,
        tags: ["checkered_flag"],
      };
  }
}
