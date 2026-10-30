import { afterEach, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { db, insertCheck } from "../../src/infra/db.ts";
import { flowOf } from "../../src/services/run-flow.ts";
import { appendEvent, readEvents } from "../../src/services/run-events-store.ts";
import { startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv } from "../helpers.ts";
import { freshRun } from "./helpers.ts";

afterEach(snapshotEnv());
test("modern runs include row-only checks and legacy rows do not", async () => {
  const { run } = freshRun();
  const at = new Date("2026-01-01T00:00:00.000Z");
  await appendEvent(run, { type: "run.started", ...startedFields }, at);
  insertCheck(db(), run.id, {
    checkId: "C1",
    scope: "fast",
    command: "test",
    ref: "HEAD",
    tree: null,
    base: true,
    exit: 1,
    failures: ["failure"],
    minutes: 1,
    cached: false,
    at: at.toISOString(),
  });
  const events = readEvents(run);
  const files = readdirSync(run.dir, { recursive: true }).sort();
  expect(flowOf(run, events, [], at.getTime() + 1000)?.checks[0]).toMatchObject({
    startedAt: null,
    endedAt: at.toISOString(),
    failureCount: 1,
    inheritedFailures: null,
    newFailures: null,
  });
  expect(readdirSync(run.dir, { recursive: true }).sort()).toEqual(files);
  db().query("UPDATE runs SET legacy = 1 WHERE id = ?").run(run.id);
  expect(flowOf(run, events, [], at.getTime())).toBeNull();
});

test("earlier files and earlier event schemas have no flow", async () => {
  freshRun();
  const { seedFixtureRun } = await import("./fixture-run.ts");
  const oldFile = seedFixtureRun();
  expect(flowOf(oldFile, readEvents(oldFile), [], Date.now())).toBeNull();
  const { run } = freshRun();
  await appendEvent(run, { type: "run.started", ...startedFields }, new Date("2026-01-01T00:00:00Z"));
  db()
    .query("UPDATE events SET body = json_set(body, '$.v', 1) WHERE run_id = ? AND type = 'run.started'")
    .run(run.id);
  expect(flowOf(run, readEvents(run), [], Date.now())).toBeNull();
});
