import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { defaultOut } from "../../src/entry/capture-fixtures-command.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

describe("catherd capture-fixtures", () => {
  it("refuses a backend it has no cases for, with the fix, and exit 2", () => {
    const p = Bun.spawnSync([process.execPath, CLI, "capture-fixtures", "--backend", "antigravity"], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toBe(
      'error E_INPUT_INVALID: no capture cases for backend "antigravity"\nfix: catherd capture-fixtures --backend codex|claude-code|opencode|cursor|grok\n',
    );
  });

  it("writes under the checkout's test/fixtures/adapters by default, wherever it runs from", () => {
    expect(defaultOut()).toBe(join(import.meta.dir, "..", "fixtures", "adapters"));
  });
});
