import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeRoute, laneState } from "../../src/domain/jev.ts";
import { askJev, jevQuestions, testJevKey } from "../../src/services/jev-service.ts";

const lane = [
  "# M1.L2 — GET /jobs",
  "Owns: src/routes/jobs.ts, test/jobs.test.ts",
  "Fast check: bun test test/jobs.test.ts",
  "Add a GET /jobs endpoint to the Express API that lists jobs from the existing JobsRepository,",
  "following the pattern of GET /workers in src/routes/workers.ts.",
].join("\n");

describe.skipIf(!process.env.CATHERD_LIVE || !process.env.TYPESAFE_API_KEY)("live jev", () => {
  test("route-v2 puts a plain build lane on Track A as repo_code", async () => {
    const a = await askJev(mkdtempSync(join(tmpdir(), "catherd-jev-live-")), "route-v2", laneState(lane));
    expect(a.why).toBeNull();
    const j = judgeRoute(jevQuestions().sets["route-v2"].rule, a.answers ?? {});
    expect(j.kind).toBe("repo_code");
    expect(j.track).toBe("A");
    expect(a.meta.model).toBe("jev-1.13.0");
  }, 60_000);

  test("accepts the real key and refuses a fake one", async () => {
    expect(await testJevKey(process.env.TYPESAFE_API_KEY as string)).toBe(true);
    expect(await testJevKey("ts_fake_key")).toBe(false);
  }, 60_000);
});
