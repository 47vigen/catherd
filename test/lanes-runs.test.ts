import { beforeEach, describe, expect, test } from "bun:test";
import {
  appendRoute,
  currentRoute,
  fastCheckOf,
  ownedFilesOf,
  readLane,
  type LaneRoute,
} from "../src/core/lanes.ts";
import { createRun } from "../src/core/runstore.ts";
import { tempRepo, withHome } from "./helpers.ts";

const route = (lane: string, rung: string): LaneRoute => ({
  at: new Date().toISOString(),
  lane,
  role: "worker",
  rung,
  ladder: ["gpt-6-sol#medium", "gpt-6-sol#high"],
  source: "route",
  from: null,
  reason: null,
  kind: "repo_code",
  difficulty: "build",
  jev: "default",
});

describe("lane files", () => {
  beforeEach(() => withHome());

  test("reads the Owns: line in its plain and bold forms", () => {
    expect(ownedFilesOf("# M1.L1 — x\nOwns: src/a.ts, `test/a.test.ts`\nFast check: pnpm t")).toEqual([
      "src/a.ts",
      "test/a.test.ts",
    ]);
    expect(ownedFilesOf("**Owns:** src/b.ts")).toEqual(["src/b.ts"]);
    expect(ownedFilesOf("# no owners here")).toEqual([]);
  });

  test("reads the Fast check: line in its plain and bold forms", () => {
    expect(fastCheckOf("Owns: a.ts\nFast check: pnpm vitest run test/a.test.ts\n")).toBe(
      "pnpm vitest run test/a.test.ts",
    );
    expect(fastCheckOf("**Fast check:** `true`")).toBe("true");
    expect(fastCheckOf("# no fast check here")).toBeNull();
  });

  test("refuses a lane id that is a path", () => {
    const run = createRun(tempRepo(), "t", []);
    expect(() => readLane(run.dir, "../meta")).toThrow(/bad lane id/);
    expect(() => readLane(run.dir, "M9.L9")).toThrow(/no lane file/);
  });

  test("keeps the last route of a lane as its current one", () => {
    const run = createRun(tempRepo(), "t", []);
    appendRoute(run.dir, route("M1.L1", "gpt-6-sol#medium"));
    appendRoute(run.dir, { ...route("M1.L1", "gpt-6-sol#high"), source: "climb", from: "gpt-6-sol#medium" });
    appendRoute(run.dir, route("M1.L2", "gpt-6-luna#high"));
    expect(currentRoute(run.dir, "M1.L1")?.rung).toBe("gpt-6-sol#high");
    expect(currentRoute(run.dir, "M1.L3")).toBeUndefined();
  });
});
