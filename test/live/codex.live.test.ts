import { writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { runCodex } from "../../src/core/codex.ts";
import { createRun, rolePaths } from "../../src/core/runstore.ts";
import { tempRepo, withHome } from "../helpers.ts";

describe.skipIf(!process.env.CATHERD_LIVE)("live codex", () => {
  test("answers a tiny brief and ends with a STATUS line", async () => {
    withHome();
    const repo = tempRepo();
    const run = createRun(repo, "live", []);
    writeFileSync(
      rolePaths(run.dir, "researcher-1").brief,
      "Reply with the word hello, then a last line exactly: STATUS: complete — said hello",
    );
    const r = await runCodex({
      runDir: run.dir,
      name: "researcher-1",
      role: "researcher",
      rung: "gpt-6-luna#high",
      cwd: repo,
      ownedFiles: [],
    });
    expect(r.status).toBe("ok");
    expect(r.replyStatus).toBe("complete");
    expect(r.thread).not.toBeNull();
  }, 300_000);
});
