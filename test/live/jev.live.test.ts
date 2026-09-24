import { describe, expect, test } from "bun:test";
import { callJev, QUESTIONS, testJevKey } from "../../src/routing/jev.ts";
import { withHome } from "../helpers.ts";

const lane =
  "Lane M1.L2: add a GET /jobs endpoint to the Express API that lists jobs from the existing JobsRepository, " +
  "following the pattern of GET /workers in src/routes/workers.ts. Owned files: src/routes/jobs.ts, " +
  "test/jobs.test.ts. Fast check: bun test test/jobs.test.ts";

describe.skipIf(!process.env.CATHERD_LIVE || !process.env.TYPESAFE_API_KEY)("live jev", () => {
  test("answers kind and difficulty for a plain build lane, confidently", async () => {
    withHome();
    const r = await callJev({ kind: QUESTIONS.kind, difficulty: QUESTIONS.difficulty }, { lane });
    expect(r.error).toBeNull();
    expect(r.answers?.kind?.choice).toBe("repo_code");
    expect(r.answers?.kind?.confidence).toBeGreaterThanOrEqual(0.75);
    expect(["copy", "build"]).toContain(r.answers?.difficulty?.choice as string);
  }, 150_000);

  test("accepts the real key and refuses a fake one", async () => {
    expect(await testJevKey(process.env.TYPESAFE_API_KEY as string)).toBe(true);
    expect(await testJevKey("ts_fake_key")).toBe(false);
  }, 150_000);
});
