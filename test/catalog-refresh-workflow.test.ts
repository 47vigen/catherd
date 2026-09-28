import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const workflow = readFileSync(join(ROOT, ".github", "workflows", "catalog-refresh.yml"), "utf8");
const script = readFileSync(join(ROOT, "scripts", "catalog-refresh.ts"), "utf8");

describe(".github/workflows/catalog-refresh.yml (spec 1.2 §7)", () => {
  it("runs weekly and on demand", () => {
    expect(workflow).toMatch(/schedule:\n\s+# [^\n]*\n\s+- cron: "\d+ \d+ \* \* \d"/);
    expect(workflow).toContain("workflow_dispatch:");
  });

  it("rebuilds the shipped values and bars with the refresh script, never with an AA key", () => {
    expect(workflow).toContain(
      'bun scripts/catalog-refresh.ts --body "$RUNNER_TEMP/body.md" --changeset .changeset/catalog-refresh.md',
    );
    expect(workflow).not.toContain("ARTIFICIAL_ANALYSIS_API_KEY");
    expect(script).toContain("delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;");
    // a throwaway data folder: the refresh never reads or writes a user's cache
    expect(script).toContain("process.env.CATHERD_HOME = home;");
  });

  it("opens or updates one PR, chore(catalog): refresh scores, with a patch changeset, only on a change", () => {
    expect(workflow).toContain("if: steps.refresh.outputs.changed == 'true'");
    expect(workflow.match(/--title "chore\(catalog\): refresh scores"/g)).toHaveLength(2);
    expect(workflow).toContain('git commit -m "chore(catalog): refresh scores"');
    expect(workflow).toContain('--body-file "$RUNNER_TEMP/body.md"');
    expect(script).toContain('"catherd-cli": patch');
  });
});
