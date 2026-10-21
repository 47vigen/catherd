import { z } from "zod";
import { BLOCKED_LINE } from "./blocked.ts";

export const JUDGE_KINDS = ["triage", "question", "unexpected"] as const;
export type JudgeKind = (typeof JUDGE_KINDS)[number];

/** What a judge call is given: its kind, the unit it is about, a context text and the numbered findings. */
export interface JudgeInput {
  id: string;
  kind: JudgeKind;
  unit: string;
  context: string;
  findings: string[];
  lanes: { id: string; owns: string[] }[];
}

const why = z.string();
export const JudgeDecisionSchema = z.discriminatedUnion("verb", [
  z.object({
    verb: z.literal("route"),
    routes: z.array(z.object({ finding: z.number().int().min(1), to: z.string(), why })),
  }),
  z.object({ verb: z.literal("answer"), answer: z.string() }),
  z.object({ verb: z.literal("ask_owner"), question: z.string() }),
  z.object({ verb: z.literal("park"), question: z.string() }),
  z.object({ verb: z.literal("retry"), why }),
  z.object({ verb: z.literal("climb"), why }),
  z.object({ verb: z.literal("skip"), why }),
]);
export type JudgeDecision = z.infer<typeof JudgeDecisionSchema>;

export const judgeName = (id: string): string => `judge-${id}`;

/** The judge's reply contract, appended to every judge brief (spec 2.0 decision 3). */
export const JUDGE_CONTRACT = [
  "Your first line is DECISION: <verb>, one of the verbs your brief lists. Then, by verb:",
  "- route: one line per finding, ROUTE <n> -> <lane id>|architect|dismiss — <why>",
  "- answer: ANSWER: <the answer the worker needs, from the plan and the code>",
  "- ask_owner or park: QUESTION: <one question only the owner can answer>",
  "- retry, climb or skip: WHY: <one line>",
  `Decide only from what the brief and the run's files show. The last line of your reply is: STATUS: complete — <one line why>. ${BLOCKED_LINE}`,
].join("\n");

/** The verbs each kind of call may answer with. */
export const JUDGE_VERBS: Record<JudgeKind, readonly JudgeDecision["verb"][]> = {
  triage: ["route"],
  question: ["answer", "ask_owner"],
  unexpected: ["retry", "climb", "skip", "park"],
};

/** A line without the emphasis a model puts around it (`**DECISION: retry**`, backticks). */
const plain = (l: string): string => l.trim().replace(/^[*_`\s]+|[*_`\s]+$/g, "");
const STATUS = /^STATUS:\s*(complete|partial|blocked|refused|flaky)\b/i;
const ROUTE = /^[-*\s]*ROUTE\s+(\d+)\s*(?:->|→)\s*(\S+)\s*(?:—|–|-|:)?\s*(.*)$/;

/** The text after `label:` on its line and the lines under it, up to the STATUS line. */
function section(lines: string[], label: string): string | null {
  const at = lines.findIndex((l) => new RegExp(`^${label}:`, "i").test(plain(l)));
  if (at < 0) return null;
  const rest = [plain(lines[at] as string).slice(label.length + 1)];
  for (const l of lines.slice(at + 1)) {
    if (STATUS.test(plain(l))) break;
    rest.push(l.trim());
  }
  return rest.join("\n").trim();
}

/** The judge's decision, or null when the reply is not one its kind allows (the daemon asks once more). */
export function parseJudgeReply(reply: string, kind: JudgeKind): JudgeDecision | null {
  const lines = reply.split("\n");
  const first = lines.map(plain).find(Boolean) ?? "";
  const verb = /^DECISION:\s*(\w+)\s*$/i.exec(first)?.[1]?.toLowerCase();
  if (!verb || !(JUDGE_VERBS[kind] as readonly string[]).includes(verb)) return null;
  const decision = ((): unknown => {
    switch (verb) {
      case "route": {
        const routes = lines.flatMap((l) => {
          const m = ROUTE.exec(plain(l));
          return m ? [{ finding: Number(m[1]), to: m[2] as string, why: (m[3] ?? "").trim() }] : [];
        });
        return routes.length ? { verb, routes } : null;
      }
      case "answer": {
        const answer = section(lines, "ANSWER");
        return answer ? { verb, answer } : null;
      }
      case "ask_owner":
      case "park": {
        const question = section(lines, "QUESTION");
        return question ? { verb, question } : null;
      }
      default:
        return { verb, why: section(lines, "WHY") ?? "" };
    }
  })();
  const parsed = JudgeDecisionSchema.safeParse(decision);
  return parsed.success ? parsed.data : null;
}
