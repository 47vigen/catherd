import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

describe("catherd capture-fixtures", () => {
  it("refuses a backend it has no cases for, with the fix, and exit 2", () => {
    const p = Bun.spawnSync([process.execPath, CLI, "capture-fixtures", "--backend", "grok"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toBe(
      'error E_INPUT_INVALID: no capture cases for backend "grok"\nfix: pass --backend codex|claude-code|opencode\n',
    );
  });
});
