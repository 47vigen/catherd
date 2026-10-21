import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendAdapter, FinishedRun } from "../src/adapters/backend.ts";
import { claudeCodeAdapter } from "../src/adapters/claude-code/index.ts";
import { codexAdapter } from "../src/adapters/codex/index.ts";
import { parseRung } from "../src/domain/ids.ts";
import { tempDir } from "./helpers.ts";

const SHIMS = join(import.meta.dir, "..", "scorecard", "shim");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A world: fake real CLIs that exit 7, and a limits dir holding one token. */
function world(script = 'echo "real $*"; exit 7') {
  const root = tempDir("scorecard-shim-");
  dirs.push(root);
  const bin = join(root, "bin");
  const limits = join(root, "limits");
  mkdirSync(bin);
  mkdirSync(join(limits, "tokens"), { recursive: true });
  mkdirSync(join(limits, "taken"));
  writeFileSync(join(limits, "tokens", "1"), "");
  for (const n of ["codex", "claude"]) writeFileSync(join(bin, n), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const run = (shim: string, args: string[], env: Record<string, string> = {}, path?: string) => {
    const p = Bun.spawnSync([join(SHIMS, shim), ...args], {
      env: {
        PATH: path ?? `${SHIMS}:${bin}:/usr/bin:/bin`,
        ANTHROPIC_API_KEY: "",
        CATHERD_SCORECARD_LIMITS: limits,
        ...env,
      },
    });
    return { code: p.exitCode, out: p.stdout.toString() };
  };
  return {
    run,
    limits,
    tokens: () => readdirSync(join(limits, "tokens")),
    taken: () => readdirSync(join(limits, "taken")),
  };
}

function finished(rung: string, out: string, code: number): FinishedRun {
  return {
    request: {
      rung: parseRung(rung),
      access: "workspace-write",
      thread: null,
      isolated: false,
      repo: "/repo",
      briefPath: "/d/brief.md",
      replyPath: "/d/reply.md",
      dispatchDir: "/d",
    },
    eventLines: out.split("\n").filter((l) => l.trim()),
    reply: "",
    stderr: "",
    exit: { code, signal: null, reason: "exited", endedAt: "x" },
    startedAtMs: 0,
  };
}

describe("scorecard shim", () => {
  const cases: [string, string[], BackendAdapter, string][] = [
    ["codex", ["exec", "-m", "gpt-6-sol"], codexAdapter, "codex:gpt-6-sol#medium"],
    [
      "claude",
      ["-p", "--output-format", "stream-json"],
      claudeCodeAdapter,
      "claude-code:claude-opus-5-5#low",
    ],
  ];
  it.each(cases)(
    "ends one %s call in a limit the adapter reads as a limit, then runs the real CLI",
    (name, args, adapter, rung) => {
      const w = world();
      const first = w.run(name, args);
      expect(first.code).toBe(1);
      expect(adapter.finalize(finished(rung, first.out, first.code)).status).toBe("limit");
      expect(w.taken()).toEqual(["1"]);
      expect(w.run(name, [...args, "a b"])).toEqual({ code: 7, out: `real ${args.join(" ")} a b\n` });
    },
  );

  it("passes through every call that is not a headless run, and every call without the env", () => {
    const w = world();
    for (const n of ["codex", "claude"])
      expect(w.run(n, ["--version"])).toEqual({ code: 7, out: "real --version\n" });
    expect(w.run("codex", ["exec"], { CATHERD_SCORECARD_LIMITS: "" }).code).toBe(7);
    expect(w.run("claude", ["-p"], { CATHERD_SCORECARD_LIMITS: "" }).code).toBe(7);
    expect(w.tokens()).toEqual(["1"]);
  });

  it("keeps PATH as it was for the CLI it runs", () => {
    const w = world('echo "$PATH"');
    expect(w.run("codex", ["--version"]).out.startsWith(`${SHIMS}:`)).toBe(true);
  });

  it("says the CLI is missing, with exit 127, when only the shim is on PATH", () => {
    const w = world();
    expect(w.run("codex", ["--version"], {}, `${SHIMS}:/usr/bin:/bin`).code).toBe(127);
  });

  it("is executable", () => {
    for (const n of ["codex", "claude"]) expect(statSync(join(SHIMS, n)).mode & 0o111).not.toBe(0);
  });
});
