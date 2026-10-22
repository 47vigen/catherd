import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runsDir } from "../../src/infra/paths.ts";
import { findRun, type Run } from "../../src/services/run-store.ts";

/** Copies `test/fixtures/runs/<name>` under the data dir of the current `withHome()` and returns the run. */
export function seedFixtureRun(name = "case-helpers"): Run {
  const from = join(import.meta.dir, "..", "fixtures", "runs", name);
  const meta = JSON.parse(readFileSync(join(from, "meta.json"), "utf8")) as { id: string; repo: string };
  const to = join(runsDir(meta.repo), meta.id);
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
  return findRun(meta.id);
}
