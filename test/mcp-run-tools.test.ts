import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { appendRunRecord, rolePaths } from "../src/core/runstore.ts";
import { tempRepo, withHome } from "./helpers.ts";
import { call, mcpClient, startRun } from "./mcp-helpers.ts";
import { fakeRecord } from "./records.ts";

describe("run tools", () => {
  beforeEach(() => {
    withHome();
    delete process.env.TYPESAFE_API_KEY;
  });

  test("lists the run tools", async () => {
    const c = await mcpClient();
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const n of ["run_start", "write_run_file", "read_run_file", "status", "result", "set_next"]) {
      expect(names).toContain(n);
    }
  });

  test("run_start refuses without a Jev key, and outside a git repo", async () => {
    const c = await mcpClient();
    const noKey = await call(c, "run_start", { repo: tempRepo(), title: "t", a_lines: ["A1"] });
    expect(noKey.isError).toBe(true);
    expect(noKey.raw).toContain("no Jev key");
    process.env.TYPESAFE_API_KEY = "test-fake-key";
    const notGit = await call(c, "run_start", {
      repo: mkdtempSync(join(tmpdir(), "nogit-")),
      title: "t",
      a_lines: ["A1"],
    });
    expect(notGit.isError).toBe(true);
    expect(notGit.raw).toContain("not inside a git repository");
  });

  test("run_start creates the run folder and state.md, and never echoes the key", async () => {
    const c = await mcpClient();
    process.env.TYPESAFE_API_KEY = "test-fake-key";
    const r = await call(c, "run_start", {
      repo: tempRepo(),
      title: "Jobs screen",
      a_lines: ["A1 jobs list"],
    });
    expect(r.isError).toBe(false);
    expect(r.data.run).toMatch(/jobs-screen$/);
    const state = readFileSync(join(r.data.dir, "state.md"), "utf8");
    expect(state).toContain("A1 jobs list");
    expect(r.raw).not.toContain("test-fake-key");
    expect(state).not.toContain("test-fake-key");
  });

  test("writes and reads run files, and refuses paths outside the run or catherd's own files", async () => {
    const c = await mcpClient();
    const { run } = await startRun(c, tempRepo());
    expect(
      (await call(c, "write_run_file", { run, path: "lanes/M1.L1.md", content: "Owns: a.ts" })).isError,
    ).toBe(false);
    expect((await call(c, "read_run_file", { run, path: "lanes/M1.L1.md" })).raw).toBe("Owns: a.ts");
    const escape = await call(c, "write_run_file", { run, path: "../../escape.md", content: "x" });
    expect(escape.isError).toBe(true);
    expect(escape.raw).toContain("outside the run folder");
    expect((await call(c, "write_run_file", { run, path: "state.md", content: "x" })).isError).toBe(true);
  });

  test("status shows one run, or says there are none", async () => {
    const c = await mcpClient();
    expect((await call(c, "status")).raw).toBe("catherd: no runs yet");
    const { run } = await startRun(c, tempRepo(), "Jobs screen");
    const one = await call(c, "status", { run });
    expect(one.raw).toContain("== Jobs screen");
    expect(one.raw).toContain("Next: ");
    expect((await call(c, "status")).raw).toContain("== Jobs screen");
  });

  test("result returns the capped reply and the latest record", async () => {
    const c = await mcpClient();
    const { run, dir } = await startRun(c, tempRepo());
    const p = rolePaths(dir, "researcher-dossier");
    writeFileSync(p.out, Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"));
    appendRunRecord(dir, fakeRecord("researcher-dossier", { role: "researcher" }));
    const r = await call(c, "result", { run, name: "researcher-dossier" });
    expect(r.data.record.name).toBe("researcher-dossier");
    expect(r.data.reply).toContain("line 249");
    expect(r.data.reply).not.toContain("line 250");
    expect(r.data.reply).toContain(`[capped: the full reply is ${p.out}]`);
  });

  test("set_next writes the next step as state.md's last line", async () => {
    const c = await mcpClient();
    const { run, dir } = await startRun(c, tempRepo());
    await call(c, "set_next", { run, next: "paused: waiting for the user" });
    const last = readFileSync(join(dir, "state.md"), "utf8").trimEnd().split("\n").at(-1);
    expect(last).toBe("Next: paused: waiting for the user");
  });

  test("names an unknown run", async () => {
    const c = await mcpClient();
    const r = await call(c, "status", { run: "nope" });
    expect(r.isError).toBe(true);
    expect(r.raw).toContain('no run "nope"');
  });
});
