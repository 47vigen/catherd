import { relative } from "node:path";
import { z } from "zod";
import { errorMessage, isCatherdError } from "../domain/errors.ts";
import { overlaps } from "../domain/lane.ts";
import { renderState, withParked } from "../domain/state.ts";
import { dispatchPaths } from "../infra/dispatch-dir.ts";
import { withFileLock } from "../infra/filelock.ts";
import { gitHead, statusSnapshot } from "../infra/git.ts";
import { readVersioned, writeJsonAtomic, writeTextAtomic } from "../infra/store.ts";
import { liveDispatches } from "./dispatches.ts";
import { protocolNext } from "./protocol.ts";
import { type Run, runPaths } from "./run-store.ts";

/** state.json: the orchestrator's notes that state.md shows beside the live facts. */
const NotesSchema = z.looseObject({
  schema: z.literal(1),
  next: z.string(),
  lastCheck: z.string().nullable(),
  lastLandedAt: z.string().nullable(),
  /** spec 1.1 §8: the milestones waiting on the owner */
  parked: z.array(z.string()).optional(),
});
export type Notes = z.infer<typeof NotesSchema>;
export type NotesPatch = Partial<Omit<Notes, "schema">>;

/** Every writer's next step keeps the parked milestones in front of it (spec 1.1 §8). */
const parkedNext = (n: Notes): Notes => ({ ...n, next: withParked(n.next, n.parked ?? []) });

const FRESH: Notes = { schema: 1, next: "plan the milestones", lastCheck: null, lastLandedAt: null };

export function readNotes(run: Run): Notes {
  try {
    return readVersioned(runPaths(run.dir).stateJson, NotesSchema, 1);
  } catch (e) {
    if (isCatherdError(e) && e.code === "E_CONFIG_NEWER_SCHEMA") throw e;
    return { ...FRESH };
  }
}

/**
 * Rewrites state.json and state.md under the run's state lock, so concurrent writers never lose a
 * field (audit C11). `change` may be a function of the current notes; it runs inside the lock.
 * Throws E_IO_UNEXPECTED, writing nothing, when git fails: state.md must not show a broken git as clean.
 */
export function updateState(run: Run, change: NotesPatch | ((n: Notes) => NotesPatch) = {}): Promise<string> {
  const p = runPaths(run.dir);
  return withFileLock(p.stateJson, async () => {
    // git first: a failed snapshot throws before either file is written, so they never disagree
    const [head, snap] = await Promise.all([gitHead(run.meta.repo), statusSnapshot(run.meta.repo)]);
    const notes = readNotes(run);
    const next = parkedNext({ ...notes, ...(typeof change === "function" ? change(notes) : change) });
    writeJsonAtomic(p.stateJson, next);
    const live = liveDispatches(run);
    const text = renderState({
      title: run.meta.title,
      head: head ?? "none",
      dirty: Object.keys(snap)
        .sort()
        .map((path) => ({
          path,
          owner: live.find((d) => overlaps([path], d.admit.owns).length > 0)?.admit.name ?? null,
        })),
      running: live.map((d) => ({
        name: d.admit.name,
        rung: d.admit.rung,
        thread: d.admit.thread,
        since: d.admit.admittedAt.slice(11, 16),
        brief: relative(run.dir, dispatchPaths(d.dir).brief),
      })),
      lastCheck: next.lastCheck,
      next: next.next,
      protocol: protocolNext(run, next.parked ?? []),
    });
    writeTextAtomic(p.state, text);
    return text;
  });
}

/**
 * Writes state.json's notes only, with no git, under the state lock; for a writer that must not wait on git
 * while it holds another lock (`land` in a workspace, #43 finding 5). It waits out a refresh's git (15 s).
 */
export function patchNotes(run: Run, change: (n: Notes) => NotesPatch): Promise<Notes> {
  const stateJson = runPaths(run.dir).stateJson;
  return withFileLock(
    stateJson,
    () => {
      const notes = readNotes(run);
      const next = parkedNext({ ...notes, ...change(notes) });
      writeJsonAtomic(stateJson, next);
      return next;
    },
    { timeoutMs: 30_000 },
  );
}

/**
 * Ruling (b): a failed state.md refresh (git broken) never fails the call. The notes still go to state.json
 * under the state lock (state.md stays as it was), and the message comes back as a hint.
 */
export async function refreshState(
  run: Run,
  change: NotesPatch | ((n: Notes) => NotesPatch) = {},
): Promise<{ text: string | null; hints: string[] }> {
  let applied = false;
  const apply = (n: Notes): NotesPatch => {
    applied = true;
    return typeof change === "function" ? change(n) : change;
  };
  try {
    return { text: await updateState(run, apply), hints: [] };
  } catch (e) {
    const hints = [`state.md not refreshed: ${errorMessage(e)}`];
    // git fails before updateState reaches the notes: keep them, so a later refresh still shows them
    if (!applied) {
      const stateJson = runPaths(run.dir).stateJson;
      try {
        await withFileLock(stateJson, () => {
          const notes = readNotes(run);
          writeJsonAtomic(stateJson, parkedNext({ ...notes, ...apply(notes) }));
        });
      } catch (e2) {
        // the lock outwaited (a slow git under another refresh): still never fail the call
        hints.push(`notes not saved: ${errorMessage(e2)}`);
      }
    }
    return { text: null, hints };
  }
}
