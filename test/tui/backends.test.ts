import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { detectBackends } from "../../src/tui/backends.ts";

const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
});

function binDir(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "catherd-bin-"));
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

describe("detectBackends", () => {
  it("reports both CLIs installed, versioned and logged in", async () => {
    process.env.PATH = binDir({
      codex: `case "$1" in --version) echo "codex-cli 0.156.1";; login) echo "Logged in using ChatGPT" >&2;; esac`,
      opencode: `case "$1" in --version) echo "opencode v2.0.15";; auth) echo "OpenCode Go  OpenCode Go  stored";; esac`,
    });
    expect(await detectBackends()).toEqual([
      { backend: "codex", installed: true, version: "0.156.1", loggedIn: true, fix: null },
      { backend: "opencode", installed: true, version: "2.0.15", loggedIn: true, fix: null },
    ]);
  });

  it("gives the login command for a logged-out codex and an opencode with no credentials", async () => {
    process.env.PATH = binDir({
      codex: `case "$1" in --version) echo "codex-cli 0.156.1";; login) echo "Not logged in" >&2; exit 1;; esac`,
      opencode: `case "$1" in --version) echo "opencode v2.0.15";; auth) exit 0;; esac`,
    });
    const [codex, opencode] = await detectBackends();
    expect(codex).toMatchObject({ installed: true, loggedIn: false, fix: "codex login" });
    expect(opencode).toMatchObject({ installed: true, loggedIn: false, fix: "opencode auth login" });
  });

  it("reports a missing CLI as not installed, with the install command", async () => {
    process.env.PATH = binDir({});
    expect(await detectBackends()).toEqual([
      { backend: "codex", installed: false, version: null, loggedIn: false, fix: "npm i -g @openai/codex" },
      {
        backend: "opencode",
        installed: false,
        version: null,
        loggedIn: false,
        fix: "curl -fsSL https://opencode.ai/v2/install | bash",
      },
    ]);
  });
});
