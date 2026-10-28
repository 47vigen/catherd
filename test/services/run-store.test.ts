import { afterEach, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import { db } from "../../src/infra/db.ts";
import { runsDir } from "../../src/infra/paths.ts";
import {
  appendRecord,
  createRun,
  findRun,
  laneFile,
  laneIds,
  LEDGER_HEADER,
  listRuns,
  readRecords,
  runFile,
  runPaths,
} from "../../src/services/run-store.ts";
import { snapshotEnv, tempRepo } from "../helpers.ts";
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
  it("creates meta, ledger header, JSONL headers and the lanes, roles and shots folders, and no runs.jsonl", () => {
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
    expect(existsSync(runPaths(run.dir).runs)).toBe(false);
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

  it("keeps a run id unique across repos, since findRun looks an id up in all of them", () => {
    const { run } = freshRun("same");
    const other = createRun({
      repo: tempRepo(),
      title: "same",
      aLines: [],
      version: "x",
      now: new Date(run.meta.createdAt),
    });
    expect(other.id).toBe(`${run.id}-2`);
    expect(findRun(run.id).dir).toBe(run.dir);
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
  it("skips a crash-truncated tail of an earlier build's runs.jsonl and keeps every row after it whole", async () => {
    const { run } = freshRun();
    writeFileSync(runPaths(run.dir).runs, '{"schema":1,"kind":"runs"}\n');
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
    expect(existsSync(runPaths(run.dir).runs)).toBe(false);
    expect(
      db().query("SELECT dispatch_id, role, status FROM dispatches WHERE run_id = ?").all(run.id),
    ).toEqual([{ dispatch_id: "D1", role: r.role, status: r.status }]);
    expect(readRecords(run)).toMatchObject({
      records: [{ dispatchId: "D1", secs: out[0]?.secs }],
      corrupt: 0,
    });
  });

  it("refuses a run whose dispatches rows and runs.jsonl both exist", async () => {
    const { run } = freshRun();
    await appendRecord(run, makeRecord({ dispatchId: "D1" }));
    writeFileSync(runPaths(run.dir).runs, `${JSON.stringify(makeRecord({ dispatchId: "D2" }))}\n`);
    expect(() => readRecords(run)).toThrow(
      expect.objectContaining({ code: "E_RUN_CORRUPT", message: expect.stringContaining("runs.jsonl") }),
    );
    await expect(appendRecord(run, makeRecord({ dispatchId: "D3" }))).rejects.toMatchObject({
      code: "E_RUN_CORRUPT",
    });
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

  it("allows a role to write only plan.md, dossier.md and a lane file", () => {
    const { run } = freshRun();
    for (const p of ["plan.md", "Plan.md", "dossier.md", "lanes/M1.L1.md"])
      expect(runFile(run, p, "write")).toBe(join(run.dir, p));
    for (const p of [
      "events.jsonl",
      "EVENTS.jsonl",
      "trees/M1/.git",
      "trees/M1.ready",
      "scratch/x",
      "decisions/x",
      "admission/x",
      "daemon.log",
      "lanes/M1.L1.md/../../events.jsonl",
      "lanes/a/b.md",
      "lanes/M1.L1.txt",
    ])
      expect(code(() => runFile(run, p, "write"))).toBe("E_IO_PATH");
    expect(runFile(run, "events.jsonl", "read")).toBe(join(run.dir, "events.jsonl"));
  });

  it("refuses a role write to the run's pin or supersede pointer (the pin's access is laid over the profile)", () => {
    const { run } = freshRun();
    for (const p of ["pin.json", "PIN.JSON", "superseded.json"])
      expect(code(() => runFile(run, p, "write"))).toBe("E_IO_PATH");
  });

  it("refuses a symlink inside the run folder that points out of it", () => {
    const { run } = freshRun();
    symlinkSync(mkdtempSync(join(tmpdir(), "catherd-out-")), join(run.dir, "lanes", "out"));
    expect(code(() => runFile(run, "lanes/out/x.md", "write"))).toBe("E_IO_PATH");
  });
});

describe("the run's lanes", () => {
  it("are the lanes/<Mx.Ly>.md files in natural order; a stray .md is no lane", () => {
    const { run } = freshRun();
    mkdirSync(runPaths(run.dir).lanes, { recursive: true });
    for (const f of ["M1.L10.md", "M1.L2.md", "M2.L1.md", "notes.md", "M1.md", "README.txt"])
      writeFileSync(join(runPaths(run.dir).lanes, f), "x\n");
    expect(laneIds(run)).toEqual(["M1.L2", "M1.L10", "M2.L1"]);
    expect(laneFile(run, "M1.L2")).toBe(join(run.dir, "lanes", "M1.L2.md"));
  });
});
