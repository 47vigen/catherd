import { readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runCodex, userCodexHome } from "../../src/core/codex.ts";
import { createRun, rolePaths } from "../../src/core/runstore.ts";
import { tempRepo, withHome } from "../helpers.ts";

/** No tinyglobby (OVERRIDES): one directory, so a plain readdirSync suffices. */
function imagesSince(dir: string, since: number): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => /\.(png|webp|jpe?g)$/i.test(f))
      .map((f) => join(dir, f))
      .filter((f) => statSync(f).mtimeMs >= since - 1000)
      .sort();
  } catch {
    return [];
  }
}

describe.skipIf(!process.env.CATHERD_LIVE)("spike S3: the codex image tool through the runner", () => {
  test("writes images under <CODEX_HOME>/generated_images/<thread>/, and the runner returns them", async () => {
    withHome();
    const repo = tempRepo();
    const run = createRun(repo, "spike s3", []);
    writeFileSync(
      rolePaths(run.dir, "artist-1").brief,
      [
        "Generate one 256x256 image of a ginger cat holding a conductor baton with your image tool.",
        "Do not write any file yourself. Reply with the image path.",
        "The last line of your reply is: STATUS: complete — <why>",
      ].join("\n"),
    );
    const since = Date.now();
    const r = await runCodex({
      runDir: run.dir,
      name: "artist-1",
      role: "artist",
      rung: "gpt-6-sol#medium",
      cwd: repo,
      ownedFiles: [],
    });

    const searchDir = join(userCodexHome(), "generated_images", r.thread ?? "");
    const found = imagesSince(searchDir, since);
    console.log(JSON.stringify({ status: r.status, thread: r.thread, found, images: r.images }, null, 2));

    expect(r.status).toBe("ok");
    expect(found.length).toBeGreaterThan(0);
    expect(new Set(found.map(dirname))).toEqual(new Set([searchDir]));
    expect(r.images).toEqual(found);
  }, 600_000);
});
