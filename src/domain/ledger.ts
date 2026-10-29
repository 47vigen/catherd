import { z } from "zod";
import { CatherdError } from "./errors.ts";
import { ID_PATTERN } from "./ids.ts";

/**
 * Spec D2: the architect's ledger, a small task list it owns. The architect writes `goal`, `depends`, `oracle` and
 * `state`; catherd derives `assignee` and `attempts` from the dispatches that worked a task. Pure.
 */
export const LEDGER_STATES = ["todo", "running", "review", "done", "blocked", "impossible"] as const;
export type LedgerState = (typeof LEDGER_STATES)[number];

/** A task as the architect wrote it: one `ledger_tasks` row's body. */
export interface LedgerTask {
  id: string;
  goal: string;
  state: LedgerState;
  depends: string[];
  oracle: string[];
}

/** One dispatch that worked a ledger task, as the run's events tell it. */
export interface TaskAttempt {
  taskId: string;
  ledgerTask: string | null;
  rung: string;
  working: boolean;
  /** `status/replyStatus` once it ended, else null */
  outcome: string | null;
}

/** A task as `ledger/tasks.json` shows it. `blocks` holds stall fingerprints (spec D10, plan 48). */
export interface LedgerView extends LedgerTask {
  assignee: string | null;
  attempts: { taskId: string; rung: string; outcome: string | null }[];
  blocks: string[];
}

const id = z.string().regex(ID_PATTERN, "an id like L1 or auth-1");
/** A path or pathspec inside the tree: not absolute (either OS), no `..` segment. */
const oraclePath = z
  .string()
  .min(1)
  .refine((p) => !/^([/\\]|[A-Za-z]:)/.test(p) && !p.split(/[/\\]/).includes(".."), {
    message: "a path inside the tree: not absolute, no ..",
  });
const paths = z.array(oraclePath);

export const LedgerPatchSchema = z.strictObject({
  add: z
    .array(
      z.strictObject({
        id,
        goal: z.string().min(1),
        depends: z.array(id).optional(),
        oracle: paths.optional(),
      }),
    )
    .optional(),
  set: z
    .array(
      z.strictObject({
        id,
        goal: z.string().min(1).optional(),
        depends: z.array(id).optional(),
        oracle: paths.optional(),
        state: z.enum(LEDGER_STATES).optional(),
      }),
    )
    .optional(),
  remove: z.array(id).optional(),
});
export type LedgerPatch = z.infer<typeof LedgerPatchSchema>;

const invalid = (message: string): CatherdError =>
  new CatherdError("E_INPUT_INVALID", message, { fix: "read ledger/tasks.json and patch the ids it holds" });

/** The task list after `patch`: removes, then adds (state `todo`), then sets; every `depends` must name a task. */
export function applyLedgerPatch(tasks: readonly LedgerTask[], patch: LedgerPatch): LedgerTask[] {
  const out = new Map(tasks.map((t) => [t.id, structuredClone(t)]));
  for (const r of patch.remove ?? []) if (!out.delete(r)) throw invalid(`the ledger has no task ${r}`);
  for (const a of patch.add ?? []) {
    if (out.has(a.id)) throw invalid(`the ledger already has a task ${a.id}`);
    out.set(a.id, {
      id: a.id,
      goal: a.goal,
      state: "todo",
      depends: a.depends ?? [],
      oracle: a.oracle ?? [],
    });
  }
  for (const s of patch.set ?? []) {
    const t = out.get(s.id);
    if (!t) throw invalid(`the ledger has no task ${s.id}`);
    if (s.goal !== undefined) t.goal = s.goal;
    if (s.depends !== undefined) t.depends = s.depends;
    if (s.oracle !== undefined) t.oracle = s.oracle;
    if (s.state !== undefined) t.state = s.state;
  }
  for (const t of out.values())
    for (const d of t.depends)
      if (!out.has(d)) throw invalid(`${t.id} depends on ${d}, which the ledger lacks`);
  return [...out.values()];
}

/** The architect's word on these states stands; any other state follows the task's dispatches. */
const FINAL: readonly LedgerState[] = ["done", "blocked", "impossible"];

/** Each task with its assignee and attempts; `running` while one works it, `review` after one completed it. */
export function ledgerView(tasks: readonly LedgerTask[], attempts: readonly TaskAttempt[]): LedgerView[] {
  return tasks.map((t) => {
    const mine = attempts.filter((a) => a.ledgerTask === t.id);
    const live = mine.find((a) => a.working);
    const last = mine.at(-1);
    const state: LedgerState = FINAL.includes(t.state)
      ? t.state
      : live
        ? "running"
        : last?.outcome === "ok/complete"
          ? "review"
          : t.state;
    return {
      ...t,
      state,
      assignee: live?.taskId ?? null,
      attempts: mine.map((a) => ({ taskId: a.taskId, rung: a.rung, outcome: a.outcome })),
      blocks: [],
    };
  });
}

/** Spec D2: `progress.md` shows the last 40 entries; older ones go to `progress-archive.md`. */
export const PROGRESS_SHOWN = 40;

/** The two progress files' text, oldest first; an entry is `## <at>` and its text. */
export function renderProgress(entries: readonly { at: string; text: string }[]): {
  shown: string;
  archive: string;
} {
  const block = (e: { at: string; text: string }) => `## ${e.at}\n\n${e.text.trim()}\n`;
  const cut = Math.max(0, entries.length - PROGRESS_SHOWN);
  return {
    shown: `# Progress\n\n${entries.slice(cut).map(block).join("\n")}`,
    archive: `# Progress, archived\n\n${entries.slice(0, cut).map(block).join("\n")}`,
  };
}
