import { existsSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../domain/errors.ts";
import { db, ensureRunRow, insertDispatch, insertEvent, insertMessage } from "../infra/db.ts";
import { eventsFile, hasRunEnded, readEvents } from "./run-events-store.ts";
import { listRuns, readRecords } from "./run-store.ts";
import { teamMessages } from "./team.ts";

/**
 * Spec D13: every finished run an earlier build kept on files (an events.jsonl with `run.ended`), copied into the
 * database with `legacy = 1` so cross-run queries see it beside new runs. Reads only the run folder, never writes
 * it; such a run's own reads stay on its files. An unreadable folder is reported and skipped.
 */
export function importLegacyRuns(): { imported: string[]; skipped: { id: string; reason: string }[] } {
  const d = db();
  const known = new Set((d.query("SELECT id FROM runs").all() as { id: string }[]).map((r) => r.id));
  const listing = listRuns();
  // a corrupt meta.json of a run without an events.jsonl is no earlier run's: not ours to report at every boot
  const out = {
    imported: [] as string[],
    skipped: listing.corrupt
      .filter((c) => existsSync(join(c.dir, "events.jsonl")))
      .map((c) => ({ id: c.id, reason: c.reason })),
  };
  for (const run of listing.runs) {
    if (known.has(run.id) || !existsSync(eventsFile(run)) || !hasRunEnded(run)) continue;
    try {
      const events = readEvents(run);
      const { records, corrupt } = readRecords(run);
      if (corrupt > 0) throw new Error(`runs.jsonl has ${corrupt} corrupt row(s)`);
      const messages = teamMessages(run);
      d.transaction(() => {
        ensureRunRow(d, run, true);
        for (const e of events) insertEvent(d, run.id, e);
        for (const r of records) insertDispatch(d, run.id, r);
        for (const m of messages) insertMessage(d, run.id, m);
      }).immediate();
      out.imported.push(run.id);
    } catch (e) {
      out.skipped.push({ id: run.id, reason: errorMessage(e) });
    }
  }
  return out;
}
