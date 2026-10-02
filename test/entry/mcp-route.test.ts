import { afterEach, describe, expect, it } from "bun:test";
import { writeRunFile } from "../../src/services/run-service.ts";
import { snapshotEnv } from "../helpers.ts";
import { call, mcpClient } from "../mcp-helpers.ts";
import { fakeDeps, freshRun } from "../services/helpers.ts";

afterEach(snapshotEnv());

const laneText = (id: string) =>
  [`# ${id}`, `Owns: src/${id}.ts`, "Fast check: bun test", "Kind: repo_code", "Difficulty: build", "x"].join(
    "\n",
  );

describe("the route tool (spec 1.5 plan 24)", () => {
  it("routes several lanes in one call and returns little for each", async () => {
    const { run } = freshRun();
    for (const id of ["M1.L1", "M1.L2"])
      writeRunFile({ run: run.id, path: `lanes/${id}.md`, content: laneText(id) });
    const c = await mcpClient(fakeDeps());
    const r = await call(c, "route", { run: run.id, lanes: ["lanes/M1.L1.md", "lanes/M1.L2.md"] });
    expect(r.isError).toBe(false);
    expect(r.data.routes.map((x: { lane: string }) => x.lane)).toEqual(["M1.L1", "M1.L2"]);
    expect(Object.keys(r.data.routes[0]).sort()).toEqual([
      "agent",
      "backend",
      "ladder",
      "lane",
      "role",
      "rung",
      "why",
    ]);
  });

  it("refuses lane_file and lanes together", async () => {
    const { run } = freshRun();
    const c = await mcpClient(fakeDeps());
    const r = await call(c, "route", { run: run.id, lane_file: "lanes/M1.L1.md", lanes: ["lanes/M1.L1.md"] });
    expect(r.error).toMatchObject({
      code: "E_INPUT_INVALID",
      message: "route takes lane_file or lanes, not both",
    });
  });
});
