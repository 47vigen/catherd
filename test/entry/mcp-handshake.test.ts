import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCHER, mcpHandshake } from "../../src/entry/mcp/handshake.ts";
import { snapshotEnv } from "../helpers.ts";

afterEach(snapshotEnv());

const BIN = join(import.meta.dir, "..", "bin");

describe("doctor's MCP handshake (spec 1.1 §12)", () => {
  it("starts the server through the plugin's launcher", () => {
    expect(LAUNCHER).toBe(join(import.meta.dir, "..", "..", "plugin", "bin", "catherd-mcp"));
  });

  it("answers tools/list through the launcher, which runs the catherd on PATH at its version", async () => {
    // test/bin/catherd is this checkout: the launcher takes it for the global install
    process.env.PATH = `${BIN}:${join(process.execPath, "..")}:/usr/bin:/bin`;
    process.env.ANTHROPIC_API_KEY = "";
    const h = await mcpHandshake();
    expect(h.ok).toBe(true);
    expect(h.tools).toContain("status");
  }, 60_000);

  it("keeps what the server printed on stderr when it does not start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "catherd-handshake-"));
    const broken = join(dir, "catherd-mcp");
    writeFileSync(
      broken,
      "#!/bin/sh\necho \"error: Cannot find module 'zod' from '/x/src/cli.ts'\" >&2\nexit 1\n",
    );
    chmodSync(broken, 0o755);
    const h = await mcpHandshake({ launcher: broken });
    expect(h.ok).toBe(false);
    expect(h.stderr).toContain("Cannot find module 'zod'");
  }, 60_000);
});
