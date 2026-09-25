import { relative } from "node:path";
import { z } from "zod";
import { isCatherdError } from "../domain/errors.ts";
import { overlaps } from "../domain/lane.ts";
import { renderState } from "../domain/state.ts";
import { dispatchPaths } from "../infra/dispatch-dir.ts";
import { withFileLock } from "../infra/filelock.ts";
import { gitHead, statusSnapshot } from "../infra/git.ts";
import { readVersioned, writeJsonAtomic, writeTextAtomic } from "../infra/store.ts";
import { liveDispatches } from "./dispatches.ts";
import { type Run, runPaths } from "./run-store.ts";

/** state.json: the orchestrator's notes that state.md shows beside the live facts. */
export const NotesSchema = z.looseObject({
  schema: z.literal(1),
  next: z.string(),
  lastCheck: z.string().nullable(),
  lastLandedAt: z.string().nullable(),
});
export type Notes = z.infer<typeof NotesSchema>;
export type NotesPatch = Partial<Omit<Notes, "schema">>;

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
 */
export function updateState(run: Run, change: NotesPatch | ((n: Notes) => NotesPatch) = {}): Promise<string> {
  const p = runPaths(run.dir);
  return withFileLock(p.stateJson, async () => {
    const notes = readNotes(run);
    const next: Notes = { ...notes, ...(typeof change === "function" ? change(notes) : change) };
    writeJsonAtomic(p.stateJson, next);
    const live = liveDispatches(run);
    const [head, snap] = await Promise.all([gitHead(run.meta.repo), statusSnapshot(run.meta.repo)]);
    const text = renderState({
      title: run.meta.title,
      head,
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
    });
    writeTextAtomic(p.state, text);
    return text;
  });
}
