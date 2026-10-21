import type { NotifyMoment } from "./profile.ts";

export interface NotifyMessage {
  title: string;
  message: string;
  tags: string[];
}

/**
 * The phone message of a moment (spec 2.0): the run, the unit and the command that answers it, nothing else.
 * Never the question's text, never code or secrets: the owner opens catherd to read it.
 */
export function notifyMessage(i: {
  runId: string;
  runTitle: string;
  unit: string;
  moment: NotifyMoment;
}): NotifyMessage {
  const title = `catherd · ${i.runTitle}`;
  switch (i.moment) {
    case "blocked":
      return {
        title,
        message: `${i.unit} needs your answer. Answer: catherd answer ${i.runId} ${i.unit} "<your answer>"`,
        tags: ["question"],
      };
    case "milestone":
      return { title, message: `${i.unit} landed.`, tags: ["white_check_mark"] };
    case "finish":
      return { title, message: `The run finished: catherd status ${i.runId}`, tags: ["checkered_flag"] };
  }
}
