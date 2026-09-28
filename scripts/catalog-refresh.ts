#!/usr/bin/env bun
// Spec 1.2 §7: fetch every keyless source, rebuild catalog/scores.json's shipped values and default bars, and
// write the refresh PR's body and patch changeset. .github/workflows/catalog-refresh.yml runs it weekly; a
// maintainer runs it to produce a release's shipped values. It never reads an Artificial Analysis key, and it
// syncs into a throwaway data folder, never the user's own cache.
//
//   bun scripts/catalog-refresh.ts [--body <file>] [--changeset <file>]
//
// Exit 0 when the file changed (and was written) or nothing changed ("no change" on stdout); 1 when a source
// failed, and then nothing is written.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { body: { type: "string" }, changeset: { type: "string" } },
});

const home = mkdtempSync(join(tmpdir(), "catherd-refresh-"));
process.env.CATHERD_HOME = home;
delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;

const { assetPath } = await import("../src/infra/assets.ts");
const { shippedModels, shippedScores } = await import("../src/services/catalog-service.ts");
const { shippedSources } = await import("../src/services/source-sync.ts");
const { refreshBody, refreshShipped } = await import("../src/services/catalog-refresh.ts");

const out = assetPath("catalog/scores.json");
try {
  const r = await refreshShipped({
    out,
    current: shippedScores(),
    models: shippedModels(),
    sources: shippedSources(),
  });
  for (const f of r.failed) console.error(`${f.source}: ${f.error}`);
  if (r.failed.length) {
    console.error("a source failed: catalog/scores.json is left as it is");
    process.exitCode = 1;
  } else if (!r.changed || !r.report) console.log("no change");
  else {
    // the file is written as JSON.stringify writes it; oxfmt gives it the repository's format
    spawnSync("bunx", ["oxfmt", out], { stdio: "inherit" });
    const body = refreshBody(r.report);
    if (values.body) writeFileSync(values.body, body);
    if (values.changeset)
      writeFileSync(
        values.changeset,
        `---\n"catherd-cli": patch\n---\n\nRefresh the shipped model scores and default bars from the public sources (data of ${r.report.date}).\n`,
      );
    console.log(body);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
