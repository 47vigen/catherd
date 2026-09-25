import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import { runsDir } from "../../src/infra/paths.ts";
import {
  appendRecord,
  createRun,
  findRun,
  LEDGER_HEADER,
  listRuns,
  readRecords,
  runFile,
  runPaths,
} from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { freshRun, makeRecord } from "./helpers.ts";

afterEach(snapshotEnv());

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return isCatherdError(e) ? e.code : String(e);
  }
  return "no error";
};

describe("run folder", () => {
  it("creates meta, ledger header, JSONL headers and the lanes, roles and shots folders", () => {
    const { repo, run } = freshRun("Add login!");
    expect(run.id).toMatch(/^\d{8}-\d{6}-add-login$/);
    expect(run.dir.startsWith(runsDir(repo))).toBe(true);
    const meta = JSON.parse(readFileSync(runPaths(run.dir).meta, "utf8"));
    expect(meta).toMatchObject({
      schema: 1,
      id: run.id,
      repo,
      title: "Add login!",
      catherdVersion: "0.0.0-test",
    });
    expect(readFileSync(runPaths(run.dir).ledger, "utf8")).toBe(`${LEDGER_HEADER}\n`);
    expect(readFileSync(runPaths(run.dir).runs, "utf8")).toBe('{"schema":1,"kind":"runs"}\n');
    expect(findRun(run.id).meta.title).toBe("Add login!");
  });

  it("gives two runs with the same title in the same second distinct ids", () => {
    const { repo, run } = freshRun("same");
    const again = createRun({
      repo,
      title: "same",
      aLines: [],
      version: "x",
      now: new Date(run.meta.createdAt),
    });
    expect(again.id).toBe(`${run.id}-2`);
  });

  it("skips a run with a corrupt meta.json, lists the others, and names the corrupt one", () => {
    const { repo, run } = freshRun();
    const bad = join(runsDir(repo), "20260101-000000-bad");
    mkdirSync(bad);
    writeFileSync(join(bad, "meta.json"), "{ not json");
    const listing = listRuns();
    expect(listing.runs.map((r) => r.id)).toEqual([run.id]);
    expect(listing.corrupt.map((c) => c.id)).toEqual(["20260101-000000-bad"]);
    expect(code(() => findRun("20260101-000000-bad"))).toBe("E_RUN_CORRUPT");
    expect(code(() => findRun("nope"))).toBe("E_RUN_NOT_FOUND");
    expect(code(() => findRun("../x"))).toBe("E_ADMIT_ID");
  });
});

describe("records", () => {
  it("skips a crash-truncated tail and keeps every row after it whole", async () => {
    const { run } = freshRun();
    await appendRecord(run, makeRecord({ dispatchId: "D1" }));
    appendFileSync(runPaths(run.dir).runs, '{"schema":1,"runId":"r1","dispa');
    expect(readRecords(run)).toMatchObject({ records: [{ dispatchId: "D1" }], corrupt: 1 });
    await appendRecord(run, makeRecord({ dispatchId: "D2" }));
    expect(readRecords(run).records.map((r) => r.dispatchId)).toEqual(["D1", "D2"]);
  });

  it("keeps one record per dispatch, however many finalizers append it at once", async () => {
    const { run } = freshRun();
    const r = makeRecord({ dispatchId: "D1" });
    const out = await Promise.all([1, 2, 3, 4, 5].map((n) => appendRecord(run, { ...r, secs: n })));
    expect(new Set(out.map((x) => x.secs)).size).toBe(1);
    const rows = readFileSync(runPaths(run.dir).runs, "utf8").trim().split("\n");
    expect(rows).toHaveLength(2);
  });

  it("drops duplicate and invalid rows another writer left in the file", () => {
    const { run } = freshRun();
    const row = JSON.stringify(makeRecord({ dispatchId: "D1" }));
    appendFileSync(runPaths(run.dir).runs, `${row}\n${row}\n{"schema":1,"name":"no fields"}\n`);
    expect(readRecords(run)).toMatchObject({ records: [{ dispatchId: "D1" }], corrupt: 1 });
  });
});

describe("runFile", () => {
  it("confines paths to the run folder and protects catherd's own files, in any case", () => {
    const { run } = freshRun();
    expect(runFile(run, "lanes/M1.L1.md", "write")).toBe(join(run.dir, "lanes", "M1.L1.md"));
    expect(runFile(run, join(run.dir, "plan.md"), "write")).toBe(join(run.dir, "plan.md"));
    expect(runFile(run, "state.md", "read")).toBe(join(run.dir, "state.md"));
    for (const p of ["../../escape.md", "/etc/passwd"])
      expect(code(() => runFile(run, p, "read"))).toBe("E_IO_PATH");
    for (const p of ["state.md", "RUNS.JSONL", "Roles/w/1/brief.md", "roles", "admission.lock"])
      expect(code(() => runFile(run, p, "write"))).toBe("E_IO_PATH");
  });

  it("refuses a symlink inside the run folder that points out of it", () => {
    const { run } = freshRun();
    symlinkSync(mkdtempSync(join(tmpdir(), "catherd-out-")), join(run.dir, "lanes", "out"));
    expect(code(() => runFile(run, "lanes/out/x.md", "write"))).toBe("E_IO_PATH");
  });
});
