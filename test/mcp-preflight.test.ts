import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { dataDir } from "../src/paths.ts";
import { tempRepo, withHome } from "./helpers.ts";
import { call, mcpClient, startRun } from "./mcp-helpers.ts";

describe("preflight", () => {
  beforeEach(() => {
    withHome();
    delete process.env.TYPESAFE_API_KEY;
  });

  test("with no lanes, returns no results and allPass true", async () => {
    const c = await mcpClient();
    const { run } = await startRun(c, tempRepo());
    const r = await call(c, "preflight", { run });
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({ results: [], allPass: true });
  });

  test("reports pass/fail per lane with the tail of its output, once each", async () => {
    const c = await mcpClient();
    const { run } = await startRun(c, tempRepo());
    await call(c, "write_run_file", {
      run,
      path: "lanes/M1.L1.md",
      content: "# M1.L1 — ok\nOwns: a.ts\nFast check: echo hi && true\n",
    });
    await call(c, "write_run_file", {
      run,
      path: "lanes/M1.L2.md",
      content: "# M1.L2 — bad\nOwns: b.ts\nFast check: echo bye && false\n",
    });
    await call(c, "write_run_file", {
      run,
      path: "lanes/M1.L3.md",
      content: "# M1.L3 — no check\nOwns: c.ts\n",
    });

    const r = await call(c, "preflight", { run });
    expect(r.isError).toBe(false);
    expect(r.data.allPass).toBe(false);
    const byLane = Object.fromEntries(r.data.results.map((x: { lane: string }) => [x.lane, x]));
    expect(byLane["M1.L1"]).toMatchObject({ pass: true, check: "echo hi && true" });
    expect(byLane["M1.L1"].tail).toContain("hi");
    expect(byLane["M1.L2"]).toMatchObject({ pass: false, check: "echo bye && false" });
    expect(byLane["M1.L2"].tail).toContain("bye");
    expect(byLane["M1.L3"]).toMatchObject({ pass: false });
    expect(byLane["M1.L3"].tail[0]).toContain('no "Fast check:" line');
  });

  test("skips a check whose file the lane creates, rather than failing it", async () => {
    const c = await mcpClient();
    const { run } = await startRun(c, tempRepo());
    await call(c, "write_run_file", {
      run,
      path: "lanes/M1.L1.md",
      content: "# M1.L1 — new\nOwns: src/new.ts, src/new.test.ts\nFast check: bun test ./src/new.test.ts\n",
    });
    const r = await call(c, "preflight", { run });
    expect(r.data.allPass).toBe(true);
    expect(r.data.results[0]).toMatchObject({ lane: "M1.L1", pass: true, skipped: true });
    expect(r.data.results[0].tail[0]).toContain("src/new.test.ts");
  });

  test("holds the machine-wide heavy lock while it runs, and releases it after", async () => {
    const c = await mcpClient();
    const { run } = await startRun(c, tempRepo());
    await call(c, "write_run_file", {
      run,
      path: "lanes/M1.L1.md",
      content: "# M1.L1 — x\nOwns: a.ts\nFast check: sleep 0.3\n",
    });
    const pending = call(c, "preflight", { run });
    await new Promise((r) => setTimeout(r, 100));
    expect(readdirSync(join(dataDir(), "locks")).length).toBeGreaterThan(0);
    await pending;
    expect(readdirSync(join(dataDir(), "locks"))).toEqual([]);
  });
});
