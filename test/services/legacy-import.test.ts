import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../../src/infra/db.ts";
import { runsDir } from "../../src/infra/paths.ts";
import { importLegacyRuns } from "../../src/services/legacy-import.ts";
import { appendEvent, eventsFile, readEvents } from "../../src/services/run-events-store.ts";
import { createRun, runPaths, type Run } from "../../src/services/run-store.ts";
import { TEAM_FILE } from "../../src/services/team.ts";
import { makeRecord } from "../domain/make-record.ts";
import { makeLog, startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv } from "../helpers.ts";
import { freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

/** A run folder as an earlier 2.0 build left it: events.jsonl, runs.jsonl, team.jsonl; ended or not. */
function earlier(run: Run, ended: boolean): void {
  const log = makeLog();
  log.add("run.started", startedFields);
  if (ended) log.add("run.ended", { outcome: "done", reportPath: null });
  writeFileSync(eventsFile(run), log.events.map((e) => `${JSON.stringify(e)}\n`).join(""));
  const record = makeRecord({ dispatchId: "D1" });
  writeFileSync(runPaths(run.dir).runs, `{"schema":1,"kind":"runs"}\n${JSON.stringify(record)}\n`);
  const m = { n: 1, at: "2026-10-27T10:00:00.000Z", from: "architect", to: "all", text: "hi" };
  writeFileSync(join(run.dir, TEAM_FILE), `${JSON.stringify(m)}\n`);
}

const snapshot = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => [join(e.parentPath, e.name), readFileSync(join(e.parentPath, e.name), "utf8")]),
  );

describe("importing earlier runs (plan 46, spec D13)", () => {
  it("copies a finished earlier run in as legacy, once, and never writes its folder", () => {
    const { run } = freshRun();
    earlier(run, true);
    const before = snapshot(run.dir);
    expect(importLegacyRuns()).toEqual({ imported: [run.id], skipped: [] });
    expect(snapshot(run.dir)).toEqual(before);
    expect(db().query("SELECT legacy FROM runs WHERE id = ?").get(run.id)).toEqual({ legacy: 1 });
    expect(db().query("SELECT type FROM events WHERE run_id = ? ORDER BY seq").all(run.id)).toEqual([
      { type: "run.started" },
      { type: "run.ended" },
    ]);
    expect(db().query("SELECT dispatch_id FROM dispatches WHERE run_id = ?").all(run.id)).toEqual([
      { dispatch_id: "D1" },
    ]);
    expect(db().query("SELECT text FROM messages WHERE run_id = ?").all(run.id)).toEqual([{ text: "hi" }]);
    // its own reads stay on its files
    expect(readEvents(run).map((e) => e.type)).toEqual(["run.started", "run.ended"]);
    expect(importLegacyRuns()).toEqual({ imported: [], skipped: [] });
  });

  it("leaves an earlier run still in flight, and every run of this build, alone", async () => {
    const { repo, run } = freshRun();
    earlier(run, false);
    const fresh = createRun({ repo, title: "new", aLines: [], version: "x" });
    await appendEvent(fresh, { type: "tick" });
    expect(importLegacyRuns()).toEqual({ imported: [], skipped: [] });
    expect(db().query("SELECT id, legacy FROM runs").all()).toEqual([{ id: fresh.id, legacy: 0 }]);
  });

  it("reports and skips a folder it cannot read, and imports nothing of it", () => {
    const { repo, run } = freshRun();
    earlier(run, true);
    writeFileSync(eventsFile(run), `${readFileSync(eventsFile(run), "utf8")}not json\n{"v":1}\n`);
    const bad = join(runsDir(repo), "20260101-000000-bad");
    mkdirSync(bad);
    writeFileSync(join(bad, "meta.json"), "{ not json");
    writeFileSync(join(bad, "events.jsonl"), "");
    const r = importLegacyRuns();
    expect(r.imported).toEqual([]);
    expect(r.skipped.map((s) => s.id).sort()).toEqual(["20260101-000000-bad", run.id].sort());
    expect(r.skipped.find((s) => s.id === run.id)?.reason).toContain("is corrupt");
    expect(db().query("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 0 });
  });

  it("does not report a corrupt folder of a run this build started, and skips a run with corrupt records", () => {
    const { repo, run } = freshRun();
    earlier(run, true);
    writeFileSync(runPaths(run.dir).runs, `{"schema":1,"kind":"runs"}\n{"schema":1,"name":"no fields"}\n`);
    const mine = join(runsDir(repo), "20260101-000000-mine");
    mkdirSync(mine);
    writeFileSync(join(mine, "meta.json"), "{ not json");
    const r = importLegacyRuns();
    expect(r.imported).toEqual([]);
    expect(r.skipped.map((s) => s.id)).toEqual([run.id]);
    expect(r.skipped[0]?.reason).toContain("corrupt");
    expect(db().query("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 0 });
  });
});
